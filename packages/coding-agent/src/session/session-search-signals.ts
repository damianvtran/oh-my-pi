/**
 * The session picker's out-of-band relevance sources, behind one seam.
 *
 * The in-memory listing only sees the first 4KB of each session file, so two
 * kinds of relevance are invisible to it: a prompt typed deep into a long
 * session, and the topic vocabulary harvested for a session that never spells
 * those words in its opening turns. Both live in SQLite, both are synchronous
 * enough to need debouncing off the keystroke path, and the picker debounces
 * exactly one callback — so they are resolved together here rather than each
 * growing its own timer in {@link SessionList}.
 *
 * Every lookup is best-effort. A missing, locked, or corrupt database degrades
 * search back to pure text ranking; it never fails the picker.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionSearchSignals, SessionSignalMatcher } from "../modes/components/session-selector";
import type { HistoryStorage } from "./history-storage";
import { extractSessionKeywords, type SessionIndexRecord, SessionIndexStorage } from "./session-index-storage";
import { readSessionSearchCorpus, type SessionInfo } from "./session-listing";
import { FileSessionStorage, type SessionStorage } from "./session-storage";

/**
 * Build the picker's signal source from the prompt history and the session
 * keyword index.
 *
 * `history` is passed in rather than opened here because the interactive mode
 * already holds an open handle and a second `HistoryStorage.open()` would hand
 * back the same singleton anyway; the standalone `--resume` picker opens its
 * own. Returns undefined when neither source could be reached, which tells the
 * picker to skip the debounce entirely.
 */
export function createSessionSignalMatcher(history: HistoryStorage | undefined): SessionSignalMatcher | undefined {
	let index: SessionIndexStorage | undefined;
	try {
		index = SessionIndexStorage.open();
	} catch (error) {
		logger.warn("Session keyword index unavailable for session ranking", { error: String(error) });
	}
	if (!history && !index) return undefined;

	return (query: string): SessionSearchSignals => {
		const signals: SessionSearchSignals = {};
		if (history) signals.historyIds = history.matchingSessionIds(query);
		if (index) {
			const hits = index.search(query);
			if (hits.length > 0) signals.indexScores = new Map(hits.map(hit => [hit.sessionId, hit.score]));
		}
		return signals;
	};
}

/**
 * Sessions read and indexed per macrotask. Each one costs two bounded reads
 * (~192KB of window) plus keyword extraction, so a batch is I/O bound; the
 * reads run concurrently within a batch and the loop yields between batches so
 * a multi-thousand-session first run never blocks a keystroke.
 */
const BACKFILL_BATCH = 32;
/** Longest stored blurb for a backfilled session, matching the live theme pass. */
const BACKFILL_SUMMARY_MAX_CHARS = 400;

/**
 * Index the listed sessions that have no index row yet.
 *
 * Live sessions write their own row as they run, which means the index is empty
 * for every session that existed before it did — on first upgrade, the user's
 * entire history. Without this, keyword search is a feature that only starts
 * working tomorrow.
 *
 * The listing's own text is not enough to backfill from: `SessionInfo` is built
 * from the first 4KB of the file, which on a real session is spent before the
 * first message, leaving `allMessagesText` empty and the title as the only
 * evidence. So each unindexed session is re-read through
 * {@link readSessionSearchCorpus}, once, over a window wide enough to reach
 * actual conversation. `upsert` merges rather than replaces, so a later live
 * theme pass refines the row instead of fighting it.
 *
 * Fire-and-forget and best-effort: the picker never waits on it and never fails
 * because of it.
 */
export function backfillSessionIndex(
	sessions: readonly SessionInfo[],
	storage: SessionStorage = new FileSessionStorage(),
): void {
	if (sessions.length === 0) return;
	let index: SessionIndexStorage;
	try {
		index = SessionIndexStorage.open();
	} catch (error) {
		logger.warn("Session keyword index unavailable for backfill", { error: String(error) });
		return;
	}

	const byId = new Map<string, SessionInfo>();
	for (const session of sessions) {
		if (!byId.has(session.id)) byId.set(session.id, session);
	}
	const missing = index.unindexedSessionIds([...byId.keys()]);
	if (missing.length === 0) return;

	let cursor = 0;
	const step = async (): Promise<void> => {
		const slice = missing.slice(cursor, cursor + BACKFILL_BATCH);
		cursor += slice.length;
		const records = await Promise.all(
			slice.map(async (id): Promise<SessionIndexRecord | undefined> => {
				const session = byId.get(id);
				if (!session) return undefined;
				const body = await readSessionSearchCorpus(session.path, storage);
				// Title first so its words survive the keyword extractor's cap and
				// its position bias, and so a session whose file could not be read
				// still earns a row rather than being retried on every picker open.
				const corpus = [session.title ?? "", body].filter(Boolean).join(" ").trim();
				if (!corpus) return undefined;
				return {
					sessionId: session.id,
					cwd: session.cwd || undefined,
					title: session.title,
					keywords: extractSessionKeywords(corpus).join(" "),
					summary: corpus.slice(0, BACKFILL_SUMMARY_MAX_CHARS),
				};
			}),
		);
		index.upsertMany(records.filter(record => record !== undefined));
		if (cursor < missing.length) setTimeout(run, 0).unref?.();
	};
	const run = (): void => {
		step().catch(error => logger.warn("Session keyword index backfill failed", { error: String(error) }));
	};
	setTimeout(run, 0).unref?.();
}
