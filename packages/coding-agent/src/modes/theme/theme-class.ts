import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import { adjustHsv, colorLuma, hexToRgb, logger, relativeLuminance, rgbToHex } from "@oh-my-pi/pi-utils";
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
 * Minimum luma separation (0..1) at which one background reads as a different
 * surface from another. Below this a hovered row just looks like the page; much
 * above it the row reads as a hard selection bar rather than a hover hint.
 */
const HOVER_WASH_MIN_DELTA = 0.035;

/** Per-channel step for surfaces with no headroom left for a value multiplier. */
const HOVER_WASH_FALLBACK_STEP = 20;

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
 * Push a surface color away from itself: brighter on dark themes, darker on light
 * ones. Moving away from the background rather than always darkening is what keeps
 * the wash visible in both appearances.
 */
function washAwayFromSurface(hex: string, isLight: boolean): string {
	const from = colorLuma(hex) ?? 0;
	const scaled = adjustHsv(hex, { v: isLight ? 0.9 : 1.7 });
	if (Math.abs((colorLuma(scaled) ?? from) - from) >= HOVER_WASH_MIN_DELTA) return scaled;
	// A near-black surface has no value left to multiply and a clipped-white one has
	// no room left to grow, so step the channels instead of scaling them.
	const step = isLight ? -HOVER_WASH_FALLBACK_STEP : HOVER_WASH_FALLBACK_STEP;
	const rgb = hexToRgb(hex);
	return rgbToHex({ r: rgb.r + step, g: rgb.g + step, b: rgb.b + step });
}

/**
 * Background marking the hovered interactive row, derived rather than declared.
 *
 * Every theme predates mouse support, and user themes sit on disk unversioned, so
 * asking for a new key would leave those themes with no hover color at all. Instead
 * reuse `selectedBg`, which is already the "this row is picked" surface that select
 * lists and the settings list paint hover with, so hover looks the same everywhere.
 * Themes that set `selectedBg` equal to their own surface (several do) would render
 * an invisible wash, so those nudge the surface itself instead.
 *
 * Undefined when the theme leaves both background roles at the terminal default: it
 * has told us nothing about its surface, and a guessed wash would fight the real one.
 */
function deriveHoverBg(bgColors: Record<ThemeBg, string | number>, isLight: boolean): string | undefined {
	if (bgColors.selectedBg === "" && bgColors.statusLineBg === "") return undefined;
	const surface = resolveBgToHex(bgColors.statusLineBg, isLight);
	const selected = resolveBgToHex(bgColors.selectedBg, isLight);
	const surfaceLuma = colorLuma(surface);
	const selectedLuma = colorLuma(selected);
	if (selectedLuma !== undefined) {
		const separation = surfaceLuma === undefined ? Infinity : Math.abs(selectedLuma - surfaceLuma);
		if (separation >= HOVER_WASH_MIN_DELTA) return selected;
	}
	return washAwayFromSurface(surface, isLight);
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
	 * Background escape for the hovered interactive row, or undefined when the theme
	 * declines to paint backgrounds at all. Derived once at construction because it
	 * depends only on the theme's own colors.
	 */
	readonly #hoverBgAnsi: string | undefined;
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
		const hoverBgHex = deriveHoverBg(bgColors, slIsLight);
		this.#hoverBgAnsi = hoverBgHex === undefined ? undefined : bgAnsi(hoverBgHex, mode);
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
	 * Background wash marking the row the pointer is over.
	 *
	 * Derived from the theme's own colors instead of a dedicated key: every theme was
	 * written before mouse support, and user themes live unversioned in the themes
	 * directory, so a new key would leave all of them with no hover color at all. See
	 * {@link deriveHoverBg} for the derivation. Themes that paint no backgrounds get
	 * the text back untouched rather than a guessed wash.
	 */
	hoverBg(text: string): string {
		if (this.#hoverBgAnsi === undefined) return text;
		return `${this.#hoverBgAnsi}${text}\x1b[49m`; // Reset only background color
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
