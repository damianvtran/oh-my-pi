/**
 * The phone portal's palette, resolved from the host's own omp theme.
 *
 * `portal-ui.html` is styled entirely through CSS custom properties named after
 * omp's theme tokens, and ships with the built-in `dark`/`light` values baked in
 * so the file renders standalone (the render-function test suite loads it with no
 * server). This module produces the `<style>` block the portal injects to
 * override those defaults with whatever theme the machine is actually configured
 * to use, so the phone and the terminal are the same product rather than two
 * surfaces that merely resemble each other.
 *
 * Why resolve here instead of over the wire: the collab protocol carries session
 * state, not appearance, and it is shared with `collab-web`; adding a theme frame
 * for one guest implementation would be a protocol change for all of them. The
 * portal, by contrast, runs on the same machine as every session it serves, as
 * the same user, from the same binary — so it can read the same settings and the
 * same theme files the sessions do.
 *
 * ## The surface ladder
 *
 * omp's fullscreen viewport paints four flat, opaque surfaces derived from one
 * theme key rather than declared per theme (`deriveSurfaceLadder` in
 * `modes/theme/theme.ts`): the anchor is `statusLineBg`, and each rung steps
 * every RGB channel by +10 on a dark theme or -5 on a light one. That derivation
 * is duplicated here rather than imported because it is private to the theme
 * module, and because this file must keep working on a checkout where the
 * fullscreen viewport does not exist. The step constants are the load-bearing
 * part; if they ever diverge the phone's cards stop separating from its canvas
 * by the same amount the terminal's do.
 *
 * ## Freshness
 *
 * Resolved once per portal process. A theme switch therefore needs
 * `omp mobile restart`, which is the same lifetime as every other portal-level
 * decision (port, credential) and avoids re-reading theme JSON on every page
 * load for a value that changes a few times a year.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, Settings, settings } from "../config/settings";
import { getResolvedThemeColors, isLightTheme } from "../modes/theme/theme";

/**
 * Per-channel step between ladder rungs. Dark mirrors the terminal's
 * `SURFACE_STEP_DARK` exactly; light does NOT mirror `SURFACE_STEP_LIGHT`, and that
 * is the one deliberate numeric divergence in this file.
 *
 * The fills are the only boundary anywhere in this design — every border and rule is
 * gone, as in the fullscreen viewport — so the rung separation IS the card. At the
 * terminal's 5, a light palette measured 1.049:1 between canvas and panel, below the
 * 1.5:1 floor the theme module's own `SELECTION_MIN_CONTRAST` comment sets for "two
 * surfaces read as two surfaces", and a tool card was a rumour rather than a card.
 * A terminal gets away with it because it is a dark room; the phone is the one omp
 * surface used in daylight, where auto-brightness and True Tone compress exactly
 * this range. 14 puts canvas→overlay at 1.54:1 and canvas→panel at 1.145:1 — the
 * most the lightness axis gives without inventing a rule the terminal does not draw.
 */
const SURFACE_STEP_DARK = 10;
const SURFACE_STEP_LIGHT = 14;

/**
 * Theme tokens the portal renders, mapped to the CSS custom property that
 * carries them. Only tokens the stylesheet actually consumes are emitted: an
 * unused variable is 40 bytes on every page load and one more thing to keep
 * honest.
 *
 * The names deliberately match omp's token names (`--muted` is `muted`,
 * `--sl-path` is `statusLinePath`) so a rule in `portal-ui.html` can be read
 * against the TUI component it mirrors without a translation table.
 */
const TOKEN_VARS: Readonly<Record<string, string>> = {
	text: "--fg",
	muted: "--muted",
	dim: "--dim",
	accent: "--accent",
	success: "--success",
	error: "--error",
	warning: "--warning",
	borderMuted: "--border-muted",
	thinkingText: "--thinking",
	toolOutput: "--tool-output",
	toolDiffAdded: "--diff-add",
	toolDiffRemoved: "--diff-del",
	userMessageBg: "--user-bg",
	customMessageBg: "--custom-bg",
	mdLink: "--link",
	mdCode: "--code",
	mdCodeBlock: "--code-block",
	statusLineModel: "--sl-model",
	statusLinePath: "--sl-path",
	statusLineContext: "--sl-context",
	statusLineSep: "--sl-sep",
	statusLineSubagents: "--sl-agents",
	thinkingHigh: "--context-purple",
};

interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** `#rgb` and `#rrggbb`; anything else is rejected so a malformed theme falls back. */
function parseHex(value: string): Rgb | undefined {
	const hex = value.trim();
	if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return undefined;
	const body = hex.slice(1);
	const wide =
		body.length === 3
			? body
					.split("")
					.map(c => c + c)
					.join("")
			: body;
	return {
		r: Number.parseInt(wide.slice(0, 2), 16),
		g: Number.parseInt(wide.slice(2, 4), 16),
		b: Number.parseInt(wide.slice(4, 6), 16),
	};
}

function toHex({ r, g, b }: Rgb): string {
	const clamp = (v: number): string =>
		Math.max(0, Math.min(255, Math.round(v)))
			.toString(16)
			.padStart(2, "0");
	return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/** One ladder rung: every channel shifted by the same amount, then clamped. */
function stepChannels(base: Rgb, step: number): string {
	return toHex({ r: base.r + step, g: base.g + step, b: base.b + step });
}

/** Relative luminance, used only to sanity-check the ladder anchor. */
function luma({ r, g, b }: Rgb): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export interface PortalPalette {
	/** Theme name this palette came from. Read by the start-up log line. */
	name: string;
	/** CSS declarations (`--token: value;`) for one `:root`-level block. */
	declarations: string[];
}

/**
 * The four surface declarations for one theme, from its `statusLineBg` anchor.
 *
 * Exported for the tests: the anchor's rejection rules are the part of this module
 * that a wrong answer makes invisible rather than broken — a bad anchor still
 * produces four valid colours, just the wrong four — and they cannot be reached
 * through {@link portalThemeStyle} without writing a custom theme file into the
 * developer's `~/.omp`.
 *
 * `getResolvedThemeColors` substitutes the HTML-export default text colour for any
 * token the theme left at "terminal default" (`""`), which is right for every
 * foreground token and wrong for this one background: a theme that omits it would
 * hand us a near-white anchor to build a dark ladder from.
 *
 * That substitution is detected by its own two output values rather than inferred
 * from luminance. `getHtmlDefaultTextForSurface` returns exactly `#000000` or
 * `#e5e5e7`, and a luminance test only catches the case where the substituted value
 * DISAGREES with the mode: a theme that omits `statusLineBg` but whose export
 * surface is light gets `#000000`, which `isLightTheme` still classifies as dark
 * (`colorLuma("")` is undefined), so `luma 0 > 0.5 === false` matched and the whole
 * phone painted a pure-black ladder for a light theme. Neither sentinel is a
 * meaningful anchor anyway.
 *
 * A hex that survives both checks still has to agree with the theme's own mode: a
 * light anchor under a dark theme is a mis-declared token, not an intent, and
 * building a ladder from it would inverse the whole page.
 */
export function surfaceDeclarations(anchorHex: string, light: boolean): string[] {
	const hex = anchorHex.toLowerCase();
	const substituted = hex === "#000000" || hex === "#e5e5e7";
	const parsed = substituted ? undefined : parseHex(hex);
	// The built-in themes' own anchors, which is what makes the fallback invisible
	// on a stock install rather than a visible downgrade.
	const anchor = parsed && luma(parsed) > 0.5 === light ? parsed : parseHex(light ? "#e0e0e0" : "#121212");
	if (!anchor) return [];
	const step = light ? -SURFACE_STEP_LIGHT : SURFACE_STEP_DARK;
	return [
		`color-scheme: ${light ? "light" : "dark"};`,
		`--canvas: ${toHex(anchor)};`,
		`--panel: ${stepChannels(anchor, step)};`,
		`--element: ${stepChannels(anchor, step * 2)};`,
		`--overlay: ${stepChannels(anchor, step * 3)};`,
	];
}

/**
 * Resolve one theme name into portal CSS declarations.
 *
 * Returns `undefined` rather than throwing when the theme cannot be loaded: a
 * typo in `theme.dark`, or a custom theme file that was deleted, must leave the
 * phone on the stylesheet's built-in palette rather than on an unstyled page.
 */
async function paletteFor(name: string): Promise<PortalPalette | undefined> {
	let colors: Record<string, string>;
	try {
		colors = await getResolvedThemeColors(name);
	} catch (err) {
		logger.debug("mobile portal could not resolve a theme", { theme: name, error: String(err) });
		return undefined;
	}
	const light = isLightTheme(name);
	const declarations = surfaceDeclarations(colors.statusLineBg ?? "", light);
	// No anchor and no fallback means `parseHex` rejected a built-in constant, which
	// is a code defect rather than a theme problem — leave the page on its own
	// palette rather than emitting a ladder-less block whose tokens half-apply.
	if (!declarations.length) return undefined;
	for (const [token, cssVar] of Object.entries(TOKEN_VARS)) {
		const value = colors[token];
		/*
		 * A theme may omit an optional token (`thinkingMax` is the documented
		 * case); leaving the variable unset keeps the stylesheet's own default.
		 *
		 * `parseHex` is a validator here, not a conversion: this string is spliced
		 * into a `<style>` element on an authenticated surface that steers live
		 * agents, and the only guarantee upstream is `resolveVarRefs`' leading-`#`
		 * check — the settings schema puts no `pattern` behind it. `#000}` would
		 * close the `:root` block and drop every declaration after it, and
		 * `#000</style><script>` would close the element outright.
		 */
		if (value && parseHex(value)) declarations.push(`${cssVar}: ${value};`);
	}
	return { name, declarations };
}

/** Theme names the host is configured to use, in `[dark, light]` order. */
async function themeNames(): Promise<[string, string]> {
	/*
	 * A read, not an initialization. `Settings.init()` opens `agent.db`, runs
	 * legacy migration and seeds marker files, and installs a process-global
	 * singleton scoped to `process.cwd()` — which under launchd is launchd's
	 * directory, not a project. Nothing in the portal ever closes that handle, so
	 * this daemon would hold the database open for its whole lifetime to have read
	 * two strings once at start. `loadReadOnly` is documented for exactly this.
	 *
	 * The already-initialized singleton is preferred when one exists, so a host
	 * process that shares this module reads the same settings it is running on.
	 */
	try {
		const resolved = isSettingsInitialized() ? settings : await Settings.loadReadOnly();
		return [resolved.get("theme.dark") ?? "dark", resolved.get("theme.light") ?? "light"];
	} catch (err) {
		logger.debug("mobile portal could not read settings for theme resolution", { error: String(err) });
		return ["dark", "light"];
	}
}

/** What the portal resolved, for the log line and for `Portal.#themed`. */
export interface PortalThemeStyle {
	/** The `<style>` block, or `""` when neither theme could be resolved. */
	style: string;
	/** Theme names actually painted, `[dark, light]`, omitting any that failed. */
	resolved: string[];
}

/**
 * The `<style>` block the portal injects into every page it serves.
 *
 * Emitted after the stylesheet's own `:root` defaults and with the same selector
 * specificity, so later-wins ordering does the overriding — no `!important`, and
 * the defaults stay visible in the file as documentation of what the tokens mean.
 * The light block is duplicated under an explicit `[data-theme="light"]` and the
 * system media query for the same reason the base stylesheet does: `?theme=`
 * pins the palette, otherwise the OS decides.
 *
 * `names` exists for the tests: it lets them pin the built-in `dark`/`light`
 * palettes and assert literals, instead of asserting against whatever theme the
 * developer running the suite happens to have configured.
 */
export async function portalThemeStyle(names?: [string, string]): Promise<PortalThemeStyle> {
	const [darkName, lightName] = names ?? (await themeNames());
	const [dark, light] = await Promise.all([paletteFor(darkName), paletteFor(lightName)]);
	const resolved = [dark?.name, light?.name].filter((name): name is string => name !== undefined);
	if (!dark && !light) return { style: "", resolved };
	const blocks: string[] = [];
	if (dark) blocks.push(`:root{${dark.declarations.join("")}}`);
	if (light) {
		const body = light.declarations.join("");
		blocks.push(`[data-theme="light"]{${body}}`);
		blocks.push(`@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){${body}}}`);
	}
	return { style: `<style id="omp-theme">${blocks.join("")}</style>`, resolved };
}
