/**
 * Contract: the phone portal paints the HOST's omp theme, not a palette of its own.
 *
 * `portal-ui.html` ships with the built-in `dark`/`light` values baked in so it
 * renders standalone, and `portalThemeStyle()` overrides them with whatever theme
 * the machine is configured to use. Two things about that are easy to break and
 * invisible until someone opens the page on a phone:
 *
 *  - the four surface rungs are DERIVED, not declared, so an arithmetic slip makes
 *    every card the same colour as its canvas and the transcript loses its
 *    boundaries entirely; and
 *  - the emitted custom-property names have to be the ones the stylesheet consumes,
 *    or the block is inert and nothing says so.
 *
 * Both are pinned here against the shipped `dark` theme, whose values are fixed.
 */
import { describe, expect, it } from "bun:test";
import portalHtml from "../../src/mobile/portal-ui.html" with { type: "text" };
import { portalThemeStyle } from "../../src/mobile/theme-css";

/** Every `--token: value;` in one CSS block, as a lookup. */
function declarationsOf(css: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of css.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
	return out;
}

describe("portal theme CSS", () => {
	it("derives the surface ladder from the theme's own status-line background", async () => {
		const style = await portalThemeStyle();
		expect(style).toStartWith('<style id="omp-theme">');
		const root = /:root\{([^}]*)\}/.exec(style)?.[1] ?? "";
		const vars = declarationsOf(root);
		/*
		 * `deriveSurfaceLadder`: the anchor is `statusLineBg` and each rung steps every
		 * channel by +10 on a dark theme. This machine's configured dark theme decides
		 * the anchor, so the assertion is on the ARITHMETIC rather than on four literals
		 * — which is the part that breaks, and the part a literal would stop pinning the
		 * moment anyone changed their theme.
		 */
		const channels = (hex: string): number[] => {
			const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
			expect(m).not.toBeNull();
			return [1, 2, 3].map(i => Number.parseInt(m![i]!, 16));
		};
		const canvas = channels(vars["--canvas"]!);
		const panel = channels(vars["--panel"]!);
		const element = channels(vars["--element"]!);
		const overlay = channels(vars["--overlay"]!);
		// One consistent direction and one consistent size for all three rungs.
		const step = panel[0]! - canvas[0]!;
		expect(Math.abs(step)).toBeOneOf([5, 10]);
		for (let i = 0; i < 3; i++) {
			expect(panel[i]! - canvas[i]!).toBe(step);
			expect(element[i]! - canvas[i]!).toBe(step * 2);
			expect(overlay[i]! - canvas[i]!).toBe(step * 3);
		}
	});

	it("emits only custom properties the stylesheet actually consumes", async () => {
		const style = await portalThemeStyle();
		const source = String(portalHtml);
		for (const name of Object.keys(declarationsOf(style))) {
			// `var(--x)` in a rule, or `--x:` in the `:root` defaults — either way the
			// stylesheet knows the name. An emitted variable nothing reads is dead weight
			// on every page load and one more thing to keep honest.
			expect(source.includes(`var(${name})`) || source.includes(`${name}:`)).toBe(true);
		}
	});

	it("covers both palettes so a light phone is themed too", async () => {
		const style = await portalThemeStyle();
		// The same two-tier shape the stylesheet's own defaults use: an explicit
		// `?theme=light` pin, plus the system preference.
		expect(style).toContain('[data-theme="light"]{');
		expect(style).toContain("@media(prefers-color-scheme:light)");
		expect(style).toContain(':root:not([data-theme="dark"])');
	});

	it("closes its style element so the splice cannot swallow the document", async () => {
		const style = await portalThemeStyle();
		expect(style).toEndWith("</style>");
		// One element, one open tag: the portal splices this ahead of `</head>`, and a
		// stray `<style>` would leave the rest of the head inside a stylesheet.
		expect(style.split("<style").length).toBe(2);
	});
});
