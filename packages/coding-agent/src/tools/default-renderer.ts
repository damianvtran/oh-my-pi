import type { Component } from "@oh-my-pi/pi-tui";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine, WidthAwareText } from "../tui";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { formatExpandHint, isFullscreenViewport, PREVIEW_LIMITS, replaceTabs, truncateToWidth } from "./render-utils";

/** Inputs rendered by the fallback card used when a tool has no bespoke renderer. */
export interface DefaultToolRenderInput {
	/** Human-readable tool label. */
	label: string;
	/** Tool arguments, shown inline when collapsed and as a tree when expanded. */
	args: unknown;
	/** Settled or streaming result; omitted while only the call is available. */
	result?: {
		output: string;
		isError?: boolean;
		/** Synthetic placeholder for a call skipped mid-batch to service steering/peer
		 * input — the tool never ran, so it renders neutral (info) rather than as an error. */
		skipped?: boolean;
	};
	/** Current expansion and lifecycle state. */
	options: RenderResultOptions;
}

/** Format one generic tool call/result card at the available content width. */
export function formatDefaultToolExecution(
	input: DefaultToolRenderInput,
	contentWidth: number,
	uiTheme: Theme,
): string {
	const lines: string[] = [];
	const { options, result } = input;
	const icon = options.isPartial
		? options.spinnerFrame !== undefined
			? "running"
			: "pending"
		: result?.skipped
			? "info"
			: result?.isError
				? "error"
				: "done";
	lines.push(
		renderStatusLine(
			{
				icon,
				spinnerFrame: options.spinnerFrame,
				title: input.label,
				...(result?.skipped ? { titleColor: "muted" as const } : {}),
			},
			uiTheme,
		),
	);

	const args = isRecord(input.args) ? input.args : undefined;
	if (!options.expanded && args && Object.keys(args).length > 0) {
		const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(uiTheme.tree.last) - 2);
		const preview = formatArgsInline(args, inlineBudget);
		if (preview) {
			lines.push(` ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("dim", preview)}`);
		}
	}

	if (options.expanded && input.args !== undefined) {
		lines.push("");
		lines.push(uiTheme.fg("dim", "Args"));
		const tree = renderJsonTreeLines(
			input.args,
			uiTheme,
			JSON_TREE_MAX_DEPTH_EXPANDED,
			JSON_TREE_MAX_LINES_EXPANDED,
			JSON_TREE_SCALAR_LEN_EXPANDED,
		);
		lines.push(...tree.lines);
		if (tree.truncated) {
			lines.push(uiTheme.fg("dim", "…"));
		}
		lines.push("");
	}

	if (!result) {
		return lines.join("\n");
	}

	const textContent = result.output.trimEnd();
	if (!textContent) {
		lines.push(uiTheme.fg("dim", "(no output)"));
		return lines.join("\n");
	}

	if (textContent.startsWith("{") || textContent.startsWith("[")) {
		try {
			const parsed = JSON.parse(textContent);
			const maxDepth = options.expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
			const maxLines = options.expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
			const maxScalarLen = options.expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
			const tree = renderJsonTreeLines(parsed, uiTheme, maxDepth, maxLines, maxScalarLen);

			if (tree.lines.length > 0) {
				lines.push(...tree.lines);
				if (!options.expanded) {
					lines.push(formatExpandHint(uiTheme, options.expanded, true));
				} else if (tree.truncated) {
					lines.push(uiTheme.fg("dim", "…"));
				}
				return lines.join("\n");
			}
		} catch {
			// Non-JSON output that starts with a bracket is rendered as plain text.
		}
	}

	const outputLines = textContent.split("\n");
	// A settled call collapses to one line of evidence in the fullscreen
	// viewport, where its header is a click away from the rest. A still-running
	// call keeps the wider window because its output is the live edge, and
	// append mode keeps it throughout because there is nothing to click there.
	const settledCap = options.isPartial || !isFullscreenViewport() ? 4 : PREVIEW_LIMITS.OUTPUT_SETTLED;
	const maxOutputLines = options.expanded ? 12 : settledCap;
	const displayLines = outputLines.slice(0, maxOutputLines);

	for (const line of displayLines) {
		lines.push(uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), contentWidth)));
	}

	if (outputLines.length > maxOutputLines) {
		const remaining = outputLines.length - maxOutputLines;
		lines.push(
			`${uiTheme.fg("dim", `… ${remaining} more lines`)} ${formatExpandHint(uiTheme, options.expanded, true)}`,
		);
	} else if (!options.expanded && !isFullscreenViewport()) {
		// Nothing is hidden but ctrl+o still reveals the args tree, so append mode
		// keeps advertising it. In the fullscreen viewport an affordance also
		// makes the header clickable and hoverable, and a card that already shows
		// its whole output should not light up under the cursor.
		lines.push(formatExpandHint(uiTheme, options.expanded, true));
	}

	return lines.join("\n");
}

/** Render the generic fallback as the state-tinted card used by direct custom tools. */
export function renderDefaultToolExecution(input: DefaultToolRenderInput, uiTheme: Theme): Component {
	const component = new WidthAwareText(contentWidth => formatDefaultToolExecution(input, contentWidth, uiTheme), 1, 1);
	const background = input.options.isPartial
		? "toolPendingBg"
		: input.result?.isError
			? "toolErrorBg"
			: "toolSuccessBg";
	component.setCustomBgFn(text => uiTheme.bg(background, text));
	component.setIgnoreTight(true);
	return component;
}
