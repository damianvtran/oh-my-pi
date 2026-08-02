/**
 * The selection layer's content band.
 *
 * A transcript row reaching this layer is already painted: a card's two-column
 * inset, its background fill and a user card's accent rail are just cells, and
 * a rectangular cut over them is what used to put `  ▎ ` on the clipboard and
 * paint a full-width wash across a card's padding.
 *
 * The two edges are found differently, so they are tested differently: the
 * LEFT edge is row-local chrome metadata published by the component, and the
 * RIGHT edge is recovered from where each row's text actually stops.
 */
import { describe, expect, it } from "bun:test";
import { bandForLine, extractSelectionText, highlightLineSpan, Selection, textEndColumn } from "../src/selection";
import { encodeTextSized } from "../src/utils";

const WIDTH = 20;
/** A card row: two columns of inset, the text, then fill out to the width. */
const CARD_ROW = "  hello".padEnd(WIDTH, " ");
/** A user card row, whose rail glyph is a literal character in column 0. */
const RAIL_ROW = "▎ hello".padEnd(WIDTH, " ");

function select(anchor: [number, number], head: [number, number]): Selection {
	const selection = new Selection();
	selection.begin({ row: anchor[0], col: anchor[1] });
	selection.extend({ row: head[0], col: head[1] });
	return selection;
}

describe("textEndColumn", () => {
	it("ignores the fill a card paints past its text", () => {
		expect(textEndColumn(CARD_ROW)).toBe(7);
	});

	it("measures cells, not bytes, so a wide glyph counts twice", () => {
		expect(textEndColumn("  日本")).toBe(6);
	});

	it("does not count SGR runs as content", () => {
		expect(textEndColumn(`\x1b[48;5;236m${CARD_ROW}\x1b[0m`)).toBe(7);
	});

	it("counts the visible cells in a scaled OSC 66 span", () => {
		expect(textEndColumn(encodeTextSized("Hi", { scale: 2 }))).toBe(4);
	});

	it("reports zero for a row that is only fill", () => {
		expect(textEndColumn(" ".repeat(WIDTH))).toBe(0);
	});
});

describe("bandForLine", () => {
	it("starts at the inset and stops at the text", () => {
		expect(bandForLine(CARD_ROW, WIDTH, 2)).toEqual({ start: 2, end: 7 });
	});

	it("collapses a row holding nothing but chrome", () => {
		expect(bandForLine("  ".padEnd(WIDTH, " "), WIDTH, 2)).toBeNull();
	});

	it("collapses a row whose only content is inside the inset", () => {
		// The accent rail lives in column 0. A row carrying just the rail is a
		// card's blank padding row and holds no text to select.
		expect(bandForLine("▎".padEnd(WIDTH, " "), WIDTH, 2)).toBeNull();
	});

	it("selects geometrically when no inset is declared", () => {
		expect(bandForLine(CARD_ROW, WIDTH, 0)).toEqual({ start: 0, end: 7 });
	});

	it("keeps a final content cell when a narrow box drops its right padding", () => {
		expect(bandForLine("  x", 3, 2)).toEqual({ start: 2, end: 3 });
	});
});

describe("spanForRow", () => {
	it("clips a drag that starts left of the text", () => {
		const selection = select([0, 0], [0, WIDTH - 1]);
		expect(selection.spanForRow(0, WIDTH, CARD_ROW, 2)).toEqual({ start: 2, end: 7 });
	});

	it("keeps a drag that starts inside the text where the user put it", () => {
		const selection = select([0, 4], [0, WIDTH - 1]);
		expect(selection.spanForRow(0, WIDTH, CARD_ROW, 2)).toEqual({ start: 4, end: 7 });
	});

	it("reports nothing for a blank row inside a multi-row drag", () => {
		const selection = select([0, 0], [2, WIDTH - 1]);
		expect(selection.spanForRow(1, WIDTH, " ".repeat(WIDTH), 2)).toBeNull();
	});

	it("is unbounded without a row, which is what a chromeless surface wants", () => {
		const selection = select([0, 0], [0, WIDTH - 1]);
		expect(selection.spanForRow(0, WIDTH)).toEqual({ start: 0, end: WIDTH });
	});
});

describe("highlightLineSpan", () => {
	it("washes only the span it is given", () => {
		const washed = highlightLineSpan(CARD_ROW, 2, 7, WIDTH);
		const start = washed.indexOf("\x1b[7m");
		const end = washed.indexOf("\x1b[27m");
		expect(start).toBeGreaterThanOrEqual(0);
		expect(washed.slice(start + 4, end)).toBe("hello");
	});

	it("leaves the card padding outside the wash", () => {
		const washed = highlightLineSpan(CARD_ROW, 2, 7, WIDTH);
		// Everything before the reverse sequence is the untouched inset, and
		// everything after it is untouched fill. A full-width band would put
		// both inside.
		const start = washed.indexOf("\x1b[7m");
		expect(Bun.stripANSI(washed.slice(0, start))).toBe("  ");
		expect(Bun.stripANSI(washed.slice(washed.indexOf("\x1b[27m")))).toBe(" ".repeat(WIDTH - 7));
	});
});

describe("extractSelectionText", () => {
	const range = { start: { row: 0, col: 0 }, end: { row: 0, col: WIDTH - 1 } };

	it("drops the card inset a rectangular cut would take", () => {
		expect(extractSelectionText([CARD_ROW], range, WIDTH, 2)).toBe("hello");
	});

	it("drops the accent rail, which survives ANSI stripping", () => {
		expect(extractSelectionText([RAIL_ROW], range, WIDTH, 2)).toBe("hello");
	});

	it("keeps indentation that belongs to the content", () => {
		// Four columns in: two of card inset, two the author wrote. Only the
		// card's own two may be removed, or copied code loses its shape.
		const indented = "    if (x) {".padEnd(WIDTH, " ");
		expect(extractSelectionText([indented], range, WIDTH, 2)).toBe("  if (x) {");
	});

	it("keeps a blank line between two paragraphs", () => {
		const rows = [CARD_ROW, " ".repeat(WIDTH), RAIL_ROW];
		const multi = { start: { row: 0, col: 0 }, end: { row: 2, col: WIDTH - 1 } };
		expect(extractSelectionText(rows, multi, WIDTH, 2)).toBe("hello\n\nhello");
	});

	it("copies the whole row when no inset is declared", () => {
		expect(extractSelectionText([CARD_ROW], range, WIDTH, 0)).toBe("  hello");
	});

	it("resolves the inset independently for heterogeneous rows", () => {
		const rows = [CARD_ROW, "assistant".padEnd(WIDTH, " ")];
		const multi = { start: { row: 0, col: 0 }, end: { row: 1, col: WIDTH - 1 } };
		expect(extractSelectionText(rows, multi, WIDTH, row => (row === 0 ? 2 : 0))).toBe("hello\nassistant");
	});

	it("keeps the visible payload of a complete OSC 66 span", () => {
		const heading = encodeTextSized("Hi", { scale: 2 });
		const scaledRange = { start: { row: 0, col: 0 }, end: { row: 0, col: 3 } };
		expect(extractSelectionText([heading], scaledRange, 4)).toBe("Hi");
	});
});
