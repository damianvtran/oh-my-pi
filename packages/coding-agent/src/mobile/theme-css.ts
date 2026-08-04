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
 * Per-channel step between ladder rungs, mirroring `SURFACE_STEP_DARK` /
 * `SURFACE_STEP_LIGHT`. Dark themes step up (a card is lighter than its canvas),
 * light themes step down.
 */
const SURFACE_STEP_DARK = 10;
const SURFACE_STEP_LIGHT = 5;

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
	/** Theme name this palette came from, for the log line and the status header. */
	name: string;
	/** CSS declarations (`--token: value;`) for one `:root`-level block. */
	declarations: string[];
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
	/*
	 * `getResolvedThemeColors` substitutes the HTML-export default text colour
	 * for any token the theme left at "terminal default" (`""`), which is exactly
	 * right for every foreground token — and wrong for `statusLineBg`, the one
	 * background this palette needs, because a theme that omits it would hand us
	 * a near-white anchor to build a dark ladder from. The luminance test is the
	 * only signal left at this layer that the substitution happened, so it stands
	 * in for the theme module's own `statusLineBg === ""` check; a mismatch falls
	 * back to the built-in anchor for the matching mode.
	 */
	const anchorHex = colors.statusLineBg ?? "";
	const parsedAnchor = parseHex(anchorHex);
	const anchor =
		parsedAnchor && luma(parsedAnchor) > 0.5 === light ? parsedAnchor : parseHex(light ? "#e0e0e0" : "#121212");
	if (!anchor) return undefined;

	const step = light ? -SURFACE_STEP_LIGHT : SURFACE_STEP_DARK;
	const declarations = [
		`color-scheme: ${light ? "light" : "dark"};`,
		`--canvas: ${toHex(anchor)};`,
		`--panel: ${stepChannels(anchor, step)};`,
		`--element: ${stepChannels(anchor, step * 2)};`,
		`--overlay: ${stepChannels(anchor, step * 3)};`,
	];
	for (const [token, cssVar] of Object.entries(TOKEN_VARS)) {
		const value = colors[token];
		// A theme may omit an optional token (`thinkingMax` is the documented
		// case); leaving the variable unset keeps the stylesheet's own default.
		if (value) declarations.push(`${cssVar}: ${value};`);
	}
	return { name, declarations };
}

/** Theme names the host is configured to use, in `[dark, light]` order. */
async function themeNames(): Promise<[string, string]> {
	// The portal is a service, not a session: nothing has opened settings storage
	// in this process. Opening it here rather than in the CLI entry keeps the
	// dependency with the one feature that needs it, and the guard makes a
	// second call (or a test that pre-initialized) a no-op.
	if (!isSettingsInitialized()) {
		try {
			await Settings.init();
		} catch (err) {
			logger.debug("mobile portal could not open settings for theme resolution", { error: String(err) });
			return ["dark", "light"];
		}
	}
	return [settings.get("theme.dark") ?? "dark", settings.get("theme.light") ?? "light"];
}

/**
 * The `<style>` block the portal injects into every page it serves, or `""` when
 * neither configured theme could be resolved.
 *
 * Emitted after the stylesheet's own `:root` defaults and with the same selector
 * specificity, so later-wins ordering does the overriding — no `!important`, and
 * the defaults stay visible in the file as documentation of what the tokens mean.
 * The light block is duplicated under an explicit `[data-theme="light"]` and the
 * system media query for the same reason the base stylesheet does: `?theme=`
 * pins the palette, otherwise the OS decides.
 */
export async function portalThemeStyle(): Promise<string> {
	const [darkName, lightName] = await themeNames();
	const [dark, light] = await Promise.all([paletteFor(darkName), paletteFor(lightName)]);
	if (!dark && !light) return "";
	const blocks: string[] = [];
	if (dark) blocks.push(`:root{${dark.declarations.join("")}}`);
	if (light) {
		const body = light.declarations.join("");
		blocks.push(`[data-theme="light"]{${body}}`);
		blocks.push(`@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){${body}}}`);
	}
	return `<style id="omp-theme">${blocks.join("")}</style>`;
}
