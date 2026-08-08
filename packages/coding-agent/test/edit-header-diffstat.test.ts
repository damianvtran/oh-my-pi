import { beforeEach, describe, expect, it } from "bun:test";
import { editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { measureBlockRender } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

/**
 * An edit's `+N/-N` has to survive collapsing.
 *
 * The collapsed card is not a truncation of the expanded one: it is a single
 * row taken from whatever the renderer recorded as its identity line while it
 * drew. That recording happens inside `renderStatusLine` and is first-wins, so
 * a suffix concatenated onto the returned header appeared on the expanded card
 * and silently vanished from the collapsed one. Asserting both is the only
 * thing that tells the fix apart from the bug.
 */
// No `---`/`+++` preamble: those lines are themselves counted as an add and a
// removal, which would make the expected numbers a statement about the fixture
// rather than about the three insertions and two deletions under test.
const DIFF = ["@@ -1,4 +1,5 @@", " keep", "-old one", "-old two", "+new one", "+new two", "+new three"].join("\n");

interface Rendered {
	/** Whole block, ANSI stripped. */
	block: string;
	/** Recorded collapsed one-liner, ANSI stripped. */
	summary: string;
	/** Recorded collapsed one-liner with escapes intact. */
	styledSummary: string;
}

function renderEdit(active: Theme, path: string, expanded: boolean, width = 100): Rendered {
	const result = {
		content: [{ type: "text", text: "" }],
		details: { path, diff: DIFF, firstChangedLine: 1 },
		isError: false,
	} as never;
	const component = editToolRenderer.renderResult(result, { expanded } as never, active);
	const { value, summary } = measureBlockRender(() => component.render(width));
	return {
		block: Bun.stripANSI(value.join("\n")),
		summary: Bun.stripANSI(summary ?? ""),
		styledSummary: summary ?? "",
	};
}

describe("edit header diffstat", () => {
	let active: Theme;
	beforeEach(async () => {
		const dark = await getThemeByName("dark");
		expect(dark).toBeDefined();
		setThemeInstance(dark!);
		active = dark!;
	});

	it("reports added and removed counts on the expanded card", () => {
		const { block } = renderEdit(active, "src/mcp/oauth-discovery.ts", true);
		expect(block).toContain("+3");
		expect(block).toContain("-2");
	});

	it("keeps the same counts on the collapsed one-liner", () => {
		const { summary } = renderEdit(active, "src/mcp/oauth-discovery.ts", false);
		expect(summary).toContain("+3");
		expect(summary).toContain("-2");
	});

	it("colors additions and removals with the diff roles, not one flat run", () => {
		const { styledSummary } = renderEdit(active, "src/mcp/oauth-discovery.ts", false);
		expect(styledSummary).toContain(active.getFgAnsi("toolDiffAdded"));
		expect(styledSummary).toContain(active.getFgAnsi("toolDiffRemoved"));
		expect(active.getFgAnsi("toolDiffAdded")).not.toBe(active.getFgAnsi("toolDiffRemoved"));
	});

	it("records the header that shipped, not the oversized measurement pass", () => {
		// Long enough to force the width-refit branch. The recorded row must be
		// the refitted one, or the collapsed card carries a header wider than the
		// card holding it and the stat is what gets truncated away.
		const long = `src/${"deeply-nested-directory/".repeat(6)}oauth-discovery.ts`;
		const { block, summary } = renderEdit(active, long, false, 60);
		expect(summary).toContain("+3");
		expect(summary).toContain("-2");
		expect(block).toContain(summary.trimEnd());
	});

	it("omits the stat when nothing changed", () => {
		const result = {
			content: [{ type: "text", text: "" }],
			details: { path: "src/f.ts", diff: "", firstChangedLine: undefined },
			isError: false,
		} as never;
		const component = editToolRenderer.renderResult(result, { expanded: false } as never, active);
		const { summary } = measureBlockRender(() => component.render(100));
		expect(Bun.stripANSI(summary ?? "")).not.toContain("+0");
	});
});
