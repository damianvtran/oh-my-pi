/**
 * Shared chrome for the overlays (the `/copy` picker, the plan-review overlay,
 * the model hub, …). Every outlined overlay is built from these helpers, so
 * this module is the one place their look is decided.
 *
 * Append mode paints a frame with `theme.boxRound` glyphs (rounded corners,
 * sharp tee/cross junctions) in the `border`/`accent` colors. Fullscreen paints
 * no frame at all: the overlay is a raised surface marked out by its fill, and
 * the engine washes every composited overlay row with `theme.overlayBg` — a
 * rung the transcript never uses, so the fill alone is the edge — so the rules
 * degrade to plain gaps and the corners and verticals to plain inset.
 *
 * Both modes lay out on identical column geometry, deliberately. Callers cache
 * hit rows and click columns against these widths and budget their body height
 * in whole rows, so a chrome row is one row and a content column is the same
 * column in either mode.
 */
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { isFullscreenViewport } from "../../tools/render-utils";
import { theme } from "../theme/theme";

/** Columns of inset before row content, matching the frame's corner + space. */
const PANEL_PAD = 2;

/** Pad or truncate a (possibly ANSI-styled) string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

function paint(s: string): string {
	return theme.fg("border", s);
}

/** The title as it reads on a panel: at the same column as row content. */
function panelTitle(width: number, title: string): string {
	if (!title) return padding(Math.max(0, width));
	const shown = truncateToWidth(title, Math.max(0, width - PANEL_PAD));
	return fit(padding(PANEL_PAD) + theme.bold(theme.fg("accent", shown)), width);
}

/**
 * Rows {@link topBorder} and {@link topBorderSplit} occupy. Callers that budget
 * their body height in whole rows have to ask, because the panel spends a
 * second row on the pad above the title where the frame spends none.
 */
export function topChromeRows(): number {
	return isFullscreenViewport() ? 2 : 1;
}

/** Top border with an optional accent-colored title inset into the rule. */
export function topBorder(width: number, title: string): readonly string[] {
	if (isFullscreenViewport()) return [padding(Math.max(0, width)), panelTitle(width, title)];
	const box = theme.boxRound;
	const inner = Math.max(0, width - 2);
	if (!title) return [paint(box.topLeft + box.horizontal.repeat(inner) + box.topRight)];
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return [
		paint(box.topLeft + box.horizontal) +
			theme.bold(theme.fg("accent", shown)) +
			paint(box.horizontal.repeat(fillWidth) + box.topRight),
	];
}

/** A horizontal rule with left/right tees, splitting overlay sections. */
export function divider(width: number): string {
	if (isFullscreenViewport()) return padding(Math.max(0, width));
	const box = theme.boxRound;
	return paint(box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(width: number): string {
	if (isFullscreenViewport()) return padding(Math.max(0, width));
	const box = theme.boxRound;
	return paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(content: string, width: number): string {
	const inner = fit(content, Math.max(0, width - 4));
	if (isFullscreenViewport()) return padding(PANEL_PAD) + inner + padding(PANEL_PAD);
	const box = theme.boxRound;
	return `${paint(box.vertical)} ${inner} ${paint(box.vertical)}`;
}

/**
 * Column index (0-based) of the inner divider for a two-column layout whose
 * sidebar content area is `sidebarWidth` columns wide. The layout is
 * `│ sidebar │ body │` with a single-column inset on every side, so the divider
 * vertical sits at `sidebarWidth + 3` and the body content area is
 * {@link splitBodyWidth} columns.
 */
function splitDividerCol(sidebarWidth: number): number {
	return sidebarWidth + 3;
}

/** Body content width for a two-column overlay of total `width`. */
export function splitBodyWidth(width: number, sidebarWidth: number): number {
	return Math.max(0, width - sidebarWidth - 7);
}

/** Top border carrying the title, split by a `┬` over the column divider. */
export function topBorderSplit(width: number, title: string, sidebarWidth: number): readonly string[] {
	if (isFullscreenViewport()) return [padding(Math.max(0, width)), panelTitle(width, title)];
	const box = theme.boxRound;
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	let left: string;
	if (!title) {
		left = paint(box.topLeft + box.horizontal.repeat(leftLen));
	} else {
		const shown = truncateToWidth(` ${title} `, Math.max(0, leftLen - 1));
		const fillWidth = Math.max(0, leftLen - 1 - visibleWidth(shown));
		left =
			paint(box.topLeft + box.horizontal) +
			theme.bold(theme.fg("accent", shown)) +
			paint(box.horizontal.repeat(fillWidth));
	}
	return [left + paint(box.teeDown + box.horizontal.repeat(rightLen) + box.topRight)];
}

/** Section rule that closes the sidebar column with a `┴` over the divider. */
export function dividerSplit(width: number, sidebarWidth: number): string {
	if (isFullscreenViewport()) return padding(Math.max(0, width));
	const box = theme.boxRound;
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	return paint(
		box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft,
	);
}

/** A two-column content row: `│ sidebar │ body │`, each inset by one column. */
export function splitRow(sidebar: string, body: string, width: number, sidebarWidth: number): string {
	const bodyWidth = splitBodyWidth(width, sidebarWidth);
	const left = fit(sidebar, sidebarWidth);
	const right = fit(body, bodyWidth);
	// The column gap is three spaces where the frame spends space-bar-space, so
	// the sidebar and the body start on the same columns in either mode.
	if (isFullscreenViewport()) return `${padding(PANEL_PAD)}${left}${padding(3)}${right}${padding(PANEL_PAD)}`;
	const bar = paint(theme.boxRound.vertical);
	return `${bar} ${left} ${bar} ${right} ${bar}`;
}
