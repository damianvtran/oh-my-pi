/**
 * The fullscreen home screen: what omp shows before the conversation starts.
 *
 * opencode's empty session is a single block floating in the middle of the
 * window — wordmark, a narrow prompt, one row of affordances, one tip — and
 * nothing else. Two properties make it read that way, and both are structural
 * rather than cosmetic:
 *
 * 1. It is CHROME, not transcript. The wordmark lives in the pinned run with
 *    the composer, so it never scrolls, and it is removed outright when the
 *    conversation starts rather than being left at the top of the history.
 * 2. The prompt is narrower than the window. A full-width input welded to the
 *    bottom of an empty screen reads as a terminal waiting for a command; a
 *    centred one reads as a place to start.
 *
 * The vertical half of the centring belongs to the engine
 * ({@link TUI.setCenterPinned}, which self-disables as soon as the scroll
 * region has rows); the horizontal half is {@link HomeColumn}.
 *
 * Everything here renders zero rows outside the fullscreen viewport, where the
 * welcome box is still the startup surface and must stay byte-identical.
 */

import {
	type Component,
	Container,
	type HitZoneSink,
	padding,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { isFullscreenViewport } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { CARD_PADDING_X } from "./collapsible-block";
import { LogoIntro, pickSessionTip, renderWelcomeTip } from "./welcome";

/** Widest the home composer gets. opencode's centred prompt is about this. */
const COMPOSER_MAX_WIDTH = 72;

/**
 * Below this a centred panel costs more room than the framing buys, so the
 * composer takes the whole window and only the vertical centring is left.
 */
const COMPOSER_MIN_WIDTH = 48;

/** Keeps a component's memo warm across renders that produce nothing. */
const NO_ROWS: readonly string[] = [];

/** Affordances worth advertising on an empty session, in prompt-prefix order. */
const HINTS: ReadonlyArray<readonly [key: string, label: string]> = [
	["/", "commands"],
	["#", "prompt actions"],
	["!", "bash"],
	["$", "python"],
];

/** Columns between two hints on the affordance row. */
const HINT_GAP = 3;

/**
 * Columns the composer occupies at a given content width: two thirds of the
 * window, which lands on opencode's ~72 columns on a wide terminal and shrinks
 * with the window instead of stranding a fixed-width panel in a small one.
 */
export function homeComposerWidth(width: number): number {
	if (width <= COMPOSER_MIN_WIDTH) return width;
	const twoThirds = Math.round((width * 2) / 3);
	return Math.max(COMPOSER_MIN_WIDTH, Math.min(COMPOSER_MAX_WIDTH, twoThirds));
}

/** Left gutter that centres a `homeComposerWidth` panel in `width` columns. */
function composerInset(width: number): number {
	return Math.max(0, Math.floor((width - homeComposerWidth(width)) / 2));
}

/** Centre one line, truncating rather than overflowing when it cannot fit. */
function center(line: string, width: number): string {
	const visible = visibleWidth(line);
	if (visible >= width) return truncateToWidth(line, width);
	return padding(Math.floor((width - visible) / 2)) + line;
}

/**
 * Centre a run of lines as one block: every line shifts by the same gutter, so
 * a hanging indent (the tip's wrapped continuation rows) survives centring.
 */
function centerBlock(lines: readonly string[], width: number): string[] {
	let widest = 0;
	for (const line of lines) widest = Math.max(widest, visibleWidth(line));
	if (widest >= width) return lines.map(line => truncateToWidth(line, width));
	const gutter = padding(Math.floor((width - widest) / 2));
	return lines.map(line => gutter + line);
}

/**
 * Wordmark run: the pi glyph and the version, centred above the composer.
 *
 * Sits in the pinned group, so this is the "omp verbiage and symbol are not
 * part of the scroll" half of the design.
 */
export class HomeHeader implements Component {
	#intro = new LogoIntro(() => this.invalidate());
	#cachedWidth = -1;
	#cachedLines: readonly string[] | undefined;

	/**
	 * Wordmark and version only. The model, reasoning effort and working
	 * directory now ride on the composer's own status strip a few rows below,
	 * and printing the model here as well repeated the same word twice inside
	 * three rows.
	 */
	constructor(private readonly version: string) {}

	/** Sweep the logo gradient once, the same intro the welcome box plays. */
	playIntro(requestRender: () => void): void {
		this.#intro.play(requestRender);
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	dispose(): void {
		this.#intro.stop();
	}

	render(width: number): readonly string[] {
		if (!isFullscreenViewport()) return NO_ROWS;
		// Every frame of the sweep differs, so the cache is bypassed while it runs.
		const animating = this.#intro.running;
		if (!animating && this.#cachedLines && this.#cachedWidth === width) return this.#cachedLines;
		const wordmark = `${theme.bold(theme.fg("accent", APP_NAME))} ${theme.fg("muted", `v${this.version}`)}`;
		const lines = [...this.#intro.frame().map(line => center(line, width)), "", center(wordmark, width), ""];
		this.#cachedLines = animating ? undefined : lines;
		this.#cachedWidth = animating ? -1 : width;
		return lines;
	}
}

/**
 * Affordance run: the hint row and the session tip, below the composer.
 *
 * Rendered inside a {@link HomeColumn}, so `width` here is already the column,
 * not the window: the only inset this adds is the card padding every other
 * surface on the column adds. It previously re-derived the gutter itself, which
 * is how it drifted a column away from the notices beside it.
 *
 * The hints are left-aligned on the composer's own text column rather than
 * centred, which is what stops the block reading as a poster; the tip is
 * centred under it the way opencode's is.
 */
export class HomeHints implements Component {
	// Drawn once per instance so the tip does not change under the user while
	// they are reading it. The home screen is constructed only when it shows,
	// so this never burns a draw on a session that starts with a transcript.
	readonly #tip = pickSessionTip();
	#cachedWidth = -1;
	#cachedLines: readonly string[] | undefined;

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (!isFullscreenViewport()) return NO_ROWS;
		if (this.#cachedLines && this.#cachedWidth === width) return this.#cachedLines;
		// The composer's text starts one panel padding in from the panel edge;
		// the hint row lines up with it, not with the panel's left edge.
		const textColumn = CARD_PADDING_X;
		const lines = ["", padding(textColumn) + this.#hintRow(Math.max(0, width - textColumn))];
		const tip = this.#tip ? renderWelcomeTip(this.#tip, width) : [];
		if (tip.length > 0) lines.push("", ...centerBlock(tip, width));
		this.#cachedLines = lines;
		this.#cachedWidth = width;
		return lines;
	}

	/** As many hints as fit, dropping from the right rather than truncating. */
	#hintRow(budget: number): string {
		let row = "";
		let used = 0;
		for (const [key, label] of HINTS) {
			const cost = (row ? HINT_GAP : 0) + key.length + 1 + label.length;
			if (used + cost > budget) break;
			row += `${row ? padding(HINT_GAP) : ""}${theme.fg("dim", key)} ${theme.fg("muted", label)}`;
			used += cost;
		}
		return row;
	}
}

/**
 * A container that narrows and centres its children onto the home screen's
 * column while the home screen is up, and is a plain passthrough otherwise.
 *
 * Used for both the composer and the parked notices, so an update banner sits
 * on exactly the same columns as the prompt beneath it instead of running the
 * full width of the window while everything around it is centred.
 *
 * Children are rendered at the narrow width and then shifted right, so a panel
 * fill they paint is exactly the panel the user sees and the canvas shows
 * through on both sides. Published columns are shifted by the same gutter,
 * which is what keeps click-to-caret landing on the character under the
 * pointer; the engine adds the window gutter on top of that.
 */
export class HomeColumn extends Container {
	#centered = false;
	// The inset the current rows were rendered with, so zones cannot be
	// published against a width the frame was not painted at.
	#inset = 0;
	#sourceRows: readonly string[] | undefined;
	#shiftedRows: readonly string[] | undefined;

	setCentered(centered: boolean): void {
		if (centered === this.#centered) return;
		this.#centered = centered;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		const inset = this.#centered && isFullscreenViewport() ? composerInset(width) : 0;
		this.#inset = inset;
		if (inset === 0) return super.render(width);
		const rows = super.render(width - inset * 2);
		// Same rows at the same inset means the same shifted array, which is the
		// render contract's proof that the frame prefix is unchanged.
		if (rows === this.#sourceRows && this.#shiftedRows) return this.#shiftedRows;
		const gutter = padding(inset);
		this.#sourceRows = rows;
		this.#shiftedRows = rows.map(row => gutter + row);
		return this.#shiftedRows;
	}

	override invalidate(): void {
		this.#sourceRows = undefined;
		this.#shiftedRows = undefined;
		super.invalidate();
	}

	override publishHitZones(sink: HitZoneSink): void {
		if (this.#inset === 0) {
			super.publishHitZones(sink);
			return;
		}
		sink.withColumnOffset(this.#inset, () => super.publishHitZones(sink));
	}
}

/**
 * The pinned runs that bracket the composer on an empty session.
 *
 * They are separate root children because the composer sits between them, and
 * they are owned together because they are one surface: they all go up at
 * startup and all come down on the first block, and a half-mounted home screen
 * is not a state the layout should be able to reach.
 */
export class HomeScreen {
	readonly header: HomeHeader;
	/**
	 * Startup notices, parked between the wordmark and the prompt. They are
	 * chrome for as long as there is no conversation to file them under; the
	 * host moves them into the transcript when the home screen comes down, so
	 * nothing an MCP server or an update check reported is lost.
	 *
	 * On the home column, not full width: an update banner is a card, and a card
	 * stretched across the whole window above a two-thirds composer reads as a
	 * different kind of object. Once filed into the transcript it goes back to
	 * full width with every other block, which is correct there.
	 */
	readonly notices = new HomeColumn();
	/**
	 * Hint row and tip, on the same column as the notices and the composer. The
	 * column is applied here rather than inside {@link HomeHints} so there is one
	 * place that knows the gutter.
	 */
	readonly hints = new HomeColumn();

	constructor(version: string) {
		this.header = new HomeHeader(version);
		this.notices.setCentered(true);
		this.hints.setCentered(true);
		this.hints.addChild(new HomeHints());
	}

	/**
	 * Take every run out of the tree for good and hand the composer back to the
	 * base of the viewport at full width. Parked notices must be claimed first;
	 * this drops whatever is left.
	 *
	 * Mounting is left to the composition site, where the pinned run's order is
	 * visible; coming down has no order to get wrong, and doing it in one place
	 * is what stops a half-dismissed home screen from being reachable.
	 */
	dismiss(ui: TUI, composer: HomeColumn): void {
		ui.setCenterPinned(false);
		composer.setCentered(false);
		ui.removeChild(this.header);
		ui.removeChild(this.notices);
		ui.removeChild(this.hints);
		this.header.dispose();
		this.notices.disposeChildren();
	}
}
