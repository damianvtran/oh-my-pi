import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { SessionSelectorComponent, type SessionSignalMatcher } from "../modes/components/session-selector";
import { HistoryStorage } from "../session/history-storage";
import type { SessionInfo } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { backfillSessionIndex, createSessionSignalMatcher } from "../session/session-search-signals";
import { FileSessionStorage } from "../session/session-storage";

/** Presentation and capability controls for the standalone session picker. */
export interface SessionPickerOptions {
	allSessions?: SessionInfo[];
	title?: string;
	scopeLabel?: string | false;
	showCwd?: boolean;
	allowDelete?: boolean;
	allowGlobalScope?: boolean;
	historySearch?: boolean;
}

/**
 * Show the TUI session selector and return the selected session, or null if
 * cancelled. The default OMP picker supports deletion, transcript-history
 * search, and an all-projects scope; foreign import pickers disable those
 * source-owned capabilities.
 */
export async function selectSession(
	sessions: SessionInfo[],
	options: SessionPickerOptions = {},
): Promise<SessionInfo | null> {
	const { promise, resolve } = Promise.withResolvers<SessionInfo | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	const storage = new FileSessionStorage();

	// Rank sessions with prompt-history and keyword-index matches too, recovering
	// relevance the 4KB session-list prefix never sees. Best-effort: a
	// missing/locked database must not break the picker.
	let signalMatcher: SessionSignalMatcher | undefined;
	if (options.historySearch !== false) {
		let history: HistoryStorage | undefined;
		try {
			history = HistoryStorage.open();
		} catch (error) {
			logger.warn("History storage unavailable for session ranking", { error: String(error) });
		}
		signalMatcher = createSessionSignalMatcher(history);
		// Index whatever the listing already knows about sessions that predate the
		// keyword index, so the very first search after an upgrade has data.
		backfillSessionIndex(sessions);
	}

	const showSelector = () => {
		const selector = new SessionSelectorComponent(
			sessions,
			(session: SessionInfo) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(session);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					process.exit(0);
				}
			},
			{
				onDelete:
					options.allowDelete === false
						? undefined
						: async (session: SessionInfo) => {
								await storage.deleteSessionWithArtifacts(session.path);
								return true;
							},
				signalMatcher,
				loadAllSessions:
					options.allowGlobalScope === false
						? undefined
						: async () => {
								const all = await SessionManager.listAll(storage);
								backfillSessionIndex(all);
								return all;
							},
				allSessions: options.allSessions,
				getTerminalRows: () => ui.terminal.rows,
				fillHeight: true,
				title: options.title,
				scopeLabel: options.scopeLabel,
				showCwd: options.showCwd,
			},
		);
		return selector;
	};

	const selector = showSelector();
	selector.setOnRequestRender(() => ui.requestRender());
	// Present as a fullscreen overlay so the picker borrows the terminal's
	// alternate screen buffer (vim/less idiom): the list scrolls and rows are
	// clickable via the mouse tracking the overlay enables for its lifetime.
	// Anchored top-left at full size so a mouse row maps directly to a rendered
	// line (the overlay paints from screen row 0).
	ui.showOverlay(selector, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ui.setFocus(selector);
	ui.start();
	return promise;
}
