/**
 * Shared rendering primitives for bash/eval execution components.
 *
 * Each helper isolates a piece of structure both components share verbatim
 * (frame layout, collapsed preview, post-run status line). Differences in
 * how each component prepares its header, output lines, or sixel masking
 * stay in their respective files.
 */

import { type Component, Container, Loader, Text, type TUI } from "@oh-my-pi/pi-tui";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import { formatTruncationMetaNotice, type TruncationMeta } from "../../tools/output-meta";
import { formatExpandHint, isFullscreenViewport } from "../../tools/render-utils";
import { DynamicBorder } from "./dynamic-border";
import { truncateToVisualLines } from "./visual-truncate";

export type ExecutionStatus = "running" | "complete" | "cancelled" | "error";

/** Theme color keys valid for an execution frame. */
export type ExecutionColorKey = "dim" | "bashMode" | "pythonMode";

/** Stable identity so a suppressed rule keeps its parent container's memo warm. */
const NO_ROWS: readonly string[] = [];

/**
 * Build the rule + content container + rule scaffold that bash and eval
 * execution components share. The caller appends the header (command vs `>>>`
 * prompt) and the returned loader to `contentContainer` so per-mode order is
 * preserved.
 *
 * The rules are append-mode chrome. In fullscreen the block is a filled card
 * and its fill IS its boundary, so a rule would be a second one drawn on top;
 * the rule components stay in the child list and render nothing, which keeps
 * the caller's header-row arithmetic (rows drawn above the content) correct in
 * both modes and lets a runtime viewport switch take effect on the next frame.
 */
export function buildExecutionFrame(
	parent: Container,
	ui: TUI,
	colorKey: ExecutionColorKey,
): { contentContainer: Container; loader: Loader } {
	const borderColor = (str: string) => theme.fg(colorKey, str);
	const rule = (): Component => {
		const border = new DynamicBorder(borderColor);
		return {
			render: (width: number) => (isFullscreenViewport() ? NO_ROWS : border.render(width)),
			invalidate: () => border.invalidate(),
		};
	};

	parent.addChild(rule());

	const contentContainer = new Container();
	parent.addChild(contentContainer);

	const loader = new Loader(
		ui,
		spinner => theme.fg(colorKey, spinner),
		text => theme.fg("muted", text),
		`Running… (esc to cancel)`,
		getSymbolTheme().spinnerFrames,
	);

	parent.addChild(rule());
	return { contentContainer, loader };
}

/**
 * Horizontal inset for an execution block's own rows. A fullscreen block sits
 * inside a card that already supplies the inset, so its rows sit flush against
 * the fill and every card in the transcript aligns on the same column.
 */
export function executionContentPaddingX(): number {
	return isFullscreenViewport() ? 0 : 1;
}

/**
 * Wrap a styled preview block in a render-time visual-line truncator.
 * Recomputed per render width so wrapping stays in sync with terminal size.
 */
export function createCollapsedPreview(previewText: string, previewLines: number, paddingX: number): Component {
	return {
		render: (width: number) => truncateToVisualLines(previewText, previewLines, width, paddingX).visualLines,
		invalidate: () => {},
	};
}

/**
 * Build the post-run status block (hidden-line hint, exit/cancel marker,
 * truncation notice). Returns undefined when there is nothing to display so
 * callers can skip appending a stray Text child.
 */
export function buildStatusFooter(opts: {
	status: ExecutionStatus;
	exitCode: number | undefined;
	truncation: TruncationMeta | undefined;
	hiddenLineCount: number;
	/** Suppress the "… N more lines" hint (used when sixel passthrough renders the full output). */
	suppressHiddenCount?: boolean;
	/**
	 * Drop the blank row above the footer. A one-line collapsed preview cannot
	 * afford a separator that is as tall as the content it separates.
	 */
	compact?: boolean;
	/** Horizontal inset, see {@link executionContentPaddingX}. */
	paddingX: number;
}): Text | undefined {
	const parts: string[] = [];

	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		// Routed through formatExpandHint rather than naming ctrl+o inline: in
		// fullscreen the affordance is a click, and this is also the call that
		// reports the block as collapsible so its header becomes a hit zone.
		parts.push(`${theme.fg("dim", `… ${opts.hiddenLineCount} more lines`)} ${formatExpandHint(theme, false, true)}`);
	}
	if (opts.status === "cancelled") {
		parts.push(theme.fg("warning", "(cancelled)"));
	} else if (opts.status === "error") {
		parts.push(theme.fg("error", `(exit ${opts.exitCode})`));
	}
	if (opts.truncation) {
		parts.push(theme.fg("warning", formatTruncationMetaNotice(opts.truncation)));
	}
	if (parts.length === 0) return undefined;
	return new Text(opts.compact ? parts.join("\n") : `\n${parts.join("\n")}`, opts.paddingX, 0);
}

/**
 * Derive the post-run status from an exit code + cancellation flag using the
 * same precedence both execution components apply.
 */
export function resolveExecutionStatus(exitCode: number | undefined, cancelled: boolean): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}
