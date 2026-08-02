/**
 * Bordered output container with optional header and sections.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { ImageProtocol, padding, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { isFullscreenViewport, recordBlockSummary } from "../tools/render-utils";
import { getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, Hasher, padToWidth, truncateToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
	/** Override the state-derived border color. Used for muted "legacy" tool
	 * frames that should not visually compete with framed-output tools. */
	borderColor?: ThemeColor;
}

const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

type BlockRow =
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string }
	| { kind: "blank" }
	| { kind: "content"; inner: string; origin: BlockRowOrigin }
	| { kind: "sixel"; raw: string; origin: BlockRowOrigin };

/**
 * Which source line produced an emitted row. Only content rows have one; the
 * header bar, section separators, and the bottom rule map to `undefined`.
 * Callers that need to hit-test a specific body line (the task block's agent
 * rows) read this instead of re-deriving the frame's wrapping arithmetic.
 */
export interface BlockRowOrigin {
	/** Index into the `sections` array passed to {@link renderOutputBlock}. */
	readonly section: number;
	/** Index into that section's `lines`, before any embedded-newline split. */
	readonly line: number;
}

function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

/**
 * Inner content width that {@link renderOutputBlock} wraps its body to, for a
 * given outer `width`: both vertical borders plus symmetric content padding.
 * An explicit left padding of zero keeps legacy flush blocks flush on both
 * sides unless a right padding is provided separately.
 *
 * The fullscreen viewport draws no borders, so there the two rule columns are
 * content. Callers pre-wrap against this, so it must agree with the frame.
 */
export function outputBlockContentWidth(
	width: number,
	contentPaddingLeft?: number,
	contentPaddingRight?: number,
): number {
	const left = normalizeContentPaddingLeft(contentPaddingLeft);
	const right = normalizeContentPaddingLeft(contentPaddingRight ?? left);
	return Math.max(1, width - (isFullscreenViewport() ? 0 : 2) - left - right);
}

/**
 * Render the bordered block. When `origins` is supplied it is filled with one
 * entry per emitted row, so a caller can map a body line it authored back to
 * the frame row it landed on after wrapping.
 */
export function renderOutputBlock(
	options: OutputBlockOptions,
	theme: Theme,
	origins?: (BlockRowOrigin | undefined)[],
): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	// A self-framing block's title bar is its identity row. Reported for the
	// collapsed one-line card; a header built by `renderStatusLine` has already
	// reported itself and wins, so this only covers plain-string headers.
	if (header !== undefined) recordBlockSummary(headerMeta ? `${header} ${headerMeta}` : header);
	// Fullscreen marks boundaries with fills, and the card this block sits in
	// already draws them, so the frame collapses to its label rows.
	const flat = isFullscreenViewport();
	const h = theme.boxRound.horizontal;
	const v = flat ? "" : theme.boxRound.vertical;
	const cap = h.repeat(3);
	const lineWidth = Math.max(0, width);
	// Border colors: running/pending use accent, success uses dim (gray), error/warning keep their colors
	const borderColor: ThemeColor =
		options.borderColor ??
		(state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim");
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		// The card around this block already paints the surface, and it paints
		// every row including its own padding. A state tint here would cover only
		// the rows this function emits, so the card's blank rows above and below
		// would stay panel-coloured while the body went a different shade — the
		// block reading as a darker box nested inside a lighter one. State is
		// carried by the status icon, the header colour and the text, exactly as
		// it already is for a settled block.
		if (!state || !applyBg || flat) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		// Keep block background stable even if inner content contains SGR resets (e.g. "\x1b[0m"),
		// which would otherwise clear the outer background mid-line.
		return (text: string) => {
			const stabilized = text
				.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`)
				.replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`);
			return `${bgAnsi}${stabilized}\x1b[49m`;
		};
	})();

	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
	const contentPaddingRight = normalizeContentPaddingLeft(options.contentPaddingRight ?? contentPaddingLeft);
	const contentWidth = Math.max(
		0,
		lineWidth - visibleWidth(v) - contentPaddingLeft - contentPaddingRight - visibleWidth(v),
	);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";
	const contentRightPadding = contentPaddingRight > 0 ? padding(contentPaddingRight) : "";

	// ── Layout pass: collect row descriptors before emitting the bordered lines. ──
	const rows: BlockRow[] = [];
	// A headerless top rule is pure decoration, so it goes away entirely without
	// a frame to anchor it; a titled one survives as its label.
	if (!flat || header !== undefined || headerMeta !== undefined) {
		rows.push({
			kind: "bar",
			leftChar: theme.boxRound.topLeft,
			rightChar: theme.boxRound.topRight,
			label: header,
			meta: headerMeta,
		});
	}

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		// A labeled section always draws its titled separator bar. A label-less
		// section can still request a plain divider via `separator`, but only
		// between sections — leading with one would just double the header bar.
		// Without rules the break is carried by a blank row instead.
		if (section.label) {
			if (flat && rows.length > 0) rows.push({ kind: "blank" });
			rows.push({
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
				label: section.label,
			});
		} else if (section.separator && sectionIndex > 0) {
			rows.push(
				flat
					? { kind: "blank" }
					: {
							kind: "bar",
							leftChar: theme.boxRound.teeRight,
							rightChar: theme.boxRound.teeLeft,
						},
			);
		}
		// Embedded newlines split a caller line into several, so carry the
		// pre-split index alongside: origins are reported in the caller's own
		// coordinates (index into `section.lines`), not the split ones.
		const allLines: string[] = [];
		const sourceLines: number[] = [];
		for (let i = 0; i < section.lines.length; i++) {
			for (const part of section.lines[i]!.split("\n")) {
				allLines.push(part);
				sourceLines.push(i);
			}
		}
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			const origin: BlockRowOrigin = { section: sectionIndex, line: sourceLines[lineIndex]! };
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line, origin });
				continue;
			}
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, contentWidth - visibleWidth(wrappedLine)));
				rows.push({ kind: "content", inner: `${wrappedLine}${innerPadding}`, origin });
			}
		}
	}

	// The card's own trailing fill row terminates the block when there is no rule.
	if (!flat) rows.push({ kind: "bottom", leftChar: theme.boxRound.bottomLeft, rightChar: theme.boxRound.bottomRight });

	const H = rows.length;

	const renderBar = (row: { leftChar: string; rightChar: string; label?: string; meta?: string }): string => {
		const leftGlyphs = flat ? contentLeftPadding : `${row.leftChar}${cap}`;
		const rightGlyph = flat ? "" : row.rightChar;
		if (lineWidth <= 0) return flat ? "" : border(leftGlyphs) + border(rightGlyph);
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		if (!labelText) {
			if (flat) return "";
			// No header: draw a clean, continuous top/separator bar (no 1-col gap).
			const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
			return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
		}
		const rawLabel = flat ? labelText : ` ${labelText} `;
		const leftWidth = visibleWidth(leftGlyphs);
		const rightWidth = visibleWidth(rightGlyph);
		const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
		if (flat) return `${leftGlyphs}${trimmedLabel}`;
		return `${border(leftGlyphs)}${trimmedLabel}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
	};

	const renderBottom = (row: { leftChar: string; rightChar: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const rail = flat ? "" : border(v);
	const renderContent = (inner: string): string => `${rail}${contentLeftPadding}${inner}${contentRightPadding}${rail}`;

	const lines: string[] = [];
	if (origins) origins.length = 0;
	for (let r = 0; r < H; r++) {
		const row = rows[r]!;
		origins?.push(row.kind === "content" || row.kind === "sixel" ? row.origin : undefined);
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const line =
			row.kind === "blank"
				? ""
				: row.kind === "bar"
					? renderBar(row)
					: row.kind === "bottom"
						? renderBottom(row)
						: renderContent(row.inner);
		lines.push(padToWidth(line, lineWidth, bgFn));
	}

	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;
	#origins: (BlockRowOrigin | undefined)[] | undefined;

	/**
	 * `trackRowOrigins` turns on {@link rowOrigins}. Off by default: only blocks
	 * that hit-test their own body rows pay for the per-row bookkeeping.
	 */
	constructor(trackRowOrigins = false) {
		if (trackRowOrigins) this.#origins = [];
	}

	/** Source line behind each row of the last render, empty unless tracking is on. */
	get rowOrigins(): readonly (BlockRowOrigin | undefined)[] {
		return this.#origins ?? [];
	}

	/** Render with caching. Returns the cached (shared, caller-immutable) lines if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): readonly string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme, this.#origins);
		this.#cache = { key, lines };
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.u32(normalizeContentPaddingLeft(options.contentPaddingLeft));
		h.u32(
			normalizeContentPaddingLeft(
				options.contentPaddingRight ?? normalizeContentPaddingLeft(options.contentPaddingLeft),
			),
		);
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.optional(options.borderColor);
		h.bool(options.applyBg ?? true);
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.bool(s.separator ?? false);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}

/**
 * Build a self-framing tool component backed by a cached output block. The
 * `build` callback returns the block options for a given width; the cache
 * dedupes re-renders. Pass `borderColor: "borderMuted"` for the dim "legacy"
 * look that does not compete with the state-colored framed tools.
 */
export function framedBlock(theme: Theme, build: (width: number) => OutputBlockOptions): Component {
	const block = new CachedOutputBlock();
	// Marked so the tool-execution container treats it as self-framing (renders
	// flush, no extra padding/background) the same way `markFramedBlockComponent`
	// blocks are treated.
	return markFramedBlockComponent({
		render: (width: number): readonly string[] => block.render(build(width), theme),
		invalidate: () => block.invalidate(),
	});
}
