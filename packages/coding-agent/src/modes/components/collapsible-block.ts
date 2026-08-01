/**
 * Shared click target for a collapsible transcript block.
 *
 * Every collapsible block behaves the same under the pointer: one hit zone
 * over its header row, a hover wash on that row, and a disclosure marker in
 * its gutter. What differs is where the header row sits, which only the block
 * itself can know, and whether the collapsed form is hiding anything, which
 * only the block can measure. Those two stay with the block; everything else
 * lives here so five components do not each grow their own copy.
 */

import type { HitZoneSink, MouseZoneTarget } from "@oh-my-pi/pi-tui";
import { decorateBlockHeader, isFullscreenViewport } from "../../tools/render-utils";
import { theme } from "../theme/theme";

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
	 */
	decorate(row: string, expanded: boolean): string {
		if (!this.interactive) return row;
		return decorateBlockHeader(row, { expanded, hovered: this.#hovered }, theme);
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

	paint(lines: readonly string[], row: number, header: CollapsibleBlockHeader, expanded: boolean): readonly string[] {
		if (!header.interactive || row < 0 || row >= lines.length) return lines;
		if (this.#source === lines && this.#hovered === header.hovered && this.#expanded === expanded) {
			return this.#painted!;
		}
		const painted = lines.slice();
		painted[row] = header.decorate(painted[row]!, expanded);
		this.#source = lines;
		this.#painted = painted;
		this.#hovered = header.hovered;
		this.#expanded = expanded;
		return painted;
	}
}
