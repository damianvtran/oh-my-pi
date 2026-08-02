/**
 * Drag-to-select and copy for the full-screen viewport.
 *
 * ## Why the app has to implement this at all
 *
 * Enabling SGR mouse reporting (`?1000h`/`?1003h`/`?1006h`) takes the pointer
 * away from the terminal emulator: the terminal stops drawing its own selection
 * and stops putting anything on the clipboard, because it is now forwarding
 * every button press to us. That is not a quirk of one emulator, it is what
 * mouse reporting *means*. So the moment the transcript becomes clickable, the
 * app owes the user a selection implementation — otherwise clicking gains a
 * feature and loses a more important one.
 *
 * opencode reached the same conclusion and made copy-on-release the default
 * (`packages/tui/src/app.tsx:1101-1105`); this is the same behaviour.
 *
 * ## Coordinates
 *
 * Anchor and head are **frame** coordinates (row index into the composed frame,
 * visual column), not screen coordinates, so a selection survives scrolling and
 * stays attached to the text it was drawn over rather than to a screen row.
 *
 * ## Rendering
 *
 * Highlighting is SGR reverse video (`\x1b[7m` … `\x1b[27m`) rather than an
 * explicit background colour. Reverse composes with whatever colours the row
 * already carries, so selected text stays legible over every theme, over diff
 * highlighting, and over syntax-highlighted code without the selection layer
 * needing to know any of their colours.
 */

import { extractSegments, sliceWithWidth, visibleWidth } from "./utils";

const SGR_REVERSE = "\x1b[7m";
const SGR_REVERSE_OFF = "\x1b[27m";
const SEGMENT_RESET = "\x1b[0m";

/**
 * Columns of a composed row that hold content rather than surface chrome.
 *
 * The transcript is painted, not laid out: by the time a row reaches the
 * selection layer it is a string of cells in which padding, fill and an accent
 * rail are indistinguishable from text.
 *
 * The two edges are found differently on purpose:
 *
 * - The LEFT edge comes from row-local metadata published by the component.
 *   Leading spaces are meaningful inside a card (indented code, nested list
 *   items) and chrome outside it, so recovering the boundary from glyphs would
 *   corrupt one of those cases. Different rows may declare different insets.
 * - The RIGHT edge is recovered from the row because trailing fill is
 *   unambiguously not content.
 *
 * This matches the composer, whose selection is bounded by the length of each
 * line rather than the width of the terminal.
 */
export interface TextBand {
	/** First content column. */
	readonly start: number;
	/** One past the last content column. */
	readonly end: number;
}

/**
 * Matches CSI/OSC/simple escape sequences. Used only to recover plain text for
 * the clipboard — never on a rendering path, where the width model in
 * `utils.ts` is authoritative.
 */
const ANSI_PATTERN =
	/[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

/**
 * Column after the last non-blank cell of a rendered row.
 *
 * Measured on the stripped text so SGR runs (a card's background fill covers
 * the whole row) do not count as content.
 */
export function textEndColumn(line: string): number {
	const stripped = line.replace(ANSI_PATTERN, "");
	const trimmed = stripped.replace(/\s+$/, "");
	return trimmed.length === 0 ? 0 : visibleWidth(trimmed);
}

/**
 * Content columns of `line` given the frame-wide `inset`, or null when the row
 * holds no content at all (a blank spacer, a card's own padding row).
 */
export function bandForLine(line: string | undefined, width: number, inset: number): TextBand | null {
	if (line === undefined) return null;
	const start = Math.max(0, Math.min(inset, width));
	// The row itself is authoritative on the right: trailing card fill is spaces
	// and disappears from textEndColumn(). Subtracting the left inset from width
	// incorrectly erases a real final cell when a narrow Box drops its right pad.
	const end = Math.min(width, textEndColumn(line));
	return end > start ? { start, end } : null;
}

/** A point in the composed frame. */
export interface SelectionPoint {
	row: number;
	col: number;
}

/** A normalized, non-empty selection span. */
export interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

/**
 * Mutable selection state. Owned by the TUI, driven by the mouse router.
 *
 * A selection only becomes *active* once the pointer has actually moved off the
 * press cell. A plain click therefore leaves `isActive` false, which is what
 * lets click handlers run — the "did the user select something?" guard that
 * every clickable element checks is exactly this flag.
 */
export class Selection {
	#anchor: SelectionPoint | null = null;
	#head: SelectionPoint | null = null;
	#dragging = false;
	#moved = false;

	/** True once a drag has covered more than the press cell. */
	get isActive(): boolean {
		return this.#moved && this.#anchor !== null && this.#head !== null;
	}

	get isDragging(): boolean {
		return this.#dragging;
	}

	/** Begin a potential selection at a press. Does not activate until movement. */
	begin(point: SelectionPoint): void {
		this.#anchor = { ...point };
		this.#head = { ...point };
		this.#dragging = true;
		this.#moved = false;
	}

	/**
	 * Extend to `point`. Returns true when the visible selection changed, so the
	 * caller can skip a repaint for a drag that stayed inside one cell.
	 */
	extend(point: SelectionPoint): boolean {
		if (!this.#dragging || !this.#anchor) return false;
		const head = this.#head;
		if (head && head.row === point.row && head.col === point.col) return false;
		this.#head = { ...point };
		if (!this.#moved && (point.row !== this.#anchor.row || point.col !== this.#anchor.col)) {
			this.#moved = true;
		}
		return true;
	}

	/** End the drag, keeping the selection so it stays highlighted after release. */
	end(): void {
		this.#dragging = false;
	}

	/** Drop the selection entirely. Returns true when something was cleared. */
	clear(): boolean {
		const had = this.#anchor !== null || this.#head !== null;
		this.#anchor = null;
		this.#head = null;
		this.#dragging = false;
		this.#moved = false;
		return had;
	}

	/** The normalized span, or null when nothing is selected. */
	get range(): SelectionRange | null {
		if (!this.isActive) return null;
		const a = this.#anchor!;
		const b = this.#head!;
		const forward = a.row < b.row || (a.row === b.row && a.col <= b.col);
		return forward ? { start: { ...a }, end: { ...b } } : { start: { ...b }, end: { ...a } };
	}

	/**
	 * Shift the selection by `delta` rows. Called when rows are trimmed off the
	 * top of a bounded transcript so the highlight stays on the same text.
	 */
	shiftRows(delta: number): void {
		if (delta === 0) return;
		if (this.#anchor) this.#anchor.row += delta;
		if (this.#head) this.#head.row += delta;
	}

	/**
	 * Column span selected on `row`, or null when the row holds no selected
	 * content. `width` bounds the final row of a multi-row selection so a
	 * trailing partial row does not claim the whole terminal width.
	 *
	 * `line` and `inset` narrow the span to the row's own content
	 * ({@link bandForLine}), so a drag across a card highlights the text rather
	 * than a full-width band over its padding and trailing fill. Pass
	 * `undefined` for `line` to select geometrically, which is what a surface
	 * with no chrome wants.
	 */
	spanForRow(row: number, width: number, line?: string, inset = 0): { start: number; end: number } | null {
		const range = this.range;
		if (!range) return null;
		if (row < range.start.row || row > range.end.row) return null;
		const start = row === range.start.row ? range.start.col : 0;
		// The head cell is included, matching how terminals select: dragging onto
		// a character selects it rather than stopping just before it.
		const end = row === range.end.row ? Math.min(width, range.end.col + 1) : width;
		return clampToBand(start, end, line, width, inset);
	}
}

/**
 * Intersect a geometric span with the row's content band.
 *
 * Rows outside the band entirely (a blank line inside a multi-row drag, a
 * card's padding row) collapse to null rather than to a zero-width span, so
 * callers can tell "nothing here" from "an empty string here".
 */
function clampToBand(
	start: number,
	end: number,
	line: string | undefined,
	width: number,
	inset: number,
): { start: number; end: number } | null {
	if (end <= start) return null;
	if (line === undefined) return { start, end };
	const band = bandForLine(line, width, inset);
	if (!band) return null;
	const clamped = { start: Math.max(start, band.start), end: Math.min(end, band.end) };
	return clamped.end > clamped.start ? clamped : null;
}

/**
 * Apply reverse video to `[start, end)` of an already-rendered ANSI row.
 *
 * Uses the same three-way split as overlay compositing (`extractSegments`), so
 * the width model stays consistent with everything else that slices rows: the
 * prefix and suffix keep their own SGR state and only the middle span gains the
 * reverse attribute.
 */
export function highlightLineSpan(line: string, start: number, end: number, width: number): string {
	if (end <= start) return line;
	const clampedStart = Math.max(0, start);
	const clampedEnd = Math.min(width, end);
	if (clampedEnd <= clampedStart) return line;

	const spanWidth = clampedEnd - clampedStart;
	const segments = extractSegments(line, clampedStart, clampedEnd, width - clampedEnd, true);

	// The span reaching here is already bounded by the row's own content, so a
	// short row ends its highlight where the text ends rather than washing the
	// card padding beyond it. The padding below therefore only ever covers a
	// wide grapheme straddling the final cell.
	const middle = sliceWithWidth(line, clampedStart, spanWidth, true);
	const middlePad = " ".repeat(Math.max(0, spanWidth - middle.width));
	const beforePad = " ".repeat(Math.max(0, clampedStart - segments.beforeWidth));

	return (
		segments.before +
		beforePad +
		SEGMENT_RESET +
		SGR_REVERSE +
		middle.text +
		middlePad +
		SGR_REVERSE_OFF +
		SEGMENT_RESET +
		segments.after
	);
}

/** A fixed inset or row-aware resolver for heterogeneous transcript surfaces. */
export type TextInset = number | ((row: number, line: string) => number);

function resolveTextInset(inset: TextInset, row: number, line: string): number {
	return typeof inset === "function" ? inset(row, line) : inset;
}

/**
 * Recover the plain text a selection covers, for the clipboard.
 *
 * Every row is narrowed to its own content band first, so the card padding and
 * the accent rail a rectangular cut would otherwise sweep up never reach the
 * clipboard. Rows that hold no content inside the selection become empty
 * lines, preserving the blank line between two paragraphs.
 */
export function extractSelectionText(
	frame: readonly string[],
	range: SelectionRange,
	width: number,
	inset: TextInset = 0,
): string {
	const rows: string[] = [];
	for (let row = range.start.row; row <= range.end.row; row++) {
		const line = frame[row];
		if (line === undefined) continue;
		const start = row === range.start.row ? range.start.col : 0;
		const end = row === range.end.row ? Math.min(width, range.end.col + 1) : width;
		const span = clampToBand(start, end, line, width, resolveTextInset(inset, row, line));
		if (!span) {
			rows.push("");
			continue;
		}
		const slice = sliceWithWidth(line, span.start, span.end - span.start, true);
		rows.push(slice.text.replace(ANSI_PATTERN, "").replace(/\s+$/, ""));
	}
	// A single-row selection is an inline fragment; a multi-row one is lines.
	return rows.join("\n");
}
