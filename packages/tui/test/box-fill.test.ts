import { describe, expect, it } from "bun:test";
import { Box, type Component, Text } from "@oh-my-pi/pi-tui";

const BG_OPEN = "\x1b[48;2;20;20;20m";
const fill = (text: string) => `${BG_OPEN}${text}\x1b[49m`;

const widths = (rows: readonly string[]): number[] => rows.map(r => Bun.stringWidth(Bun.stripANSI(r)));

/** An opencode-shaped card: two columns of left inset, one blank row above and below. */
function card(bgFn?: (text: string) => string, child: Component = new Text("hi", 0, 0)): Box {
	// ignoreTight pins paddingX to exactly 2 regardless of the global tight setting.
	const box = new Box(2, 1, bgFn);
	box.setIgnoreTight(true);
	box.addChild(child);
	return box;
}

/** Emits a line that drops its own styling partway through, as rendered content does. */
class SelfResettingChild implements Component {
	render(): readonly string[] {
		return ["\x1b[31mred\x1b[0m tail"];
	}
}

describe("Box background fill", () => {
	it("paints the paddingY rows, not just the content", () => {
		const rows = card(fill).render(20);
		expect(rows.length).toBe(3);
		expect(widths(rows)).toEqual([20, 20, 20]);
		// The blank rows above and below carry the fill; that contrast is the card's
		// only boundary, so an unpainted padding row would break the card open.
		expect(rows[0]).toStartWith(BG_OPEN);
		expect(rows[2]).toStartWith(BG_OPEN);
		expect(Bun.stripANSI(rows[0]!)).toBe(" ".repeat(20));
		expect(Bun.stripANSI(rows[2]!)).toBe(" ".repeat(20));
	});

	it("extends the content row past its last glyph to the full inner width", () => {
		const rows = card(fill).render(20);
		expect(Bun.stripANSI(rows[1]!)).toBe(`  hi${" ".repeat(16)}`);
		expect(rows[1]).toStartWith(BG_OPEN);
		expect(rows[1]).toEndWith("\x1b[49m");
	});

	it("emits exactly one padded row per paddingY row on each side", () => {
		for (const paddingY of [0, 1, 2]) {
			const box = card(fill);
			box.setPaddingY(paddingY);
			const rows = box.render(20);
			expect(rows.length).toBe(1 + paddingY * 2);
			for (const w of widths(rows)) expect(w).toBe(20);
		}
	});

	it("leaves rows unstyled when no bgFn is set", () => {
		// Existing callers construct Box without a fill and must keep getting plain
		// padded rows: a stray escape would show up in append-mode scrollback.
		const rows = card().render(20);
		expect(rows.length).toBe(3);
		expect(widths(rows)).toEqual([20, 20, 20]);
		for (const row of rows) expect(row).not.toInclude("\x1b");
	});

	it("hands the padded row to bgFn so a re-asserting fill can heal inner resets", () => {
		// Box pads first, then calls bgFn once with the whole row. A fill that
		// re-opens itself after the child's `\x1b[0m` therefore covers the trailing
		// padding too; one that does not leaves the gutter bare. (Box also probes
		// bgFn with a sample string to detect palette changes for its memo.)
		const seen: string[] = [];
		const rows = card(text => {
			if (text !== "test") seen.push(text);
			return fill(text);
		}, new SelfResettingChild()).render(20);
		expect(seen).toEqual([" ".repeat(20), `  \x1b[31mred\x1b[0m tail${" ".repeat(10)}`, " ".repeat(20)]);
		expect(widths(rows)).toEqual([20, 20, 20]);
	});
});
