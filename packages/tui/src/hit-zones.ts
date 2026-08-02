/**
 * Mouse hit zones — the engine-owned map from a screen cell to the component
 * that owns it.
 *
 * ## Why this exists
 *
 * Before this module every clickable component maintained its own
 * `line -> item index` table and every host hand-subtracted its own chrome
 * offsets before forwarding a mouse event (the deleted
 * `select-list-mouse-routing.ts` shim did this for five separate selectors).
 * That works for a modal that owns the whole screen and knows it paints from
 * row 0, but it does not compose: a transcript block nested inside a scrolled
 * viewport inside the root tree has no way to know its own screen row.
 *
 * ## The model
 *
 * Components publish zones in **local** row coordinates (0 = the component's
 * own first rendered row). {@link Container} walks its children during
 * collection and adds each child's row offset, so by the time a zone reaches
 * the engine it carries absolute *frame* coordinates. The engine then subtracts
 * the scroll offset to get screen coordinates at dispatch time.
 *
 * Zones are a flat list, not a `Uint32Array` cell grid (OpenTUI's approach).
 * A cell grid costs `width * height` writes per frame to accelerate a lookup
 * that happens at most a few hundred times a second; omp's transcript publishes
 * roughly one zone per visible block, so a linear scan over a list that is
 * almost always under 100 entries is both faster in aggregate and far simpler.
 * Revisit only if a surface ever publishes thousands of simultaneous zones.
 *
 * Zones are collected in tree order and hit-tested in **reverse**, so a zone
 * published by a descendant (added later) wins over an ancestor's larger zone.
 * That reproduces the intuitive z-order of DOM-style bubbling without needing
 * an explicit z-index.
 */

import type { SgrMouseEvent } from "./mouse";

/** A pointer interaction dispatched to the component owning the target zone. */
export interface ZoneMouseEvent {
	/** The decoded SGR report that produced this dispatch. */
	readonly raw: SgrMouseEvent;
	/** Row within the zone (0 = the zone's first row). */
	readonly localRow: number;
	/** Column within the zone (0 = the zone's first column). */
	readonly localCol: number;
}

/**
 * Mouse cursor shapes a zone can request, named after the CSS cursor keywords
 * that OSC 22 carries (`ESC ] 22 ; <shape> BEL`).
 *
 * Deliberately three: the vocabulary a terminal UI can actually justify is
 * "this activates", "this takes text" and "this is ordinary". Terminals differ
 * in which CSS names they accept, and these three are the universally
 * implemented ones.
 */
export type PointerShape = "default" | "pointer" | "text";

/**
 * Implemented by anything that wants pointer input. Instances are compared by
 * {@link zoneKey}, never by object identity: a component is free to rebuild its
 * zone objects every frame, and hover state still survives because the key is
 * stable.
 */
export interface MouseZoneTarget {
	/**
	 * Stable identity across frames. Two zones with the same key are the same
	 * logical target, so hover does not flicker when a component re-renders.
	 * Must be unique within a frame.
	 */
	readonly zoneKey: string;

	/**
	 * Mouse cursor to request while the pointer is inside this zone.
	 *
	 * A TUI has no other way to say "this is a control": in a GUI the cursor
	 * changing to a hand IS the affordance, and without it every clickable row
	 * has to advertise itself with visible chrome. Terminals that implement
	 * OSC 22 let the app ask; the engine emits it only where it is supported and
	 * falls back to leaving the cursor alone, so this is a progressive
	 * enhancement and never a correctness dependency.
	 *
	 * Omit for zones that are not controls; the engine restores the default.
	 */
	readonly pointerShape?: PointerShape;

	/**
	 * Primary activation. Fired on mouse **up** inside the zone when the press
	 * that started it also landed inside the same zone, and only when no text
	 * selection was made in between — a drag that happens to end on a button
	 * is a selection gesture, not a click.
	 *
	 * Return `true` when the event was consumed.
	 */
	onZoneClick?(event: ZoneMouseEvent): boolean;

	/**
	 * Hover entered or left. Return `true` when the visual state changed and a
	 * repaint is required; returning `false` lets the engine skip a frame.
	 */
	onZoneHover?(hovered: boolean): boolean;

	/**
	 * Wheel over this zone. Return `true` to consume; returning `false` lets the
	 * event bubble to the enclosing scroll region, which is what makes a wheel
	 * over a tool block still scroll the transcript.
	 */
	onZoneWheel?(delta: -1 | 1, event: ZoneMouseEvent): boolean;

	/**
	 * Own a press-drag-release gesture, for a zone that implements its own
	 * selection (the composer placing a caret and selecting text).
	 *
	 * - `start` fires on press inside the zone. Returning `true` CAPTURES the
	 *   pointer for the rest of the gesture, which suppresses the engine's own
	 *   transcript drag-selection and its copy-on-release for the duration.
	 * - `move` fires on every motion while captured, **including coordinates
	 *   outside the zone**. `localRow`/`localCol` stay in the zone's frame and
	 *   may go negative or past the end: a drag that leaves the component must
	 *   be able to extend a selection to the line ends rather than stop dead,
	 *   so the engine deliberately does not clamp.
	 * - `end` fires on release. A gesture that never left the press cell also
	 *   delivers {@link onZoneClick}, so caret placement and drag-select stay
	 *   one code path for the owner.
	 *
	 * Capture is released on `end`, when focus moves, and if the zone stops
	 * being published mid-gesture, so a component unmounting under the pointer
	 * cannot wedge the engine.
	 */
	onZoneDrag?(phase: "start" | "move" | "end", event: ZoneMouseEvent): boolean;
}

/** A published zone in absolute frame coordinates. */
export interface HitZone {
	readonly target: MouseZoneTarget;
	/** First frame row covered. */
	readonly row: number;
	/** Number of rows covered (>= 1). */
	readonly rowCount: number;
	/** First column covered. */
	readonly colStart: number;
	/** One past the last column covered, or `Infinity` for full width. */
	readonly colEnd: number;
}

/**
 * Collector handed to {@link HitZoneProvider.publishHitZones}. Rows passed in
 * are LOCAL to the publishing component; the sink adds the accumulated offset.
 */
export class HitZoneSink {
	#zones: HitZone[] = [];
	#offset = 0;
	#colOffset = 0;

	/** Absolute frame row of the component currently publishing. */
	get offset(): number {
		return this.#offset;
	}

	/**
	 * Constant gutter added to every published column, set once per collection.
	 *
	 * Rows are translated per component as the walk descends, but the horizontal
	 * inset is the same for the whole frame, so it is applied here rather than
	 * threaded through every container. Without it a zone with finite columns
	 * (the composer text area, a footer chip) is hit-tested against raw screen
	 * columns while its rows are already screen rows, and the two disagree by
	 * exactly the gutter.
	 */
	set columnOffset(value: number) {
		this.#colOffset = value;
	}

	/**
	 * Run `fn` with `delta` added to the row offset. Containers use this to
	 * translate a child's local rows into frame rows without the child knowing
	 * anything about its position.
	 */
	withOffset(delta: number, fn: () => void): void {
		const previous = this.#offset;
		this.#offset = previous + delta;
		try {
			fn();
		} finally {
			this.#offset = previous;
		}
	}

	/**
	 * Run `fn` with `delta` added to the column offset, for a container that
	 * indents its children horizontally (the home screen's narrow centred
	 * composer). Nests and restores like {@link withOffset}, and composes with
	 * the frame-wide gutter rather than replacing it.
	 */
	withColumnOffset(delta: number, fn: () => void): void {
		const previous = this.#colOffset;
		this.#colOffset = previous + delta;
		try {
			fn();
		} finally {
			this.#colOffset = previous;
		}
	}

	/**
	 * Publish a zone. `rowStart` is local to the publishing component; columns
	 * are relative to the content area, and the frame's gutter is added here.
	 * A full-width zone leaves `colEnd` infinite and is unaffected.
	 */
	zone(
		target: MouseZoneTarget,
		rowStart: number,
		rowCount = 1,
		colStart = 0,
		colEnd = Number.POSITIVE_INFINITY,
	): void {
		if (rowCount <= 0) return;
		this.#zones.push({
			target,
			row: this.#offset + rowStart,
			rowCount,
			colStart: colStart + this.#colOffset,
			colEnd: Number.isFinite(colEnd) ? colEnd + this.#colOffset : colEnd,
		});
	}

	/** The collected zones, in tree order. */
	get zones(): readonly HitZone[] {
		return this.#zones;
	}

	reset(): void {
		this.#zones = [];
		this.#offset = 0;
		this.#colOffset = 0;
	}
}

/** A component that owns clickable or hoverable regions. */
export interface HitZoneProvider {
	/**
	 * Publish this component's zones. Called once per frame, after `render()`,
	 * only while pointer input is active. Row coordinates are local: row 0 is
	 * the first row this component returned from `render()`.
	 */
	publishHitZones(sink: HitZoneSink): void;
}

export function isHitZoneProvider(value: unknown): value is HitZoneProvider {
	return typeof (value as Partial<HitZoneProvider>)?.publishHitZones === "function";
}

/**
 * Find the zone owning a frame cell. Scans in reverse so the most recently
 * published (deepest) zone wins — see the z-order note in the module header.
 */
export function hitTestZones(zones: readonly HitZone[], row: number, col: number): HitZone | undefined {
	for (let i = zones.length - 1; i >= 0; i--) {
		const zone = zones[i]!;
		if (row < zone.row || row >= zone.row + zone.rowCount) continue;
		if (col < zone.colStart || col >= zone.colEnd) continue;
		return zone;
	}
	return undefined;
}
