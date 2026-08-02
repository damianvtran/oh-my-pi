/**
 * SGR mouse report parsing (`\x1b[<button;col;rowM` / `…m`).
 *
 * Mouse tracking is enabled only while a fullscreen overlay holds the
 * alternate screen (see tui.ts MOUSE_TRACKING_ON), so consumers are
 * fullscreen components hit-testing against their own rendered frame:
 * the frame paints from screen row 0, hence `row`/`col` are exposed
 * 0-based for direct indexing into rendered lines.
 */

/** A decoded SGR mouse report. */
export interface SgrMouseEvent {
	/** Raw button code (bit 32 = motion, bit 64 = wheel, low bits = button). */
	button: number;
	/** 0-based column of the event. */
	col: number;
	/** 0-based row of the event. */
	row: number;
	/** True for a release report (`m` suffix). */
	release: boolean;
	/**
	 * Vertical wheel direction: -1 up, 1 down, null when the report is not a
	 * vertical wheel notch.
	 *
	 * Horizontal notches are deliberately NOT folded in here. SGR encodes the
	 * wheel axis in the low bits — 64/65 vertical, 66/67 horizontal — and a
	 * `button & 1` test cannot tell 65 (down) from 67 (right). A trackpad swipe
	 * is never purely vertical, so the terminal interleaves horizontal notches
	 * through every gesture; read as vertical they invert the scroll direction
	 * mid-swipe and the transcript oscillates against the reader's finger.
	 */
	wheel: -1 | 1 | null;
	/** Horizontal wheel direction: -1 left, 1 right, null when not one. */
	wheelX: -1 | 1 | null;
	/** True when the pointer moved (hover or drag) rather than clicked. */
	motion: boolean;
	/**
	 * Modifier held when the report was generated.
	 *
	 * SGR packs these into the same button byte as the button itself (4 shift,
	 * 8 alt/meta, 16 ctrl), so a modified left click is still a left click and
	 * reaches every ordinary click path unchanged. They are decoded here rather
	 * than left to callers picking bits out of `button`, so that intent (alt as
	 * "copy this, do not activate it") is expressed once.
	 *
	 * `shift` is decoded for completeness but is close to unusable as an app
	 * gesture: terminals conventionally reserve shift+drag to bypass mouse
	 * reporting and make their OWN selection, so the report never arrives.
	 * There is no super/cmd bit in SGR at all — the protocol cannot carry it.
	 */
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** True for a left-button press (not motion, not release, not wheel). */
	leftClick: boolean;
}

/**
 * Decode an SGR mouse report, or return null when `data` is not one.
 * Callers on hot keypress paths should pre-check `data.startsWith("\x1b[<")`
 * before paying for the regex.
 */
export function parseSgrMouse(data: string): SgrMouseEvent | null {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return null;
	const button = Number(match[1]);
	const col = Number(match[2]) - 1;
	const row = Number(match[3]) - 1;
	const release = match[4] === "m";
	// Bit 64 marks a wheel report; bit 1 then selects the axis (0 vertical,
	// 1 horizontal) and bit 0 the direction within it.
	const isWheel = (button & 64) !== 0;
	const horizontal = isWheel && (button & 2) !== 0;
	const towardEnd = (button & 1) !== 0;
	const wheel = isWheel && !horizontal ? ((towardEnd ? 1 : -1) as 1 | -1) : null;
	const wheelX = horizontal ? ((towardEnd ? 1 : -1) as 1 | -1) : null;
	const motion = (button & 32) !== 0 && !isWheel;
	const leftClick = !release && !isWheel && !motion && (button & 3) === 0;
	return {
		button,
		col,
		row,
		release,
		wheel,
		wheelX,
		motion,
		shift: (button & 4) !== 0,
		alt: (button & 8) !== 0,
		ctrl: (button & 16) !== 0,
		leftClick,
	};
}

/** Handler invoked with a decoded SGR event; returning `false` reports unhandled. */
export type SgrMouseHandler = (event: SgrMouseEvent) => boolean | undefined;

/**
 * Decode an SGR mouse report and forward it to `handler`. Returns `false` when
 * `data` is not an SGR mouse report (or fails to parse), so callers can fall
 * through to other input handling. Centralizes the repeated
 * `data.startsWith("\x1b[<")` + `parseSgrMouse()` pattern.
 */
export function routeSgrMouseInput(data: string, handler: SgrMouseHandler): boolean {
	if (!data.startsWith("\x1b[<")) return false;
	const event = parseSgrMouse(data);
	if (!event) return false;
	return handler(event) !== false;
}

/**
 * Structural view of a SelectList-like target for mouse routing. Declared here
 * (rather than importing the component) to keep this core module free of any
 * component-to-core import cycle.
 */
export interface SelectListMouseTarget {
	handleWheel(delta: -1 | 1): void;
	hitTest(line: number): number | undefined;
	setHoverIndex(index: number | null): void;
	clickItem(index: number): void;
}

/**
 * Route a decoded mouse event against a SelectList-like target at the given
 * 0-based frame-local `line`. Centralizes the repeated wheel/hit-test/hover/
 * click pattern. Returns `true` when the event was consumed.
 */
export function routeSelectListMouse(target: SelectListMouseTarget, event: SgrMouseEvent, line: number): boolean {
	if (event.wheel !== null) {
		target.handleWheel(event.wheel);
		return true;
	}
	const index = target.hitTest(line);
	if (event.motion) {
		target.setHoverIndex(index ?? null);
		return true;
	}
	if (event.leftClick && index !== undefined) {
		target.clickItem(index);
		return true;
	}
	return false;
}

/**
 * Implemented by components that accept routed mouse events at frame-local
 * coordinates. Hosts translate screen coordinates to the component's own
 * rendered lines before forwarding.
 */
export interface MouseRoutable {
	/**
	 * `line`/`col` are 0-based within the component's rendered output.
	 *
	 * Return `false` to decline the report; anything else (including
	 * `undefined`) consumes it. What declining buys you is the host's business,
	 * and hosts differ: the engine's overlay router routes no pointer input at
	 * all while an overlay is up, so a report it declines is not re-routed —
	 * it reaches only the focused component's own `handleInput`, and a
	 * declining overlay must ignore `\x1b[<` there itself. Every other host
	 * (`routeSelectListMouse`, `SettingsList`, the setup wizard, the model hub)
	 * discards the return value, so declining there does nothing at all.
	 */
	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean | undefined | void;
}
