import { type Component, matchesKey, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { bottomBorder, row, topBorder, topChromeRows } from "./overlay-box";

/** Smallest useful usage viewport on a short terminal. */
const MIN_BODY_ROWS = 5;
/** Keep the usage modal subordinate to the conversation behind it. */
const HEIGHT_FRACTION = 0.65;
const FOOTER_HINT = "↑/↓ scroll · PgUp/PgDn page · Home/End · Esc/q close";

/**
 * Floating, scrollable provider-usage panel.
 *
 * The usage renderer is width-sensitive (notably its multi-account tracks), so
 * this component owns a `renderContent` callback rather than a pre-rendered
 * string. Recomputing only when the overlay width changes keeps account columns
 * aligned after a terminal resize without resetting the user's scroll offset on
 * every frame.
 *
 * Hosted as a non-fullscreen overlay: the normal transcript remains untouched
 * underneath, unlike the previous `/usage` implementation which appended a
 * permanent block to scrollback.
 */
export class UsageOverlayComponent implements Component {
	readonly #tui: TUI;
	readonly #renderContent: (width: number) => string;
	readonly #onClose: () => void;
	readonly #scrollView = new ScrollView([], {
		height: MIN_BODY_ROWS,
		scrollbar: "auto",
		theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
	});
	#renderedWidth = -1;
	#lineCount = 0;
	#closed = false;

	constructor(tui: TUI, renderContent: (width: number) => string, onClose: () => void) {
		this.#tui = tui;
		this.#renderContent = renderContent;
		this.#onClose = onClose;
	}

	invalidate(): void {
		// Content is immutable for one open panel. Geometry is reconciled in render.
	}

	handleInput(data: string): void {
		// Mouse reporting is intentionally disabled for this normal-screen overlay;
		// do not leak a stray report into the vim-style single-key handlers below.
		if (data.startsWith("\x1b[<")) return;
		if (matchesKey(data, "escape") || data === "q") {
			this.#close();
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#tui.requestRender();
			return;
		}
		if (data === "j") this.#scrollView.scroll(1);
		else if (data === "k") this.#scrollView.scroll(-1);
		else if (data === "g") this.#scrollView.scrollToTop();
		else if (data === "G") this.#scrollView.scrollToBottom();
		else return;
		this.#tui.requestRender();
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		if (innerWidth !== this.#renderedWidth) {
			const output = this.#renderContent(innerWidth).trimEnd();
			const lines = output ? output.split(/\r?\n/) : [theme.fg("muted", "No usage data available.")];
			// `renderUsageReports` carries its own plain-text heading for CLI and
			// transcript callers. The floating panel already owns a titled chrome
			// row, so keeping both would render “Usage” twice.
			if (lines[0] && /^Usage(?:\\s|$)/.test(Bun.stripANSI(lines[0]))) lines.shift();
			this.#scrollView.setLines(lines);
			this.#lineCount = lines.length;
			this.#renderedWidth = innerWidth;
		}

		const terminalRows = Math.max(12, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const panelRows = Math.max(MIN_BODY_ROWS + topChromeRows() + 2, Math.floor(terminalRows * HEIGHT_FRACTION));
		// Footer and bottom border each consume one row; topChromeRows accounts
		// for the titled border in normal-screen mode and the gap in fullscreen.
		const bodyBudget = Math.max(MIN_BODY_ROWS, panelRows - topChromeRows() - 2);
		this.#scrollView.setHeight(Math.min(this.#lineCount, bodyBudget));

		const out: string[] = [];
		out.push(...topBorder(width, "Usage"));
		for (const line of this.#scrollView.render(innerWidth)) out.push(row(line, width));
		out.push(row(theme.fg("dim", FOOTER_HINT), width));
		out.push(bottomBorder(width));
		return out;
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose();
	}
}
