/**
 * Shared click target and card surface for a collapsible transcript block.
 *
 * Every collapsible block behaves the same under the pointer: one hit zone
 * over its header row, a disclosure marker in its gutter, and in the
 * fullscreen viewport a filled card that lights up while hovered. What differs
 * is where the header row sits, which only the block itself can know, and
 * whether the collapsed form is hiding anything, which only the block can
 * measure. Those two stay with the block; everything else lives here so five
 * components do not each grow their own copy.
 */

import { Box, type Component, type HitZoneSink, type MouseZoneTarget } from "@oh-my-pi/pi-tui";
import { decorateBlockHeader, isFullscreenViewport } from "../../tools/render-utils";
import { theme } from "../theme/theme";

/**
 * Columns a card insets its content by, and filled rows it draws above and
 * below it. Matches opencode's transcript block: two columns in, one blank
 * filled row top and bottom, with the canvas row the transcript already
 * inserts between blocks doing the separating.
 */
export const CARD_PADDING_X = 2;
export const CARD_PADDING_Y = 1;

const PANEL_FILL = (text: string): string => theme.panelBg(text);
const RAISED_FILL = (text: string): string => theme.elementBg(text);

/** A block whose card is empty keeps this identity so Box's memo stays warm. */
const NO_ROWS: readonly string[] = [];

/**
 * A block's own source text, for the pointer gesture that copies it.
 *
 * Returning the SOURCE and not the painted rows is the whole point: a rendered
 * card has been wrapped to the viewport, indented by {@link CARD_PADDING_X},
 * and often truncated behind a "+12 lines" marker. Copying that gives you the
 * layout. Drag-selection already covers "exactly these glyphs"; this covers
 * "that message", which is the one a reader actually wants to paste.
 *
 * Undefined means the block has nothing worth copying and declines the
 * gesture, which then falls through to an ordinary click.
 */
export type BlockCopySource = () => string | undefined;

/**
 * Zone target for a block that can be copied but has nothing to activate:
 * a user message, a plain assistant reply.
 *
 * Collapsible blocks do not need this — {@link CollapsibleBlockHeader} already
 * owns their rows, and a zone dispatch resolves to exactly one target, so a
 * second copy zone underneath would simply never be reached.
 */
export class BlockCopyTarget implements MouseZoneTarget {
	readonly doubleClickCopies = true;

	constructor(
		readonly zoneKey: string,
		private readonly source: BlockCopySource,
	) {}

	/** Text, because the card is prose: there is nothing here to activate. */
	readonly pointerShape = "text" as const;

	onZoneCopy(): string | undefined {
		return this.source();
	}

	/** Publish over the block's own rows, local to the owning component. */
	publish(sink: HitZoneSink, rowStart: number, rowCount: number): void {
		if (!isFullscreenViewport() || rowStart < 0 || rowCount <= 0) return;
		sink.zone(this, rowStart, rowCount);
	}
}

export class CollapsibleBlockHeader implements MouseZoneTarget {
	#hovered = false;
	// Latched, because a block that has been expanded no longer hides anything
	// and so stops reporting overflow — but it must stay clickable to collapse
	// again. Content only ever grows, so the latch never goes stale.
	#everOverflowed = false;

	/**
	 * @param zoneKey Stable across frames and unique within one. Blocks derive
	 *   it from their own instance identity, never from a transcript position:
	 *   a positional key would hand a block its neighbour's hover state as soon
	 *   as anything above it was removed.
	 * @param onToggle Flips the block's expansion and rebuilds its display.
	 * @param copySource Optional source text for a copy gesture. Supplying it
	 *   also makes the block publish a zone when it has nothing to expand, so
	 *   an unremarkable one-line tool card is still copyable.
	 */
	constructor(
		readonly zoneKey: string,
		private readonly onToggle: () => void,
		private readonly copySource?: BlockCopySource,
	) {}

	/**
	 * Expand/collapse is an activation, so an expandable block reads as a hand.
	 * One that is only copyable is prose, and reads as text.
	 */
	get pointerShape(): "pointer" | "text" {
		return this.interactive ? "pointer" : "text";
	}

	/**
	 * Whether the block is worth pointing at. A block whose collapsed form
	 * already shows everything has nothing to reveal, so it publishes no zone,
	 * takes no hover, and draws no marker. Append mode has no pointer at all
	 * and must render byte-identically to before hit zones existed, so the
	 * marker stays off there too.
	 */
	get interactive(): boolean {
		return this.#everOverflowed && isFullscreenViewport();
	}

	get hovered(): boolean {
		return this.interactive && this.#hovered;
	}

	onZoneClick(): boolean {
		// A block that hides nothing publishes a zone only to be copyable, so a
		// plain click on it must do nothing rather than toggle it invisibly.
		if (!this.interactive) return false;
		this.onToggle();
		return true;
	}

	onZoneCopy(): string | undefined {
		return this.copySource?.();
	}

	/** Whether a render has ever reported hidden content, ignoring the viewport. */
	get everOverflowed(): boolean {
		return this.#everOverflowed;
	}

	/** Record a render that omitted content. */
	noteOverflow(overflow: boolean): void {
		if (overflow) this.#everOverflowed = true;
	}

	onZoneHover(hovered: boolean): boolean {
		if (this.#hovered === hovered) return false;
		this.#hovered = hovered;
		return this.interactive;
	}

	/**
	 * Publish the block's zone at a row local to the owning component.
	 *
	 * A block with nothing to expand still publishes when it can be copied:
	 * the zone is how the copy gesture finds the block at all, and a card that
	 * happens to fit on screen is no less worth copying than one that does not.
	 */
	publish(sink: HitZoneSink, rowStart: number, rowCount = 1): void {
		if (!this.interactive && this.copySource === undefined) return;
		if (!isFullscreenViewport() || rowStart < 0 || rowCount <= 0) return;
		sink.zone(this, rowStart, rowCount);
	}

	/**
	 * Repaint one already-rendered row as this block's header. Returns the row
	 * unchanged when the block is not interactive, so a block that hides
	 * nothing stays visually inert.
	 *
	 * `cardFilled` says the block already painted the hover state across its
	 * whole card, which is what the pointer is meant to light up; washing the
	 * header again would nest a second background inside the first and the
	 * inner reset would punch a hole in the rest of the row.
	 */
	decorate(row: string, expanded: boolean, cardFilled = false): string {
		if (!this.interactive) return row;
		return decorateBlockHeader(row, { expanded, hovered: this.#hovered, wash: !cardFilled }, theme);
	}
}

/**
 * Filled card surface a transcript block paints around its own rendered rows.
 *
 * Boundaries in the fullscreen transcript are fills, never rules, so a block
 * is a background plus two columns of inset plus a filled row above and below;
 * the transcript container already puts one bare canvas row between blocks,
 * which completes the separation. Hover repaints the whole card rather than
 * its header row alone, so pointing at a block lights the block up.
 *
 * Append mode has no fill to draw with and must stay byte-identical, so every
 * method there is a passthrough.
 *
 * `Box` supplies the padding, the per-row width pad and the background, so the
 * card holds pre-composed rows in a passthrough child rather than assembling
 * rows itself.
 */
export class BlockCard {
	#rows: readonly string[] = NO_ROWS;
	#filled: boolean | undefined;
	readonly #box = new Box(CARD_PADDING_X, CARD_PADDING_Y);

	constructor() {
		// Tool cards keep their inset when the user enables tight layout: the
		// inset is the card, not decoration.
		this.#box.setIgnoreTight(true);
		const passthrough: Component = { render: () => this.#rows, invalidate: () => {} };
		this.#box.addChild(passthrough);
	}

	/** Whether the card draws anything at all in the current viewport. */
	get active(): boolean {
		return isFullscreenViewport();
	}

	/** Rows the card draws above its content, which shift a block's hit zones. */
	get topRows(): number {
		return this.active ? CARD_PADDING_Y : 0;
	}

	/** Width left for the block's own rows once the card takes its inset. */
	contentWidth(width: number): number {
		return this.active ? Math.max(1, width - CARD_PADDING_X * 2) : width;
	}

	paint(rows: readonly string[], width: number, hovered: boolean): readonly string[] {
		if (!this.active) return rows;
		// `setBgFn` drops Box's memo, so only touch it when the fill actually
		// changes; otherwise resting the pointer anywhere would re-derive every
		// card in the transcript on every frame.
		if (this.#filled !== hovered) {
			this.#filled = hovered;
			this.#box.setBgFn(hovered ? RAISED_FILL : PANEL_FILL);
		}
		this.#rows = rows;
		return this.#box.render(width);
	}

	/**
	 * Publish the card's row-local selection geometry without creating a
	 * pointer target. Real controls remain the only zones eligible for dispatch.
	 */
	publishSelectionInset(sink: HitZoneSink, rowCount: number): void {
		if (!this.active || rowCount <= 0) return;
		sink.selectionInset(0, rowCount, CARD_PADDING_X);
	}

	/**
	 * Publish geometry owned by content rendered inside this card.
	 *
	 * Row and column offsets must move together: the Box paints one top row and
	 * two left chrome cells before its children, while pointer zones themselves
	 * intentionally continue to own the card's full width.
	 */
	publishContentGeometry(sink: HitZoneSink, publish: () => void): void {
		if (!this.active) {
			publish();
			return;
		}
		sink.withOffset(this.topRows, () => {
			sink.withSelectionInset(CARD_PADDING_X, publish);
		});
	}

	invalidate(): void {
		this.#box.invalidate();
	}
}

/**
 * Replace one row of an already-rendered block with its decorated header,
 * reusing the previous result while neither the source rows nor the hover
 * state changed. Callers return the array straight to their parent
 * `Container`, which memoizes on array identity: allocating a fresh copy every
 * frame would defeat that memo for as long as the pointer rested on a block.
 */
export class HeaderRowPainter {
	#source: readonly string[] | undefined;
	#painted: readonly string[] | undefined;
	#hovered = false;
	#expanded = false;

	paint(
		lines: readonly string[],
		row: number,
		header: CollapsibleBlockHeader,
		expanded: boolean,
		cardFilled = false,
	): readonly string[] {
		if (!header.interactive || row < 0 || row >= lines.length) return lines;
		if (this.#source === lines && this.#hovered === header.hovered && this.#expanded === expanded) {
			return this.#painted!;
		}
		const painted = lines.slice();
		painted[row] = header.decorate(painted[row]!, expanded, cardFilled);
		this.#source = lines;
		this.#painted = painted;
		this.#hovered = header.hovered;
		this.#expanded = expanded;
		return painted;
	}
}
