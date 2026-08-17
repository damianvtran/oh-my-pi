/**
 * Shared utilities and constants for tool renderers.
 *
 * Provides consistent formatting, truncation, and display patterns across all
 * tool renderers to ensure a unified TUI experience.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Ellipsis } from "@oh-my-pi/pi-natives";
import type { Component, HitZoneProvider, HitZoneSink } from "@oh-my-pi/pi-tui";
import { getKeybindings, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { pluralize } from "@oh-my-pi/pi-utils";
import { formatKeyHints, type KeyId } from "../config/keybindings";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import type { Theme } from "../modes/theme/theme";
import { Hasher } from "../tui/utils";
import { formatDimensionNote, type ResizedImage } from "../utils/image-resize";

export { Ellipsis } from "@oh-my-pi/pi-natives";
export { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

// =============================================================================
// Standardized Display Constants
// =============================================================================

/** Resolve inline image dimension caps from settings and viewport. */
export function resolveImageOptions(): { maxWidthCells: number; maxHeightCells?: number } {
	const activeSettings = isSettingsInitialized() ? settings : undefined;
	const maxWidthCells = activeSettings?.get("tui.maxInlineImageColumns") ?? getDefault("tui.maxInlineImageColumns");
	const rowSetting = Math.max(
		0,
		activeSettings?.get("tui.maxInlineImageRows") ?? getDefault("tui.maxInlineImageRows"),
	);
	const viewportRows = process.stdout.rows;
	const viewportFraction = viewportRows ? Math.floor(viewportRows * 0.6) : 0;
	let maxHeightCells: number | undefined;
	if (rowSetting === 0) {
		// No explicit cap — use viewport fraction as safety bound
		maxHeightCells = viewportFraction || undefined;
	} else if (viewportFraction > 0) {
		maxHeightCells = Math.min(rowSetting, viewportFraction);
	} else {
		// Viewport size unknown (transitional state) — honor explicit setting
		maxHeightCells = rowSetting;
	}
	return { maxWidthCells, maxHeightCells };
}

/** Preview limits for collapsed/expanded views */
export const PREVIEW_LIMITS = {
	/** Lines shown in collapsed view */
	COLLAPSED_LINES: 3,
	/** Lines shown in expanded view */
	EXPANDED_LINES: 12,
	/** Items (files, results) shown in collapsed view */
	COLLAPSED_ITEMS: 8,
	/** Output preview lines in collapsed view */
	OUTPUT_COLLAPSED: 3,
	/** Output preview lines in expanded view */
	OUTPUT_EXPANDED: 10,
	/** Computer script lines shown in collapsed view */
	COMPUTER_CODE_COLLAPSED: 10,
	/**
	 * Output lines kept for a settled tool call in the fullscreen viewport,
	 * where one click on the header restores the rest. A completed call is
	 * history: its header already carries the outcome, so the collapsed form
	 * is a single line of evidence rather than a paragraph.
	 */
	OUTPUT_SETTLED: 1,
	/** Max hunks shown when collapsed (edit tool) */
	DIFF_COLLAPSED_HUNKS: 8,
	/** Max diff lines shown when collapsed (edit tool) */
	DIFF_COLLAPSED_LINES: 40,
} as const;

/** Default number of terminal output rows shown before expansion. */
export const DEFAULT_TERMINAL_PREVIEW_LINES = 10;

/** Truncation lengths for different content types */
export const TRUNCATE_LENGTHS = {
	/** Short titles, labels */
	TITLE: 60,
	/** Medium-length content (messages, previews) */
	CONTENT: 80,
	/** Longer content (code, explanations) */
	LONG: 100,
	/** Full line content */
	LINE: 110,
	/** Very short (task previews, badges) */
	SHORT: 40,
	/** Idle recap status line (~40-word LLM reply) */
	RECAP: 280,
} as const;

/** Keybinding action that toggles tool-output expansion. */
const EXPAND_ACTION = "app.tools.expand";
/** Fallback key when no binding is resolvable (e.g. outside an interactive session). */
const DEFAULT_EXPAND_KEY: KeyId = "ctrl+o";

/** Human-readable key currently bound to tool-output expansion, e.g. `Ctrl+O`. */
export function expandKeyHint(): string {
	const keys = getKeybindings().getKeys(EXPAND_ACTION);
	return formatKeyHints(keys.length > 0 ? keys : [DEFAULT_EXPAND_KEY]);
}

/**
 * Whether the transcript is painting into the fullscreen viewport, where a
 * collapsed block is opened by clicking its header instead of by the bulk
 * keybinding. Read from the setting rather than the live `TUI` because tool
 * renderers are pure formatters with no engine handle; `toggleViewportMode`
 * persists the runtime choice here, so the setting is always current.
 */
export function isFullscreenViewport(): boolean {
	const activeSettings = isSettingsInitialized() ? settings : undefined;
	return (activeSettings?.get("tui.viewport") ?? getDefault("tui.viewport")) === "fullscreen";
}

/**
 * Ambient record of what the current render hid and what identifies it.
 *
 * Two facts a transcript block needs are only discoverable deep inside
 * whichever of the ~30 tool renderers drew it, none of which can see the
 * enclosing component: whether the collapsed form omitted anything (which is
 * what makes the block worth clicking), and the one line that identifies the
 * call (which is all a collapsed card shows in the fullscreen viewport).
 * Rather than widen every renderer signature, or grow a second per-tool
 * summary system beside the titles renderers already build, the few shared
 * helpers every renderer funnels those through report into a probe the block
 * installs around its own render.
 */
interface RenderProbe {
	overflow: boolean;
	/** First reported identity line. A renderer draws its title before any
	 *  detail row that reuses the same helper, so first wins. */
	summary: string | undefined;
}

let renderProbe: RenderProbe | undefined;

/** Report that the current render omitted content the expanded form would show. */
export function recordCollapsedOverflow(): void {
	if (renderProbe) renderProbe.overflow = true;
}

/** Report the one line that identifies the block being rendered. */
export function recordBlockSummary(summary: string): void {
	if (renderProbe === undefined || renderProbe.summary !== undefined) return;
	if (summary.trim().length === 0) return;
	renderProbe.summary = summary;
}

/**
 * Run `render` with a probe installed and report what it hid and what it calls
 * itself. Nested probes propagate outward: a block containing a collapsed
 * child also has something left to reveal, and an inner block's identity
 * stands in for an outer one that reported none.
 */
export function measureBlockRender<T>(render: () => T): { value: T; overflow: boolean; summary: string | undefined } {
	const outer = renderProbe;
	const probe: RenderProbe = { overflow: false, summary: undefined };
	renderProbe = probe;
	try {
		return { value: render(), overflow: probe.overflow, summary: probe.summary };
	} finally {
		renderProbe = outer;
		if (probe.overflow) recordCollapsedOverflow();
		if (probe.summary !== undefined) recordBlockSummary(probe.summary);
	}
}

// =============================================================================
// Text Truncation Utilities
// =============================================================================

/**
 * Get first N lines of text as preview, with each line truncated.
 */
export function getPreviewLines(text: string, maxLines: number, maxLineLen: number, ellipsis?: Ellipsis): string[] {
	const lines = text.split("\n").filter(l => l.trim());
	return lines.slice(0, maxLines).map(l => truncateToWidth(l.trim(), maxLineLen, ellipsis));
}

/**
 * Collapse a possibly multi-line string into a single line, then truncate it to
 * `maxWidth` display cells. {@link truncateToWidth} alone caps width but
 * newlines are zero-width, so multi-line content (markdown briefs, tool args,
 * provider errors) would otherwise spill a single status row across several
 * visual lines. Whitespace runs collapse to one space, so tabs are handled too.
 */
export function previewLine(text: string, maxWidth: number, ellipsis?: Ellipsis): string {
	return truncateToWidth(text.replace(/\s+/g, " ").trim(), maxWidth, ellipsis);
}

// =============================================================================
// URL Utilities
// =============================================================================

/**
 * Extract domain from URL, stripping www. prefix.
 */
export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

// =============================================================================
// Formatting Utilities
// =============================================================================

export { formatAge, formatBytes, formatCount, formatDuration, pluralize } from "@oh-my-pi/pi-utils";

// =============================================================================
// Theme Helper Utilities
// =============================================================================

/**
 * Get the appropriate status icon with color for a given state.
 * Standardizes status icon usage across all renderers.
 */
export function formatStatusIcon(status: ToolUIStatus, theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "success":
			return theme.styledSymbol("status.success", "success");
		case "done":
			return theme.styledSymbol("status.done", "success");
		case "error":
			return theme.styledSymbol("status.error", "error");
		case "warning":
			return theme.styledSymbol("status.warning", "warning");
		case "info":
			return theme.styledSymbol("status.info", "accent");
		case "pending":
			return theme.styledSymbol("status.pending", "muted");
		case "running":
			if (spinnerFrame !== undefined) {
				const frames = theme.spinnerFrames;
				return frames[spinnerFrame % frames.length];
			}
			return theme.styledSymbol("status.running", "accent");
		case "aborted":
			return theme.styledSymbol("status.aborted", "error");
	}
}

/**
 * Format the expand hint with proper theming, and record that this render hid
 * content (the hint is only emitted when something is actually hidden, which
 * makes it the single choke point every renderer already funnels through).
 * Returns empty string if already expanded or there is nothing more to show.
 *
 * In the fullscreen viewport the block's header is itself the control, so the
 * hint names the gesture; in append mode there is no pointer target and it
 * keeps naming the keybinding.
 */
export function formatExpandHint(theme: Theme, expanded?: boolean, hasMore?: boolean): string {
	if (expanded) return "";
	if (hasMore === false) return "";
	recordCollapsedOverflow();
	const label = isFullscreenViewport() ? "click to expand" : `${expandKeyHint()}: Expand`;
	return theme.interactiveHint(wrapBrackets(label, theme));
}

/**
 * Index just past the escape sequence starting at `i`: a CSI (styling) run
 * ends at its final byte, an OSC (hyperlink) run at BEL or ST.
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
 * Row on which a rendered block first draws something.
 *
 * Cards open with a padding row, and a state-tinted one is not plain
 * whitespace (it carries the background escape), so a `\S` test lands on it
 * instead of on the header. Blocks use this to place their header hit zone
 * without having to know their own padding.
 */
export function firstContentRow(lines: readonly string[]): number {
	for (let row = 0; row < lines.length; row++) {
		const line = lines[row]!;
		let i = 0;
		while (i < line.length) {
			if (line[i] === "\x1b") {
				i = skipEscape(line, i);
			} else if (line[i] === " ") {
				i++;
			} else {
				return row;
			}
		}
	}
	return -1;
}

/**
 * Repaint the first drawn column of an already-composed row.
 *
 * A card's accent rail belongs in the card's own first padding column: drawn
 * outside it, every other block on the surface would have to give up a column
 * to keep the same left edge. `replacement` has to be exactly one column wide,
 * and has to restore whatever it changed, because the row's background was
 * opened before this cell and must carry through to the end of the row.
 */
export function paintFirstColumn(row: string, replacement: string): string {
	let i = 0;
	while (i < row.length) {
		if (row[i] === "\x1b") {
			i = skipEscape(row, i);
			continue;
		}
		const cell = (row.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
		return row.slice(0, i) + replacement + row.slice(i + cell);
	}
	return row;
}

/**
 * Draw a collapsible block's header row: the hover wash while the pointer is
 * over it, and nothing else.
 *
 * There is deliberately NO disclosure triangle. A glyph in the gutter competes
 * with the tool's own status icon two columns away and reads as clutter at this
 * size; opencode does not draw one either. What signals that a block is
 * interactive is the hover fill plus the explicit "click to expand" hint, both
 * of which appear only on blocks that actually hide something.
 *
 * `wash` is off for a block that fills its own card on hover: the fill already
 * carries the pointer feedback across the block's whole height, and a second
 * background around this one row would end at the inner reset.
 */
export function decorateBlockHeader(
	row: string,
	options: { expanded: boolean; hovered: boolean; wash?: boolean },
	theme: Theme,
): string {
	return options.hovered && options.wash !== false ? theme.hoverBg(row) : row;
}

/**
 * Format a badge like [done] or [failed] with brackets and color.
 */
export function formatBadge(label: string, color: ToolUIColor, theme: Theme): string {
	const left = theme.format.bracketLeft;
	const right = theme.format.bracketRight;
	return theme.fg(color, `${left}${label}${right}`);
}

/**
 * Build a "more items" suffix line for truncated lists.
 * Uses consistent wording pattern.
 */
export function formatMoreItems(remaining: number, itemType: string): string {
	const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
	return `… ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

/**
 * Collapsed command/code previews render a tail window sized from the live
 * viewport: terminal rows minus a reserve for the rest of the block (frame,
 * Output section, stats line) and the editor/status area below the
 * transcript. This keeps a volatile streaming block from growing past the
 * viewport and stranding its top, while letting tall terminals show more.
 */
const PREVIEW_WINDOW_RESERVED_ROWS = 20;
/** Floor so tiny or unknown viewports still show a useful window. */
const PREVIEW_WINDOW_MIN_LINES = 6;
/** Assumed viewport when rows are unknown (non-TTY, tests). */
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

/** Tail-window height for collapsed command/code previews. */
export function previewWindowRows(): number {
	const rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS;
	return Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS);
}

/**
 * Cap a pre-rendered command preview to a viewport-sized tail window: the end
 * of the command stays visible (it is the live edge while args stream) behind
 * an "… N earlier lines" marker on top. The same window applies while
 * streaming and after completion so the block never jumps; only `expanded`
 * (ctrl+o) uncaps it.
 *
 * `prefix` (raw, e.g. a dim tree gutter) is prepended to the marker line so
 * nested previews stay aligned. `expandHint: false` drops the "ctrl+o: Expand"
 * suffix for callers that cap even inside the expanded view (task recent
 * output), where the hint would point the wrong way.
 */
export function capPreviewLines(
	lines: string[],
	theme: Theme,
	options: { max?: number; expanded?: boolean; prefix?: string; expandHint?: boolean } = {},
): string[] {
	const max = options.max ?? previewWindowRows();
	if (lines.length <= max) return lines;
	// Recorded before the expanded early-return, and even when the hint is
	// suppressed: the question is whether the COLLAPSED form hides lines, which
	// stays true while the block happens to be open. A block first rendered
	// expanded (created while a bulk expand was in force) would otherwise never
	// learn that it is collapsible.
	recordCollapsedOverflow();
	if (options.expanded) return lines;
	const visible = max <= 1 ? [] : lines.slice(lines.length - (max - 1));
	const hidden = lines.length - visible.length;
	const hint = options.expandHint === false ? "" : formatExpandHint(theme, false, true);
	const marker = `… ${hidden} earlier ${pluralize("line", hidden)}${hint ? ` ${hint}` : ""}`;
	return [`${options.prefix ?? ""}${theme.fg("dim", marker)}`, ...visible];
}

export function formatMeta(meta: string[], theme: Theme): string {
	return meta.length > 0 ? ` ${theme.fg("muted", meta.join(theme.sep.dot))}` : "";
}

function sanitizeErrorText(message: string | undefined): string {
	const clean = (message ?? "").replace(/^Error:\s*/, "").trim();
	return clean ? replaceTabs(truncateToWidth(clean, TRUNCATE_LENGTHS.LINE)) : "Unknown error";
}

export function formatErrorMessage(message: string | undefined, theme: Theme): string {
	const line = `${theme.styledSymbol("status.error", "error")} ${theme.fg("error", `Error: ${sanitizeErrorText(message)}`)}`;
	// A renderer that fails hard prints this instead of its usual title row, so
	// it is the only thing left that identifies the block. A collapsed card must
	// still show that the call failed without being expanded.
	recordBlockSummary(line);
	return line;
}

/**
 * Error message rendered as a subordinate detail line beneath a status header
 * that already carries the error icon (e.g. `✘ Write: <path>`). The header's
 * icon already signals failure, so this omits the redundant error symbol and
 * "Error:" prefix that `formatErrorMessage` adds for standalone single-line
 * errors, indenting two columns to sit under the header title instead.
 */
export function formatErrorDetail(message: string | undefined, theme: Theme): string {
	return `  ${theme.fg("error", sanitizeErrorText(message))}`;
}

export function formatEmptyMessage(message: string, theme: Theme): string {
	return `${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", message)}`;
}

// =============================================================================
// Code Frame Formatting
// =============================================================================

export type CodeFrameMarker = "" | " " | "*" | "+" | "-" | ">";

export function formatCodeFrameLine(
	marker: CodeFrameMarker,
	lineNumber: string | number,
	content: string,
	lineNumberWidth: number,
): string {
	const markerText = marker.trim();
	const lineNumberText = String(lineNumber).trim();
	const gutterText = markerText && lineNumberText ? `${markerText}${lineNumberText}` : lineNumberText || markerText;
	return `${gutterText.padStart(lineNumberWidth + 1, " ")}│${content}`;
}

// =============================================================================
// Tool UI Helpers
// =============================================================================

export type ToolUIStatus = "success" | "done" | "error" | "warning" | "info" | "pending" | "running" | "aborted";
export type ToolUIColor = "success" | "error" | "warning" | "accent" | "muted";

export interface ToolUITitleOptions {
	bold?: boolean;
}

export function formatTitle(label: string, theme: Theme, options?: ToolUITitleOptions): string {
	const content = options?.bold === false ? label : theme.bold(label);
	return theme.fg("toolTitle", content);
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

interface ParsedDiagnostic {
	filePath: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	source?: string;
	message: string;
	code?: string;
}

function sanitizeDiagnosticDisplayText(text: string): string {
	return replaceTabs(text);
}

function getSeverityRank(severity: ParsedDiagnostic["severity"]): number {
	switch (severity) {
		case "error":
			return 0;
		case "warning":
			return 1;
		case "info":
			return 2;
		case "hint":
			return 3;
	}
}

function parseDiagnosticMessage(msg: string): ParsedDiagnostic | null {
	const match = msg.match(/^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+?)(?:\s+\(([^)]+)\))?$/);
	if (!match) return null;
	return {
		filePath: sanitizeDiagnosticDisplayText(match[1]),
		line: parseInt(match[2], 10),
		col: parseInt(match[3], 10),
		severity: match[4] as ParsedDiagnostic["severity"],
		source: match[5] ? sanitizeDiagnosticDisplayText(match[5]) : undefined,
		message: sanitizeDiagnosticDisplayText(match[6]),
		code: match[7] ? sanitizeDiagnosticDisplayText(match[7]) : undefined,
	};
}

export function formatDiagnostics(
	diag: { errored: boolean; summary: string; messages: string[] },
	expanded: boolean,
	theme: Theme,
	getLangIcon: (filePath: string) => string,
	options?: { title?: string },
): string {
	if (diag.messages.length === 0) return "";

	const byFile = new Map<string, ParsedDiagnostic[]>();
	const unparsed: string[] = [];

	for (const msg of diag.messages) {
		const parsed = parseDiagnosticMessage(msg);
		if (parsed) {
			const existing = byFile.get(parsed.filePath) ?? [];
			existing.push(parsed);
			byFile.set(parsed.filePath, existing);
		} else {
			unparsed.push(sanitizeDiagnosticDisplayText(msg));
		}
	}

	for (const diagnostics of byFile.values()) {
		diagnostics.sort((a, b) => {
			const severityCompare = getSeverityRank(a.severity) - getSeverityRank(b.severity);
			if (severityCompare !== 0) return severityCompare;
			if (a.line !== b.line) return a.line - b.line;
			if (a.col !== b.col) return a.col - b.col;
			return a.message.localeCompare(b.message);
		});
	}

	const headerIcon = diag.errored
		? theme.styledSymbol("status.error", "error")
		: theme.styledSymbol("status.warning", "warning");
	const summary = sanitizeDiagnosticDisplayText(diag.summary);
	const summaryTag = summary ? ` ${theme.fg("dim", `(${summary})`)}` : "";
	let output = `\n\n${headerIcon} ${theme.fg("toolTitle", options?.title ?? "Diagnostics")}${summaryTag}`;

	const maxDiags = expanded ? diag.messages.length : 5;
	let diagsShown = 0;

	const files = Array.from(byFile.entries());

	// Count total diagnostics for "... X more" calculation
	const totalParsedDiags = files.reduce((sum, [, diags]) => sum + diags.length, 0);
	const totalDiags = totalParsedDiags + unparsed.length;

	// Helper to check if this is the very last item in the tree
	const isTreeEnd = (fileIdx: number, diagIdx: number | null, unparsedIdx: number | null): boolean => {
		const willShowMore = totalDiags > diagsShown + 1;
		if (willShowMore) return false;

		if (unparsedIdx !== null) {
			return unparsedIdx === unparsed.length - 1;
		}
		if (diagIdx !== null) {
			const isLastDiagInFile = diagIdx === files[fileIdx][1].length - 1;
			const isLastFile = fileIdx === files.length - 1;
			return isLastDiagInFile && isLastFile && unparsed.length === 0;
		}
		// File node - never the tree end if it has diagnostics
		return false;
	};

	for (let fi = 0; fi < files.length && diagsShown < maxDiags; fi++) {
		const [filePath, diagnostics] = files[fi];
		// File is "last" only if no more files AND no unparsed AND we'll show all diags AND no "... X more"
		const remainingDiagsInFile = diagnostics.length;
		const remainingDiagsAfter = files.slice(fi + 1).reduce((sum, [, d]) => sum + d.length, 0) + unparsed.length;
		const willShowAllRemaining = diagsShown + remainingDiagsInFile + remainingDiagsAfter <= maxDiags;
		const isLastFileNode = fi === files.length - 1 && unparsed.length === 0 && willShowAllRemaining;
		const fileBranch = isLastFileNode ? theme.tree.last : theme.tree.branch;

		const fileIcon = theme.fg("muted", getLangIcon(filePath));
		output += `\n ${theme.fg("dim", fileBranch)} ${fileIcon} ${theme.fg("accent", filePath)}`;

		for (let di = 0; di < diagnostics.length && diagsShown < maxDiags; di++) {
			const d = diagnostics[di];
			const isLastDiagInFile = di === diagnostics.length - 1;
			// This is the last visible diag in file if it's actually last OR we're about to hit the limit
			const atDisplayLimit = diagsShown + 1 >= maxDiags;
			const isLastVisibleInFile = isLastDiagInFile || atDisplayLimit;
			// Check if this is the last visible item in the entire tree
			const isVeryLast = isTreeEnd(fi, di, null);
			const diagBranch = isLastFileNode
				? isLastVisibleInFile || isVeryLast
					? `  ${theme.tree.last}`
					: `  ${theme.tree.branch}`
				: isLastVisibleInFile || isVeryLast
					? `${theme.tree.vertical} ${theme.tree.last}`
					: `${theme.tree.vertical} ${theme.tree.branch}`;

			const sevIcon =
				d.severity === "error"
					? theme.styledSymbol("status.error", "error")
					: d.severity === "warning"
						? theme.styledSymbol("status.warning", "warning")
						: theme.styledSymbol("status.info", "muted");
			const location = theme.fg("dim", `:${d.line}:${d.col}`);
			const codeTag = d.code ? theme.fg("dim", ` (${d.code})`) : "";
			const msgColor = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "toolOutput";

			output += `\n ${theme.fg("dim", diagBranch)} ${sevIcon}${location} ${theme.fg(msgColor, d.message)}${codeTag}`;
			diagsShown++;
		}
	}

	for (let ui = 0; ui < unparsed.length && diagsShown < maxDiags; ui++) {
		const msg = unparsed[ui];
		const isVeryLast = isTreeEnd(-1, null, ui);
		const branch = isVeryLast ? theme.tree.last : theme.tree.branch;
		const color = msg.includes("[error]") ? "error" : msg.includes("[warning]") ? "warning" : "dim";
		output += `\n ${theme.fg("dim", branch)} ${theme.fg(color, msg)}`;
		diagsShown++;
	}

	if (totalDiags > diagsShown) {
		const remaining = totalDiags - diagsShown;
		output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
			"muted",
			`… ${remaining} more`,
		)} ${formatExpandHint(theme)}`;
	}

	return output;
}

// =============================================================================
// Diff Utilities
// =============================================================================

export interface DiffStats {
	added: number;
	removed: number;
	hunks: number;
	lines: number;
}

export function getDiffStats(diffText: string): DiffStats {
	const lines = diffText ? diffText.split("\n") : [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let inHunk = false;

	for (const line of lines) {
		const isAdded = line.startsWith("+");
		const isRemoved = line.startsWith("-");
		const isChange = isAdded || isRemoved;

		if (isAdded) added++;
		if (isRemoved) removed++;

		if (isChange && !inHunk) {
			hunks++;
			inHunk = true;
		} else if (!isChange) {
			inHunk = false;
		}
	}

	return { added, removed, hunks, lines: lines.length };
}

export function formatDiffStats(added: number, removed: number, hunks: number, theme: Theme): string {
	const parts: string[] = [];
	if (added > 0) parts.push(theme.fg("toolDiffAdded", `+${added}`));
	if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
	if (hunks > 0) parts.push(theme.fg("dim", `${hunks} hunk${hunks !== 1 ? "s" : ""}`));
	return parts.join(theme.fg("dim", " / "));
}

interface DiffSegment {
	lines: string[];
	isChange: boolean;
	isEllipsis: boolean;
}

function parseDiffSegments(lines: string[]): DiffSegment[] {
	const segments: DiffSegment[] = [];
	let current: DiffSegment | null = null;

	for (const line of lines) {
		const isChange = line.startsWith("+") || line.startsWith("-");
		const isEllipsis = line.trimStart().startsWith("...") || line.trim().length === 0;

		if (isEllipsis) {
			if (current) segments.push(current);
			segments.push({ lines: [line], isChange: false, isEllipsis: true });
			current = null;
		} else if (!current || current.isChange !== isChange) {
			if (current) segments.push(current);
			current = { lines: [line], isChange, isEllipsis: false };
		} else {
			current.lines.push(line);
		}
	}

	if (current) segments.push(current);
	return segments;
}

export function truncateDiffByHunk(
	diffText: string,
	maxHunks: number,
	maxLines: number,
	options?: { fromTail?: boolean },
): { text: string; hiddenHunks: number; hiddenLines: number } {
	if (options?.fromTail) {
		// Streaming previews want to track the tail of the diff as new hunks
		// arrive. Reversing the line buffer reuses the head-mode logic without
		// duplicating the segment-budget bookkeeping: hunk runs survive
		// reversal (a continuous `+`/`-` block stays contiguous) and so do the
		// per-line `+`/`-` markers, so getDiffStats yields identical counts.
		const reversed = (diffText ?? "").split("\n").reverse().join("\n");
		const result = truncateDiffByHunk(reversed, maxHunks, maxLines);
		return {
			text: result.text.split("\n").reverse().join("\n"),
			hiddenHunks: result.hiddenHunks,
			hiddenLines: result.hiddenLines,
		};
	}
	const lines = diffText ? diffText.split("\n") : [];
	const totalStats = getDiffStats(diffText);

	if (lines.length <= maxLines && totalStats.hunks <= maxHunks) {
		return { text: diffText, hiddenHunks: 0, hiddenLines: 0 };
	}

	const segments = parseDiffSegments(lines);

	const changeSegments = segments.filter(s => s.isChange);
	const changeLineCount = changeSegments.reduce((sum, s) => sum + s.lines.length, 0);

	if (changeLineCount > maxLines) {
		const kept: string[] = [];
		let keptHunks = 0;

		for (const seg of segments) {
			if (kept.length >= maxLines) break;
			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			const take = Math.min(seg.lines.length, maxLines - kept.length);
			for (let i = 0; i < take; i++) {
				kept.push(seg.lines[i]!);
			}
		}

		return {
			text: kept.join("\n"),
			hiddenHunks: Math.max(0, totalStats.hunks - keptHunks),
			hiddenLines: Math.max(0, lines.length - kept.length),
		};
	}

	const contextBudget = maxLines - changeLineCount;
	const contextSegments = segments.filter(s => !s.isChange);
	const totalContextLines = contextSegments.reduce((sum, s) => sum + s.lines.length, 0);

	const kept: string[] = [];
	let keptHunks = 0;
	let keptSourceLines = 0;

	if (totalContextLines <= contextBudget) {
		for (const seg of segments) {
			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			kept.push(...seg.lines);
			keptSourceLines += seg.lines.length;
		}
	} else {
		const contextRatio = totalContextLines > 0 ? contextBudget / totalContextLines : 0;
		let remainingContextBudget = contextBudget;

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];

			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
				kept.push(...seg.lines);
				keptSourceLines += seg.lines.length;
				continue;
			}
			if (remainingContextBudget <= 0) continue;

			const allowedLines = Math.min(
				remainingContextBudget,
				Math.max(1, Math.floor(seg.lines.length * contextRatio)),
			);
			const outputStart = kept.length;
			let sourceLinesAdded = 0;

			if (seg.isEllipsis || seg.lines.length <= allowedLines) {
				for (let j = 0; j < allowedLines; j++) {
					kept.push(seg.lines[j]!);
				}
				sourceLinesAdded = allowedLines;
			} else {
				const isBeforeChange = segments[i + 1]?.isChange;
				const isAfterChange = segments[i - 1]?.isChange;

				if (isBeforeChange && isAfterChange) {
					if (allowedLines >= 3) {
						const sourceBudget = allowedLines - 1;
						const firstCount = Math.ceil(sourceBudget / 2);
						const lastCount = sourceBudget - firstCount;
						kept.push(...seg.lines.slice(0, firstCount));
						kept.push("");
						if (lastCount > 0) kept.push(...seg.lines.slice(-lastCount));
						sourceLinesAdded = sourceBudget;
					} else {
						const firstCount = Math.ceil(allowedLines / 2);
						const lastCount = allowedLines - firstCount;
						kept.push(...seg.lines.slice(0, firstCount));
						if (lastCount > 0) kept.push(...seg.lines.slice(-lastCount));
						sourceLinesAdded = allowedLines;
					}
				} else if (isBeforeChange) {
					kept.push(...seg.lines.slice(-allowedLines));
					sourceLinesAdded = allowedLines;
				} else if (isAfterChange) {
					kept.push(...seg.lines.slice(0, allowedLines));
					sourceLinesAdded = allowedLines;
				} else {
					const take = Math.min(allowedLines, 2);
					kept.push(...seg.lines.slice(0, take));
					sourceLinesAdded = take;
				}
			}

			keptSourceLines += sourceLinesAdded;
			remainingContextBudget -= kept.length - outputStart;
		}
	}

	return {
		text: kept.join("\n"),
		hiddenHunks: Math.max(0, totalStats.hunks - keptHunks),
		hiddenLines: Math.max(0, lines.length - keptSourceLines),
	};
}

// =============================================================================
// Path Utilities
// =============================================================================

export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") {
		return "";
	}
	const home = homeDir ?? os.homedir();
	if (home && filePath.startsWith(home)) {
		const suffix = filePath.slice(home.length);
		if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
			return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
		}
	}
	return filePath;
}

export function formatToolWorkingDirectory(workdir: string | undefined, projectDir: string): string | undefined {
	if (!workdir) return undefined;
	const resolvedProjectDir = path.resolve(projectDir);
	const resolvedWorkdir = path.resolve(projectDir, workdir);
	if (resolvedWorkdir === resolvedProjectDir) {
		return undefined;
	}
	const relativePath = path.relative(resolvedProjectDir, resolvedWorkdir);
	const isWithinProject =
		relativePath.length > 0 && !relativePath.startsWith("..") && !relativePath.startsWith(`..${path.sep}`);
	const displayWorkdir = isWithinProject ? relativePath : shortenPath(resolvedWorkdir);
	return replaceTabs(displayWorkdir);
}

export function formatScreenshot(opts: {
	saveFullRes: boolean;
	savedMimeType: string;
	savedByteLength: number;
	dest: string;
	resized: ResizedImage;
}): string[] {
	const lines = ["Screenshot captured"];
	if (opts.saveFullRes) {
		lines.push(
			`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`,
		);
		lines.push(
			`Model: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`,
		);
	} else {
		lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB)`);
		lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
	}
	if (opts.resized.decodeFailed) {
		lines.push("Resize: image decoder failed; using original image bytes");
	}
	const dimensionNote = formatDimensionNote(opts.resized);
	if (dimensionNote) {
		lines.push(dimensionNote);
	}
	return lines;
}

export function wrapBrackets(text: string, theme: Theme): string {
	return `${theme.format.bracketLeft}${text}${theme.format.bracketRight}`;
}

export const PARSE_ERRORS_LIMIT = 20;

export function dedupeParseErrors(errors: string[] | undefined): string[] {
	if (!errors || errors.length === 0) return [];
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const error of errors) {
		if (seen.has(error)) continue;
		seen.add(error);
		deduped.push(error);
	}
	return deduped;
}

export function formatParseErrors(errors: string[], total?: number): string[] {
	const deduped = dedupeParseErrors(errors);
	if (deduped.length === 0) return [];
	const fullCount = total ?? deduped.length;
	const capped = deduped.slice(0, PARSE_ERRORS_LIMIT);
	const header = fullCount > capped.length ? `Parse issues (${capped.length} / ${fullCount}):` : "Parse issues:";
	return [header, ...capped.map(err => `- ${err}`)];
}

/**
 * Cap an upstream parse-error list to {@link PARSE_ERRORS_LIMIT} unique entries,
 * preserving the original deduplicated total. Use this at the source so tool
 * details never carry thousands of per-file parse errors into traces or
 * renderers.
 */
export function capParseErrors(
	errors: string[] | undefined,
	limit: number = PARSE_ERRORS_LIMIT,
): { errors: string[]; total: number } {
	const deduped = dedupeParseErrors(errors);
	return { errors: deduped.slice(0, limit), total: deduped.length };
}

// =============================================================================
// Renderer helpers shared by search / find / ast tools
// =============================================================================

/**
 * Standard width+expand keyed render cache used by every search-style tool
 * renderer. `compute` re-runs only when the cache key changes. Horizontal
 * padding is also published as selection geometry so a card containing this
 * component composes both insets instead of copying one chrome cell.
 */
export function createCachedComponent(
	getExpanded: () => boolean,
	compute: (width: number, expanded: boolean) => string[],
	options: { paddingX?: number } = {},
): Component & HitZoneProvider {
	let cached: { key: bigint; lines: string[] } | undefined;
	const paddingX = Math.max(0, options.paddingX ?? 0);
	return {
		render(width: number): readonly string[] {
			const expanded = getExpanded();
			const key = new Hasher().bool(expanded).u32(width).digest();
			if (cached?.key === key) return cached.lines;
			const innerWidth = Math.max(1, width - paddingX * 2);
			const lines = compute(innerWidth, expanded);
			const pad = paddingX === 0 ? "" : " ".repeat(paddingX);
			const paddedLines = paddingX === 0 ? lines : lines.map(line => `${pad}${line}${pad}`);
			cached = { key, lines: paddedLines };
			return paddedLines;
		},
		publishHitZones(sink: HitZoneSink): void {
			sink.selectionInset(0, cached?.lines.length ?? 0, paddingX);
		},
		invalidate() {
			cached = undefined;
		},
	};
}

/**
 * Single-slot memo for an expensive rendered string (syntax highlighting, diff
 * coloring) keyed by the exact inputs that shape the bytes: theme instance,
 * expanded state, a caller-chosen salt (path/language), and the source content.
 * Field-wise comparison instead of a concatenated key string: a cache hit costs
 * one string value-compare (engines short-circuit on length) and a miss never
 * allocates a key. Comparing the {@link Theme} by reference is sound because
 * theme switches replace the instance wholesale (`setTheme`/`previewTheme`/
 * `setSymbolPreset` in modes/theme/theme.ts) — themes are never mutated in
 * place.
 */
export interface RenderedStringCache {
	theme: Theme | null;
	expanded: boolean;
	salt: string;
	content: string;
	value: string;
}

export function createRenderedStringCache(): RenderedStringCache {
	return { theme: null, expanded: false, salt: "", content: "", value: "" };
}

/** Drop the memo so the next lookup re-renders (e.g. the render function identity changed). */
export function invalidateRenderedStringCache(cache: RenderedStringCache): void {
	cache.theme = null;
}

export function cachedRenderedString(
	cache: RenderedStringCache | undefined,
	theme: Theme,
	expanded: boolean,
	salt: string,
	content: string,
	render: () => string,
): string {
	if (
		cache !== undefined &&
		cache.theme === theme &&
		cache.expanded === expanded &&
		cache.salt === salt &&
		cache.content === content
	) {
		return cache.value;
	}
	const value = render();
	if (cache !== undefined) {
		cache.theme = theme;
		cache.expanded = expanded;
		cache.salt = salt;
		cache.content = content;
		cache.value = value;
	}
	return value;
}

/**
 * Append the indented bullet list of parse errors (capped at
 * {@link PARSE_ERRORS_LIMIT}) to `lines`, with an overflow summary line if the
 * total exceeds the cap. No-op when `parseErrors` is empty.
 */
export function appendParseErrorsBulletList(
	lines: string[],
	parseErrors: readonly string[] | undefined,
	theme: Theme,
	total?: number,
): void {
	if (!parseErrors || parseErrors.length === 0) return;
	const fullCount = total ?? parseErrors.length;
	const capped = parseErrors.slice(0, PARSE_ERRORS_LIMIT);
	for (const err of capped) {
		lines.push(theme.fg("warning", `  - ${err}`));
	}
	if (fullCount > capped.length) {
		lines.push(theme.fg("dim", `  … ${fullCount - capped.length} more`));
	}
}

/**
 * Human-readable summary string for the parse-issues count, capped by
 * {@link PARSE_ERRORS_LIMIT}.
 */
export function formatParseErrorsCountLabel(parseErrors: readonly string[], total?: number): string {
	const fullCount = total ?? parseErrors.length;
	return fullCount > PARSE_ERRORS_LIMIT
		? `${PARSE_ERRORS_LIMIT} / ${fullCount} parse issues`
		: `${fullCount} parse issue${fullCount !== 1 ? "s" : ""}`;
}

// =============================================================================
// LSP Batching
// =============================================================================

const LSP_BATCH_TOOLS = new Set(["edit", "write"]);

export interface LspBatchRequest {
	id: string;
	flush: boolean;
}

export function getLspBatchRequest(toolCall: ToolCallContext | undefined): LspBatchRequest | undefined {
	if (!toolCall) {
		return undefined;
	}
	const hasOtherWrites = toolCall.toolCalls.some(
		(call, index) => index !== toolCall.index && LSP_BATCH_TOOLS.has(call.name),
	);
	if (!hasOtherWrites) {
		return undefined;
	}
	const hasLaterWrites = toolCall.toolCalls.slice(toolCall.index + 1).some(call => LSP_BATCH_TOOLS.has(call.name));
	return { id: toolCall.batchId, flush: !hasLaterWrites };
}
