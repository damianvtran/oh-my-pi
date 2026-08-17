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
 * Every case passes the theme names explicitly. Reading them from settings would
 * make these assertions depend on the machine the suite runs on — a developer whose
 * `theme.dark` names a deleted custom theme would see failures that are not defects
 * — and would install the global `Settings` singleton into every later test file
 * sharing the bun process.
 */
import { describe, expect, it } from "bun:test";
import portalHtml from "../../src/mobile/portal-ui.html" with { type: "text" };
import { portalThemeStyle, surfaceDeclarations } from "../../src/mobile/theme-css";

/** Every `--token: value;` in one CSS block, as a lookup. */
function declarationsOf(css: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of css.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
	return out;
}

function channels(hex: string): number[] {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	expect(m).not.toBeNull();
	return [1, 2, 3].map(i => Number.parseInt(m![i]!, 16));
}

/** The `:root` block, which is where the dark palette lands. */
function rootVars(style: string): Record<string, string> {
	return declarationsOf(/:root\{([^}]*)\}/.exec(style)?.[1] ?? "");
}

const BUILTIN: [string, string] = ["dark", "light"];

describe("portal surface ladder", () => {
	const vars = (declarations: string[]): Record<string, string> => declarationsOf(declarations.join(""));

	it("steps up from a dark anchor and down from a light one", () => {
		// The rungs are what replaced every border in the transcript: a wrong sign or a
		// wrong size does not throw, it just makes every card the colour of its canvas.
		const dark = vars(surfaceDeclarations("#1e1e24", false));
		expect([dark["--canvas"], dark["--panel"], dark["--element"], dark["--overlay"]]).toEqual([
			"#1e1e24",
			"#28282e",
			"#323238",
			"#3c3c42",
		]);
		// Light steps DOWN, and by 14 rather than the terminal's 5 — see
		// `SURFACE_STEP_LIGHT`'s note: at 5 a light card measured 1.049:1 against its
		// canvas, and the fills are the only boundary this design has.
		const light = vars(surfaceDeclarations("#f0f0f0", true));
		expect([light["--canvas"], light["--panel"], light["--element"], light["--overlay"]]).toEqual([
			"#f0f0f0",
			"#e2e2e2",
			"#d4d4d4",
			"#c6c6c6",
		]);
	});

	it("rejects the two substituted sentinels rather than anchoring on them", () => {
		// `getHtmlDefaultTextForSurface`'s outputs. `#000000` under a DARK theme is the
		// case a luminance test accepted: it agreed with the mode, so the phone painted a
		// pure-black ladder for a theme that had simply omitted the token.
		expect(vars(surfaceDeclarations("#000000", false))["--canvas"]).toBe("#121212");
		expect(vars(surfaceDeclarations("#e5e5e7", true))["--canvas"]).toBe("#e0e0e0");
		// And the pair that a luminance test already caught, still caught.
		expect(vars(surfaceDeclarations("#e5e5e7", false))["--canvas"]).toBe("#121212");
		expect(vars(surfaceDeclarations("#000000", true))["--canvas"]).toBe("#e0e0e0");
	});

	it("rejects an anchor that disagrees with the theme's own mode", () => {
		// A light hex declared by a dark theme is a mis-declared token, and building the
		// ladder from it would invert the entire page.
		expect(vars(surfaceDeclarations("#fafafa", false))["--canvas"]).toBe("#121212");
		expect(vars(surfaceDeclarations("#101010", true))["--canvas"]).toBe("#e0e0e0");
	});

	it("rejects a value that is not a six-digit hex", () => {
		// `resolveVarRefs` guarantees a leading `#` and nothing else, and the settings
		// schema has no pattern behind it, so a 3-digit hex, an ANSI-256 number and an
		// empty token all arrive here.
		for (const bad of ["", "#fff", "205", "red", "#12345g", "#000}"]) {
			expect(vars(surfaceDeclarations(bad, false))["--canvas"], bad).toBe("#121212");
		}
	});

	it("keeps a near-floor anchor's rungs in range", () => {
		// `#020202` + 30 on the top rung. The channels are clamped rather than allowed to
		// wrap, which would put the top rung BELOW the canvas and invert the ladder.
		const bottom = vars(surfaceDeclarations("#020202", false));
		expect(bottom["--canvas"]).toBe("#020202");
		expect(bottom["--overlay"]).toBe("#202020");
		// The clamp itself is unreachable from here, and that is worth pinning: the
		// mode-agreement rule above rejects any anchor within 42 of the wrong end (a dark
		// theme's anchor is at most mid-grey, a light theme's at least mid-grey), so the
		// arithmetic cannot leave the range. `clamp` guards the arithmetic, not this path.
		const wrongMode = vars(surfaceDeclarations("#0a0a0a", true));
		expect(wrongMode["--canvas"]).toBe("#e0e0e0");
	});
});

describe("portal theme CSS", () => {
	it("derives the surface ladder from the theme's own status-line background", async () => {
		const { style, resolved } = await portalThemeStyle(BUILTIN);
		expect(resolved).toEqual(["dark", "light"]);
		expect(style).toStartWith('<style id="omp-theme">');
		const vars = rootVars(style);
		// The shipped `dark` theme's own `statusLineBg` is `#121212`, so these four are
		// literals rather than an arithmetic identity — a step of the wrong size or sign
		// has to fail, where an identity test would pass on a step of 0.
		expect(vars["--canvas"]).toBe("#121212");
		expect(vars["--panel"]).toBe("#1c1c1c");
		expect(vars["--element"]).toBe("#262626");
		expect(vars["--overlay"]).toBe("#303030");
		// A token only the theme's palette can supply, so this cannot pass on a
		// ladder-only block: `dark.json`'s accent.
		expect(vars["--accent"]).toBe("#febc38");
	});

	it("steps the light palette the other way, and by less", async () => {
		const { style } = await portalThemeStyle(BUILTIN);
		// The light block is emitted twice (an explicit pin and the media query); either
		// copy answers the question.
		const light = declarationsOf(/\[data-theme="light"\]\{([^}]*)\}/.exec(style)?.[1] ?? "");
		const canvas = channels(light["--canvas"]!);
		const panel = channels(light["--panel"]!);
		const overlay = channels(light["--overlay"]!);
		// Down, not up: a light theme's rungs are darker than its canvas, and 5 per
		// channel rather than 10, which is what `deriveSurfaceLadder` does.
		for (let i = 0; i < 3; i++) {
			expect(panel[i]! - canvas[i]!).toBe(-14);
			expect(overlay[i]! - canvas[i]!).toBe(-42);
		}
	});

	it("emits only custom properties the stylesheet actually consumes", async () => {
		const { style } = await portalThemeStyle(BUILTIN);
		const source = String(portalHtml);
		for (const name of Object.keys(declarationsOf(style))) {
			// `var(--x)` in a rule, or `--x:` in the `:root` defaults — either way the
			// stylesheet knows the name. An emitted variable nothing reads is dead weight
			// on every page load and one more thing to keep honest.
			expect(source.includes(`var(${name})`) || source.includes(`${name}:`)).toBe(true);
		}
	});

	it("emits every value as a literal hex", async () => {
		const { style } = await portalThemeStyle(BUILTIN);
		// The validation that keeps a hand-written theme from closing the `:root` block
		// (`#000}`) or the style element (`#000</style><script>`) on a surface that
		// steers live agents. `color-scheme` is the one non-colour declaration.
		for (const [name, value] of Object.entries(declarationsOf(style))) {
			expect(value, name).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("covers both palettes so a light phone is themed too", async () => {
		const { style } = await portalThemeStyle(BUILTIN);
		// The same two-tier shape the stylesheet's own defaults use: an explicit
		// `?theme=light` pin, plus the system preference.
		expect(style).toContain('[data-theme="light"]{');
		expect(style).toContain("@media(prefers-color-scheme:light)");
		expect(style).toContain(':root:not([data-theme="dark"])');
	});

	it("closes its style element so the splice cannot swallow the document", async () => {
		const { style } = await portalThemeStyle(BUILTIN);
		expect(style).toEndWith("</style>");
		// One element, one open tag: the portal splices this ahead of `</head>`, and a
		// stray `<style>` would leave the rest of the head inside a stylesheet.
		expect(style.split("<style").length).toBe(2);
	});

	it("falls back to the built-in palette when neither theme resolves", async () => {
		// A typo in `theme.dark`, or a custom theme file that was deleted. The page has
		// its own `:root` defaults, so an empty override is the correct answer - an
		// unstyled page or a thrown error is not.
		const { style, resolved } = await portalThemeStyle(["no-such-theme", "also-missing"]);
		expect(style).toBe("");
		expect(resolved).toEqual([]);
	});

	it("keeps a resolvable palette when only one of the two themes is missing", async () => {
		const { style, resolved } = await portalThemeStyle(["dark", "also-missing"]);
		expect(resolved).toEqual(["dark"]);
		expect(rootVars(style)["--canvas"]).toBe("#121212");
		// No light block at all, rather than a half-populated one: the media query would
		// otherwise repaint a light phone with the dark theme's leftovers.
		expect(style).not.toContain("prefers-color-scheme");
	});
});
