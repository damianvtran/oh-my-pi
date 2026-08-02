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
	 */
	constructor(
		readonly zoneKey: string,
		private readonly onToggle: () => void,
	) {}

	/** Expand/collapse is an activation, so the pointer reads as a hand. */
	readonly pointerShape = "pointer" as const;

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

	/** Whether a render has ever reported hidden content, ignoring the viewport. */
	get everOverflowed(): boolean {
		return this.#everOverflowed;
	}

	/** Record a render that omitted content. */
	noteOverflow(overflow: boolean): void {
		if (overflow) this.#everOverflowed = true;
	}

	onZoneClick(): boolean {
		this.onToggle();
		return true;
	}

	onZoneHover(hovered: boolean): boolean {
		if (this.#hovered === hovered) return false;
		this.#hovered = hovered;
		return this.interactive;
	}

	/** Publish the header zone at a row local to the owning component. */
	publish(sink: HitZoneSink, rowStart: number, rowCount = 1): void {
		if (!this.interactive || rowStart < 0 || rowCount <= 0) return;
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
