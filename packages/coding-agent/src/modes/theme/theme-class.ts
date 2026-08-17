import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import { applyBackgroundToLine } from "@oh-my-pi/pi-tui/utils";
import { colorLuma, hexToRgb, logger, relativeLuminance, rgbToHex } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ansi256ToHex, bgAnsi, colorToAnsi, fgAnsi, resolveToHex } from "./color";
import type { ColorMode, ThemeBg, ThemeColor } from "./schema";
import {
	SPINNER_FRAMES,
	type SpinnerType,
	SYMBOL_PRESETS,
	type SymbolKey,
	type SymbolMap,
	type SymbolPreset,
} from "./symbols";

// ============================================================================
// Theme Class
// ============================================================================

const langMap: Record<string, SymbolKey> = {
	typescript: "lang.typescript",
	ts: "lang.typescript",
	tsx: "lang.typescript",
	javascript: "lang.javascript",
	js: "lang.javascript",
	jsx: "lang.javascript",
	mjs: "lang.javascript",
	cjs: "lang.javascript",
	python: "lang.python",
	py: "lang.python",
	rust: "lang.rust",
	rs: "lang.rust",
	go: "lang.go",
	java: "lang.java",
	c: "lang.c",
	cpp: "lang.cpp",
	"c++": "lang.cpp",
	cc: "lang.cpp",
	cxx: "lang.cpp",
	csharp: "lang.csharp",
	cs: "lang.csharp",
	ruby: "lang.ruby",
	rb: "lang.ruby",
	julia: "lang.julia",
	jl: "lang.julia",
	php: "lang.php",
	swift: "lang.swift",
	kotlin: "lang.kotlin",
	kt: "lang.kotlin",
	bash: "lang.shell",
	sh: "lang.shell",
	zsh: "lang.shell",
	fish: "lang.shell",
	powershell: "lang.shell",
	just: "lang.shell",
	shell: "lang.shell",
	html: "lang.html",
	htm: "lang.html",
	astro: "lang.html",
	vue: "lang.html",
	svelte: "lang.html",
	css: "lang.css",
	scss: "lang.css",
	sass: "lang.css",
	less: "lang.css",
	json: "lang.json",
	yaml: "lang.yaml",
	yml: "lang.yaml",
	markdown: "lang.markdown",
	md: "lang.markdown",
	sql: "lang.sql",
	dockerfile: "lang.docker",
	docker: "lang.docker",
	lua: "lang.lua",
	text: "lang.text",
	txt: "lang.text",
	plain: "lang.text",
	log: "lang.log",
	env: "lang.env",
	dotenv: "lang.env",
	toml: "lang.toml",
	xml: "lang.xml",
	ini: "lang.ini",
	conf: "lang.conf",
	cfg: "lang.conf",
	config: "lang.conf",
	properties: "lang.conf",
	csv: "lang.csv",
	tsv: "lang.tsv",
	image: "lang.image",
	img: "lang.image",
	png: "lang.image",
	jpg: "lang.image",
	jpeg: "lang.image",
	gif: "lang.image",
	webp: "lang.image",
	svg: "lang.image",
	ico: "lang.image",
	bmp: "lang.image",
	tiff: "lang.image",
	pdf: "lang.pdf",
	zip: "lang.archive",
	tar: "lang.archive",
	gz: "lang.archive",
	tgz: "lang.archive",
	bz2: "lang.archive",
	xz: "lang.archive",
	"7z": "lang.archive",
	exe: "lang.binary",
	dll: "lang.binary",
	so: "lang.binary",
	dylib: "lang.binary",
	wasm: "lang.binary",
	bin: "lang.binary",
};

/**
 * Brand colors for language icons, keyed by the resolved `lang.*` SymbolKey.
 * Used by {@link Theme.getLangIconStyled} so eval-kernel cell headers tint each
 * language with its recognizable hue (JS yellow, Ruby red, Julia purple, Python
 * blue) instead of a flat muted gray. Applied as truecolor/256 per the active
 * color mode; languages without an entry fall back to the muted theme color.
 */
const LANG_BRAND_COLORS: Partial<Record<SymbolKey, string>> = {
	"lang.javascript": "#f7df1e",
	"lang.python": "#3776ab",
	"lang.ruby": "#cc342d",
	"lang.julia": "#9558b2",
};

/**
 * Per-channel distance between neighbouring rungs of the surface ladder.
 *
 * `colorLuma` weights sum to 1, so moving every channel by `k` shifts luma by
 * exactly `k / 255`: the dark step is 3.9%, the light one 2.0%. Sized off
 * opencode's own ladder (`#0a0a0a -> #141414 -> #1e1e1e` dark,
 * `#ffffff -> #fafafa -> #f5f5f5` light), which is where those two numbers come
 * from. Light surfaces take the smaller step because a difference that close to
 * white already reads clearly; the dark step at that size would be invisible.
 */
const SURFACE_STEP_DARK = 10;
const SURFACE_STEP_LIGHT = 5;

/**
 * Resolve a theme *background* value to a CSS hex string.
 *
 * Separate from {@link resolveToHex} because the terminal default means something
 * different behind text than it does in text: it is the page, so it maps to the
 * extreme matching the theme's appearance rather than to the default text color.
 * Also drops the alpha byte a few themes carry on `selectedBg` (`#rrggbbaa`), which
 * the shared color helpers reject outright.
 */
function resolveBgToHex(value: string | number, isLight: boolean): string {
	if (typeof value === "number") return ansi256ToHex(value);
	if (value === "") return isLight ? "#ffffff" : "#000000";
	return value.length === 9 ? value.slice(0, 7) : value;
}

/**
 * Move every channel by `step`, clamped to the byte range.
 *
 * A uniform channel step is the one nudge whose luma delta is exactly
 * predictable (see {@link SURFACE_STEP_DARK}), which is what lets the ladder
 * promise evenly spaced rungs on any theme. It costs a little saturation on a
 * strongly tinted surface, and at these step sizes that is not perceptible.
 */
function stepChannels(hex: string, step: number): string {
	const rgb = hexToRgb(hex);
	return rgbToHex({ r: rgb.r + step, g: rgb.g + step, b: rgb.b + step });
}

/** Linear interpolation from `a` to `b`, `t` in 0..1. */
function mixHex(a: string, b: string, t: number): string {
	const ra = hexToRgb(a);
	const rb = hexToRgb(b);
	return rgbToHex({ r: ra.r + (rb.r - ra.r) * t, g: ra.g + (rb.g - ra.g) * t, b: ra.b + (rb.b - ra.b) * t });
}

/**
 * How far the selection wash is pulled toward the theme's accent, and how far
 * apart from the panel it must end up.
 *
 * Two knobs because the accent supplies only *hue*: measured over the 98
 * bundled themes that derive a ladder, a pure 26% accent blend leaves the panel
 * anywhere from 1.06:1 (`light-retro`, whose amber accent is almost exactly as
 * bright as its paper) to 2.0:1, and no blend ratio fixes the low end — even at
 * 100% accent `light-retro` reaches only 1.18:1. So the blend carries the tint
 * and {@link SELECTION_MIN_CONTRAST} carries the separation.
 *
 * 1.5:1 is where editors that have solved this already sit: VS Code ships
 * `#ADD6FF` on white (1.44:1) and `#264F78` on `#1E1E1E` (2.06:1). It is also
 * shallow enough that the panel's own foreground colours keep working on top of
 * the wash, which is the whole point of not simply inverting.
 */
const SELECTION_ACCENT_MIX = 0.26;
const SELECTION_MIN_CONTRAST = 1.5;

/**
 * The wash marking selected composer text: the panel rung, tinted toward the
 * theme's accent and then walked along the ladder direction until it clears
 * {@link SELECTION_MIN_CONTRAST} against that same panel.
 *
 * The walk starts at zero and takes the smallest offset that reads, so a theme
 * whose accent already separates the two surfaces keeps its accent colour
 * untouched and only the washed-out ones get pushed. `step` points away from
 * the anchor's own luma, which is by construction the direction with the most
 * headroom — but a user theme whose declared appearance disagrees with its own
 * `statusLineBg` can walk the short way and saturate, so the opposite
 * direction is tried before conceding.
 *
 * Falls back to the element rung when either colour is unparseable — a user
 * theme with a `var` ref or a named colour in `accent` gets the pre-existing
 * behaviour rather than a crash — and when neither direction can clear the
 * floor, which needs a panel already at an extreme of the range.
 */
function deriveSelectionWash(panel: string, accent: string, element: string, step: number): string {
	const panelLuma = relativeLuminance(panel);
	if (panelLuma === undefined || relativeLuminance(accent) === undefined) return element;
	const tinted = mixHex(panel, accent, SELECTION_ACCENT_MIX);
	const clears = (candidate: string): boolean => {
		const luma = relativeLuminance(candidate) ?? panelLuma;
		return (Math.max(panelLuma, luma) + 0.05) / (Math.min(panelLuma, luma) + 0.05) >= SELECTION_MIN_CONTRAST;
	};
	for (const direction of step > 0 ? [1, -1] : [-1, 1]) {
		for (let offset = 0; offset <= 255; offset++) {
			const candidate = stepChannels(tinted, direction * offset);
			if (clears(candidate)) return candidate;
		}
	}
	return element;
}

/**
 * The ladder's surfaces as hex, in derivation order, plus the two selection
 * washes — not rungs of their own, but derived here so they inherit the
 * ladder's step direction instead of deciding appearance twice.
 *
 * There are two because the wash's contrast floor is measured against the
 * surface it is painted on, and an editor inside a floating overlay is two
 * rungs above the composer. One wash cannot be both subtle on `panel` and
 * legible on `overlay`.
 */
type SurfaceLadder = readonly [
	canvas: string,
	panel: string,
	element: string,
	selection: string,
	overlay: string,
	selectionOverlay: string,
];

/**
 * Four stacked surfaces derived from the theme rather than declared by it.
 *
 * Every theme predates the fullscreen viewport, and user themes sit on disk
 * unversioned, so asking for four new keys would leave all of them flat. The
 * anchor is `statusLineBg`: it is already the theme's own base surface and the
 * value that classifies the theme light or dark, so anchoring anywhere else
 * could hand a light theme a dark canvas. Each rung then steps *away* from that
 * anchor, up on dark themes and down on light ones, which is the direction that
 * keeps a card reading as raised in both appearances.
 *
 * Rungs cannot collapse into each other: the anchor's own luma picks the
 * direction, so a dark anchor (luma <= 0.5) always has a channel below 255 to
 * raise and a light one always has a channel above 0 to lower. That holds at
 * the furthest rung too — a colour whose channels are all >= 225 has a luma
 * around 0.88 and could never have been classified dark, and the mirror bound
 * rules out the light case — so even a three-step move leaves a channel free.
 * A saturated anchor may clip one channel and take a slightly shorter step,
 * never a zero one.
 *
 * Undefined when the theme leaves `statusLineBg` at the terminal default. That
 * theme has declined to paint a surface at all, and covering the terminal's own
 * background with a guess would fight whatever the user set it to.
 */
function deriveSurfaceLadder(
	bgColors: Record<ThemeBg, string | number>,
	accent: string,
	isLight: boolean,
): SurfaceLadder | undefined {
	if (bgColors.statusLineBg === "") return undefined;
	const canvas = resolveBgToHex(bgColors.statusLineBg, isLight);
	const step = isLight ? -SURFACE_STEP_LIGHT : SURFACE_STEP_DARK;
	const panel = stepChannels(canvas, step);
	const element = stepChannels(canvas, step * 2);
	// A floating panel needs a rung nothing in the transcript uses. `element` is
	// not free: it is what a select list's own selected row and hover band paint
	// on, so filling an overlay with it makes the selection inside that overlay
	// pixel-identical to its background. One more step clears both.
	//
	// Every rung steps toward the theme's foreground, so this one is also the
	// most expensive: against the panel fill overlays used before, `dim` drops
	// below 3:1 on 19 more themes and `muted` on 4. Backing off does not buy
	// that back - a 2.5-step rung rescues 5 of the 71 themes that fail the 3:1
	// floor here, because 50 of them already fail it on `panel`. The separation
	// a modal needs is simply not free on the lightness axis; buying it back
	// means scrimming the transcript behind the modal instead of raising the
	// modal, which is a real design change and not a constant to retune.
	const overlay = stepChannels(canvas, step * 3);
	return [
		canvas,
		panel,
		element,
		deriveSelectionWash(panel, accent, element, step),
		overlay,
		// The same derivation re-anchored: an editor inside a floating overlay
		// paints its selection on `overlay`, two rungs above the composer, so the
		// panel-anchored wash lands there at 1.10-1.14:1 on most themes - the
		// exact invisibility this ladder exists to prevent.
		deriveSelectionWash(overlay, accent, element, step),
	];
}

/**
 * Index just past the escape sequence starting at `i`: a CSI run ends at its
 * final byte (0x40..0x7e), an OSC run (hyperlinks) at BEL or ST.
 */
function skipEscape(row: string, i: number): number {
	if (row[i + 1] === "]") {
		const bel = row.indexOf("\x07", i);
		const st = row.indexOf("\x1b\\", i + 2);
		if (bel === -1 && st === -1) return row.length;
		return bel !== -1 && (st === -1 || bel < st) ? bel + 1 : st + 2;
	}
	let end = i + 2;
	while (end < row.length && (row.charCodeAt(end) < 0x40 || row.charCodeAt(end) > 0x7e)) end++;
	return end + 1;
}

/**
 * Whether an SGR parameter list drops back to the default background: a full
 * reset (`0`, or an omitted parameter, which defaults to 0) or `49`.
 *
 * Extended-color introducers are stepped over rather than scanned, because
 * their operands are plain numbers: `38;5;0` selects black *text* and
 * `48;2;0;0;0` a black background, and neither clears anything.
 */
function sgrClearsBackground(params: string): boolean {
	if (params === "") return true;
	const tokens = params.split(";");
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "38" || token === "48") {
			// Sub-parameter counts per ITU-T T.416: `5` takes one index, `2` takes
			// three components. A malformed introducer falls through to the scan,
			// where the worst case is one redundant re-open.
			const mode = tokens[i + 1];
			if (mode === "5") i += 2;
			else if (mode === "2") i += 4;
			continue;
		}
		if (token === "" || Number(token) === 0 || token === "49") return true;
	}
	return false;
}

/**
 * Re-open `open` after every SGR in `text` that clears the background.
 *
 * Rendered rows carry their own `\x1b[0m` and `\x1b[49m` partway through, and a
 * plain open/close wrapper would lose the fill from the first such reset to the
 * end of the row. On screen that reads as a torn panel: the right-hand gutter
 * reverts to the terminal default on exactly the rows that have styled content.
 *
 * Only the background is re-asserted. A `\x1b[0m` also drops the foreground, but
 * whatever the row does with its own text after that reset is the row's business.
 */
function reassertBackground(text: string, open: string): string {
	if (!text.includes("\x1b")) return text;
	let out = "";
	let copied = 0;
	let i = 0;
	while (i < text.length) {
		if (text.charCodeAt(i) !== 0x1b) {
			i++;
			continue;
		}
		const end = skipEscape(text, i);
		// `m` is the SGR final byte; OSC hyperlinks and non-SGR CSI carry no color.
		if (text[i + 1] === "[" && text[end - 1] === "m" && sgrClearsBackground(text.slice(i + 2, end - 1))) {
			out += text.slice(copied, end) + open;
			copied = end;
		}
		i = end;
	}
	return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Paint `text` on `open`, unbroken across inner resets and filled to `width`
 * visible columns. Padding before the close is what makes a short row cover the
 * whole panel instead of stopping at its last glyph.
 *
 * A nested surface that closes itself with `\x1b[49m` is repaired by
 * `reassertBackground`, which re-opens `open` after every inner reset — so the
 * padding lands on this surface's colour rather than the inner one, and an
 * inset composer does not bleed its panel to the frame edge.
 *
 * An empty `open` means the theme paints no surface, so the text comes back
 * untouched rather than wrapped in a pair of no-op escapes.
 */
function paintSurface(open: string, text: string, width?: number): string {
	if (open === "") return text;
	// Width 0 pads nothing, which is exactly the unsized behaviour.
	return applyBackgroundToLine(reassertBackground(text, open), width ?? 0, row => `${open}${row}\x1b[49m`);
}

export class Theme {
	#fgColors: Record<ThemeColor, string>;
	#bgColors: Record<ThemeBg, string>;
	/** Resolved hex strings for foreground colors — populated at construction. */
	readonly #hexFgColors: Record<ThemeColor, string>;
	/** Resolved hex strings for background colors — populated at construction. */
	readonly #hexBgColors: Record<ThemeBg, string>;
	#symbols: SymbolMap;
	#spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>>;
	/**
	 * Raw background opens for the bottom three surface rungs, in ladder order,
	 * or empty strings when the theme paints no surface at all (see
	 * {@link deriveSurfaceLadder}). The fourth rung is {@link overlayBgAnsi},
	 * declared below the selection wash rather than here because the wash is not
	 * a rung and the tuple keeps them in derivation order, not luma order.
	 * Derived once at construction because they depend only on the theme's own
	 * colors.
	 *
	 * Public so callers assembling their own rows (the viewport fill, hand-built
	 * status rows) can emit the sequence directly. Anything that is just text
	 * should go through {@link surfaceBg}/{@link panelBg}/{@link elementBg}, which
	 * also survive inner resets and fill to width.
	 */
	readonly surfaceBgAnsi: string;
	readonly panelBgAnsi: string;
	readonly elementBgAnsi: string;
	/**
	 * Background open for the composer selection wash. Not a rung — see
	 * {@link selectionBg} for why it needs its own surface.
	 */
	readonly selectionBgAnsi: string;
	/**
	 * The same wash re-anchored on {@link overlayBgAnsi}, for an editor hosted
	 * inside a floating overlay. Its contrast floor is measured against the
	 * surface it lands on, and that surface is two rungs above the composer.
	 */
	readonly selectionOverlayBgAnsi: string;
	/**
	 * Background open for a floating overlay: one rung above `element`, because
	 * `element` is what a select list's selected row and hover band paint on and
	 * an overlay filled with it swallows its own selection.
	 */
	readonly overlayBgAnsi: string;
	/**
	 * Perceptual luma (0..1) of the status-line background — used to classify the
	 * theme light/dark. Undefined when it can't be resolved. Classified against the
	 * status line (the surface session accents render on) rather than the chat bubble
	 * (`userMessageBg`), which some themes (e.g. `porcelain`) style dark on an
	 * otherwise-light theme.
	 */
	readonly statusLineLuminance: number | undefined;
	/** WCAG relative luminance of the status-line background — basis for accent contrast. */
	readonly #statusLineContrastLuminance: number | undefined;
	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		private readonly mode: ColorMode,
		private readonly symbolPreset: SymbolPreset,
		symbolOverrides: Partial<Record<SymbolKey, string>>,
		spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>> = {},
	) {
		this.statusLineLuminance = colorLuma(bgColors.statusLineBg);
		this.#statusLineContrastLuminance = relativeLuminance(bgColors.statusLineBg);
		const slIsLight = this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;

		this.#fgColors = {} as Record<ThemeColor, string>;
		this.#hexFgColors = {} as Record<ThemeColor, string>;
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.#fgColors[key] = fgAnsi(value, mode);
			this.#hexFgColors[key] = resolveToHex(value, slIsLight);
		}
		this.#bgColors = {} as Record<ThemeBg, string>;
		this.#hexBgColors = {} as Record<ThemeBg, string>;
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.#bgColors[key] = bgAnsi(value, mode);
			this.#hexBgColors[key] = resolveToHex(value, slIsLight);
		}
		const ladder = deriveSurfaceLadder(bgColors, this.#hexFgColors.accent, slIsLight);
		this.surfaceBgAnsi = ladder === undefined ? "" : bgAnsi(ladder[0], mode);
		this.panelBgAnsi = ladder === undefined ? "" : bgAnsi(ladder[1], mode);
		this.elementBgAnsi = ladder === undefined ? "" : bgAnsi(ladder[2], mode);
		this.selectionBgAnsi = ladder === undefined ? "" : bgAnsi(ladder[3], mode);
		this.overlayBgAnsi = ladder === undefined ? "" : bgAnsi(ladder[4], mode);
		this.selectionOverlayBgAnsi = ladder === undefined ? "" : bgAnsi(ladder[5], mode);
		// Build symbol map from preset + overrides
		const baseSymbols = SYMBOL_PRESETS[symbolPreset];
		this.#symbols = { ...baseSymbols };
		for (const [key, value] of Object.entries(symbolOverrides)) {
			if (key in this.#symbols) {
				this.#symbols[key as SymbolKey] = value;
			} else {
				logger.debug("Invalid symbol key in override", { key, availableKeys: Object.keys(this.#symbols) });
			}
		}
		this.#spinnerFramesOverrides = spinnerFramesOverrides;
	}

	/** True when the active theme has a light status-line background. */
	get isLight(): boolean {
		return this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;
	}

	/**
	 * Surface luminance to size session accents against on light themes; undefined on
	 * dark themes so accents stay vivid. Pass straight to `getSessionAccentHex`.
	 */
	get accentSurfaceLuminance(): number | undefined {
		return this.isLight ? this.#statusLineContrastLuminance : undefined;
	}

	/**
	 * Get the resolved CSS hex string for a foreground theme color.
	 */
	getColorHex(color: ThemeColor): string {
		const hex = this.#hexFgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme color: ${color}`);
		return hex || (this.isLight ? "#000000" : "#e5e5e7");
	}

	/**
	 * Get all foreground and background theme colors as CSS hex strings.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
	getAllThemeColorHexes(): string[] {
		const hexes: string[] = [];
		for (const hex of Object.values(this.#hexFgColors)) {
			if (hex) hexes.push(hex);
		}
		for (const hex of Object.values(this.#hexBgColors)) {
			if (hex) hexes.push(hex);
		}
		return hexes;
	}

	/**
	 * Get the most visually dominant theme colors as CSS hex strings — accent,
	 * border, success, error, warning, heading, link, diff markers, etc.
	 * These are the colors the session accent could visually clash with.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
	getMajorThemeColorHexes(): string[] {
		const majors: ThemeColor[] = [
			"accent",
			"border",
			"borderAccent",
			"borderMuted",
			"success",
			"error",
			"warning",
			"mdHeading",
			"mdLink",
			"mdCode",
			"mdCodeBlock",
			"mdQuoteBorder",
			"mdListBullet",
			"toolDiffAdded",
			"toolDiffRemoved",
			"customMessageLabel",
			"thinkingText",
		];
		const hexes: string[] = [];
		for (const key of majors) {
			const hex = this.#hexFgColors[key];
			if (hex) hexes.push(hex);
		}
		return hexes;
	}
	/**
	 * Get the resolved CSS hex string for the theme's accent color.
	 */
	getAccentColorHex(): string {
		return this.getColorHex("accent");
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	/**
	 * The app canvas: the darkest surface on a dark theme, the lightest on a light
	 * one. Everything else in the fullscreen viewport sits on top of it.
	 *
	 * `width` fills the row out to that many visible columns, so a short line still
	 * paints edge to edge. Leave it off when the caller already padded the row (a
	 * {@link Box} bgFn, for instance) or the padding would be applied twice.
	 */
	surfaceBg(text: string, width?: number): string {
		return paintSurface(this.surfaceBgAnsi, text, width);
	}

	/** One rung up from the canvas: tool cards and the composer. */
	panelBg(text: string, width?: number): string {
		return paintSurface(this.panelBgAnsi, text, width);
	}

	/** Two rungs up: a raised or hovered surface, read against a panel beneath it. */
	elementBg(text: string, width?: number): string {
		return paintSurface(this.elementBgAnsi, text, width);
	}

	/**
	 * Wash marking selected text in the composer.
	 *
	 * Its own surface rather than {@link elementBg} because composer selection is
	 * the only selection signal in the app that carries nothing else: `SelectList`
	 * pairs `selectedRow` with an accent `selectedText` and a `selectedPrefix`
	 * glyph, so its band can afford to be a whisper, while selected composer text
	 * keeps its ordinary foreground and gains no marker. The background is the
	 * entire signal.
	 *
	 * Borrowing the element rung made that signal one ladder step — 10 channels on
	 * a dark theme, 5 on a light one — and the rung was sized to read against the
	 * canvas, not against the panel the composer already paints. Stacked on the
	 * panel it measured 1.13:1 on `dark` and 1.05:1 on `alabaster`/`birch`, which
	 * is invisible. See {@link deriveSelectionWash} for what replaces it.
	 */
	selectionBg(text: string, width?: number): string {
		return paintSurface(this.selectionBgAnsi, text, width);
	}

	/**
	 * {@link selectionBg} for an editor hosted inside a floating overlay.
	 *
	 * Two rungs of separation is exactly the gap that made this necessary: the
	 * panel-anchored wash lands on `overlay` at 1.10-1.14:1 on 95 of the 98
	 * bundled themes, which is the invisibility {@link deriveSelectionWash}
	 * exists to rule out. One wash cannot serve both surfaces — clearing the
	 * floor against `overlay` would overshoot on the composer.
	 */
	selectionOverlayBg(text: string, width?: number): string {
		return paintSurface(this.selectionOverlayBgAnsi, text, width);
	}

	/**
	 * Surface of a floating overlay in the fullscreen viewport.
	 *
	 * Three rungs up rather than two. A modal there draws no rule — its fill is
	 * the only thing defining it — so it needs a surface the transcript never
	 * uses, and `panelBg` is exactly what every card uses, which left a panel
	 * landing over one with no perceptible edge. `elementBg` is not free either:
	 * a select list's own selected row and hover band paint on it, so filling an
	 * overlay with it makes the selection inside that overlay invisible. This
	 * rung clears the transcript by two steps and leaves `element` free to mark
	 * selection against it by one, which is the same relative separation those
	 * bands had against a panel-filled overlay.
	 */
	overlayBg(text: string, width?: number): string {
		return paintSurface(this.overlayBgAnsi, text, width);
	}

	/**
	 * Background wash marking the row the pointer is over.
	 *
	 * The same surface as {@link elementBg}, because hovered and raised are one
	 * state: a row the pointer lifts off the panel. Keeping them separate let a
	 * hovered card and a raised card sit on different greys in the same frame.
	 */
	hoverBg(text: string, width?: number): string {
		return this.elementBg(text, width);
	}

	/**
	 * Foreground for affordance text such as a disclosure hint.
	 *
	 * Maps to the existing `dim` role, which is already how this palette spells
	 * "present but not competing for attention" (editor hints, settings hints,
	 * descriptions), so themes need no new key and hints stay consistent with the
	 * rest of the UI. A theme that leaves `dim` at the terminal default gets plain
	 * text back instead of a pair of no-op escapes.
	 */
	interactiveHint(text: string): string {
		if (this.#fgColors.dim === "\x1b[39m") return text;
		return this.fg("dim", text);
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	/**
	 * Foreground ANSI for text drawn **on top of** `fillColor` used as a solid
	 * background (e.g. a powerline chip). Picks near-black or near-white by the
	 * fill's perceived luminance (Rec. 601 luma) so the label stays legible on
	 * both bright and dark fills, across light and dark themes.
	 *
	 * Reads the RGB out of the already-resolved truecolor escape; when the fill
	 * is encoded as a 256-palette index (limited terminals) the RGB is
	 * unavailable, so it falls back to the theme `text` color.
	 */
	getContrastFgAnsi(fillColor: ThemeColor): string {
		const ansi = this.#fgColors[fillColor];
		const match = ansi ? /38;2;(\d+);(\d+);(\d+)/.exec(ansi) : null;
		if (!match) return this.#fgColors.text;
		const luma = 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
		return luma > 140 ? "\x1b[38;2;0;0;0m" : "\x1b[38;2;255;255;255m";
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: ThinkingLevel | Effort): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				// thinkingMax is optional; themes without it resolve to the xhigh color.
				return (str: string) => this.fg(this.#fgColors.thinkingMax ? "thinkingMax" : "thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}

	getPythonModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("pythonMode", str);
	}

	// ============================================================================
	// Symbol Methods
	// ============================================================================

	/**
	 * Get a symbol by key.
	 */
	symbol(key: SymbolKey): string {
		return this.#symbols[key];
	}

	/**
	 * Get a symbol styled with a color.
	 */
	styledSymbol(key: SymbolKey, color: ThemeColor): string {
		return this.fg(color, this.#symbols[key]);
	}

	/**
	 * Get the current symbol preset.
	 */
	getSymbolPreset(): SymbolPreset {
		return this.symbolPreset;
	}

	// ============================================================================
	// Symbol Category Accessors
	// ============================================================================

	get status() {
		return {
			success: this.#symbols["status.success"],
			error: this.#symbols["status.error"],
			warning: this.#symbols["status.warning"],
			info: this.#symbols["status.info"],
			pending: this.#symbols["status.pending"],
			disabled: this.#symbols["status.disabled"],
			enabled: this.#symbols["status.enabled"],
			running: this.#symbols["status.running"],
			shadowed: this.#symbols["status.shadowed"],
			aborted: this.#symbols["status.aborted"],
			done: this.#symbols["status.done"],
		};
	}

	get nav() {
		return {
			cursor: this.#symbols["nav.cursor"],
			selected: this.#symbols["nav.selected"],
			expand: this.#symbols["nav.expand"],
			collapse: this.#symbols["nav.collapse"],
			back: this.#symbols["nav.back"],
			// A collapsed row offers "expand" and an expanded row offers "collapse", so
			// the disclosure marker is the matching nav glyph under a state-shaped name.
			// Aliasing keeps a theme's `nav.expand`/`nav.collapse` overrides effective.
			disclosureCollapsed: this.#symbols["nav.expand"],
			disclosureExpanded: this.#symbols["nav.collapse"],
		};
	}

	get tree() {
		return {
			branch: this.#symbols["tree.branch"],
			last: this.#symbols["tree.last"],
			vertical: this.#symbols["tree.vertical"],
			horizontal: this.#symbols["tree.horizontal"],
			hook: this.#symbols["tree.hook"],
		};
	}

	get boxRound() {
		return {
			topLeft: this.#symbols["boxRound.topLeft"],
			topRight: this.#symbols["boxRound.topRight"],
			bottomLeft: this.#symbols["boxRound.bottomLeft"],
			bottomRight: this.#symbols["boxRound.bottomRight"],
			horizontal: this.#symbols["boxRound.horizontal"],
			vertical: this.#symbols["boxRound.vertical"],
			// Junctions have no rounded Unicode variant, so a rounded box reuses the
			// sharp tee/cross glyphs. Sourcing them from the boxSharp.* tokens keeps a
			// theme's `boxSharp.tee*` overrides effective for rounded-box dividers.
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	get boxSharp() {
		return {
			topLeft: this.#symbols["boxSharp.topLeft"],
			topRight: this.#symbols["boxSharp.topRight"],
			bottomLeft: this.#symbols["boxSharp.bottomLeft"],
			bottomRight: this.#symbols["boxSharp.bottomRight"],
			horizontal: this.#symbols["boxSharp.horizontal"],
			vertical: this.#symbols["boxSharp.vertical"],
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	get sep() {
		return {
			powerline: this.#symbols["sep.powerline"],
			powerlineThin: this.#symbols["sep.powerlineThin"],
			powerlineLeft: this.#symbols["sep.powerlineLeft"],
			powerlineRight: this.#symbols["sep.powerlineRight"],
			powerlineThinLeft: this.#symbols["sep.powerlineThinLeft"],
			powerlineThinRight: this.#symbols["sep.powerlineThinRight"],
			block: this.#symbols["sep.block"],
			space: this.#symbols["sep.space"],
			asciiLeft: this.#symbols["sep.asciiLeft"],
			asciiRight: this.#symbols["sep.asciiRight"],
			dot: this.#symbols["sep.dot"],
			slash: this.#symbols["sep.slash"],
			pipe: this.#symbols["sep.pipe"],
		};
	}

	get icon() {
		return {
			model: this.#symbols["icon.model"],
			plan: this.#symbols["icon.plan"],
			prewalk: this.#symbols["icon.prewalk"],
			goal: this.#symbols["icon.goal"],
			pause: this.#symbols["icon.pause"],
			loop: this.#symbols["icon.loop"],
			folder: this.#symbols["icon.folder"],
			worktree: this.#symbols["icon.worktree"],
			scratchFolder: this.#symbols["icon.scratchFolder"],
			file: this.#symbols["icon.file"],
			git: this.#symbols["icon.git"],
			branch: this.#symbols["icon.branch"],
			pr: this.#symbols["icon.pr"],
			tokens: this.#symbols["icon.tokens"],
			context: this.#symbols["icon.context"],
			cost: this.#symbols["icon.cost"],
			time: this.#symbols["icon.time"],
			pi: this.#symbols["icon.pi"],
			ghost: this.#symbols["icon.ghost"],
			agents: this.#symbols["icon.agents"],
			job: this.#symbols["icon.job"],
			cache: this.#symbols["icon.cache"],
			cacheMiss: this.#symbols["icon.cacheMiss"],
			input: this.#symbols["icon.input"],
			output: this.#symbols["icon.output"],
			throughput: this.#symbols["icon.throughput"],
			host: this.#symbols["icon.host"],
			session: this.#symbols["icon.session"],
			package: this.#symbols["icon.package"],
			warning: this.#symbols["icon.warning"],
			rewind: this.#symbols["icon.rewind"],
			auto: this.#symbols["icon.auto"],
			fast: this.#symbols["icon.fast"],
			extensionSkill: this.#symbols["icon.extensionSkill"],
			extensionTool: this.#symbols["icon.extensionTool"],
			extensionSlashCommand: this.#symbols["icon.extensionSlashCommand"],
			extensionMcp: this.#symbols["icon.extensionMcp"],
			extensionRule: this.#symbols["icon.extensionRule"],
			extensionHook: this.#symbols["icon.extensionHook"],
			extensionPrompt: this.#symbols["icon.extensionPrompt"],
			extensionContextFile: this.#symbols["icon.extensionContextFile"],
			extensionInstruction: this.#symbols["icon.extensionInstruction"],
			mic: this.#symbols["icon.mic"],
			camera: this.#symbols["icon.camera"],
		};
	}

	get thinking() {
		return {
			minimal: this.#symbols["thinking.minimal"],
			low: this.#symbols["thinking.low"],
			medium: this.#symbols["thinking.medium"],
			high: this.#symbols["thinking.high"],
			xhigh: this.#symbols["thinking.xhigh"],
			max: this.#symbols["thinking.max"],
			autoPending: this.#symbols["thinking.autoPending"],
		};
	}

	get checkbox() {
		return {
			checked: this.#symbols["checkbox.checked"],
			unchecked: this.#symbols["checkbox.unchecked"],
		};
	}

	get radio() {
		return {
			selected: this.#symbols["radio.selected"],
			unselected: this.#symbols["radio.unselected"],
		};
	}

	get format() {
		return {
			bullet: this.#symbols["format.bullet"],
			dash: this.#symbols["format.dash"],
			bracketLeft: this.#symbols["format.bracketLeft"],
			bracketRight: this.#symbols["format.bracketRight"],
		};
	}

	get md() {
		return {
			quoteBorder: this.#symbols["md.quoteBorder"],
			hrChar: this.#symbols["md.hrChar"],
			bullet: this.#symbols["md.bullet"],
			colorSwatch: this.#symbols["md.colorSwatch"],
		};
	}

	/**
	 * Default spinner frames (status spinner).
	 */
	get spinnerFrames(): string[] {
		return this.getSpinnerFrames();
	}

	/**
	 * Get spinner frames by type.
	 */
	getSpinnerFrames(type: SpinnerType = "status"): string[] {
		return this.#spinnerFramesOverrides[type] ?? SPINNER_FRAMES[this.symbolPreset][type];
	}

	/**
	 * Get language icon for a language name.
	 * Maps common language names to their corresponding symbol keys.
	 */
	getLangIcon(lang: string | undefined): string {
		if (!lang) return this.#symbols["lang.default"];
		const normalized = lang.toLowerCase();
		const key = langMap[normalized];
		return key ? this.#symbols[key] : this.#symbols["lang.default"];
	}

	/**
	 * Language icon tinted with the language's brand color (see
	 * {@link LANG_BRAND_COLORS}). Falls back to the muted theme color for
	 * languages without a brand entry, and returns the bare (possibly empty)
	 * icon when the active symbol preset has none.
	 */
	getLangIconStyled(lang: string | undefined): string {
		const icon = this.getLangIcon(lang);
		if (!icon) return icon;
		const key = lang ? langMap[lang.toLowerCase()] : undefined;
		const hex = key ? LANG_BRAND_COLORS[key] : undefined;
		if (!hex) return this.fg("muted", icon);
		return `${colorToAnsi(hex, this.mode)}${icon}\x1b[39m`;
	}
}
