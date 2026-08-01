/**
 * SQLite keyword index for the resume picker, keyed by session ID.
 *
 * Sessions are otherwise findable only by substring/fuzzy matching over
 * `SessionInfo`, whose text corpus is the first 4096 bytes of the session
 * JSONL. That prefix is whatever the user typed first, so a session about
 * "rolling back the staging deploy" is unreachable by the word "kubernetes"
 * if the word only ever appeared on turn 30. This table is the place to park
 * derived, searchable attributes (harvested keywords, a theme blurb) so the
 * picker can soft-match on a session's topic instead of its opening sentence.
 *
 * Matching is deliberately LEXICAL: Porter-stemmed FTS5 over LLM-independent
 * extracted keywords, NOT vector embeddings. The repo's only embedding path
 * (`src/mnemopi/embed-client.ts`) pulls a ~270 MB fastembed runtime plus an
 * ONNX model on first use, which is not a defensible cost for typing three
 * characters into a session picker, and it is simply unavailable when the user
 * has mnemopi disabled. Stemming buys the soft match that actually matters
 * here ("deploying" finds "deploy") for zero download and at synchronous
 * latency, which is what a keystroke-driven picker needs.
 *
 * Every public method is failure-tolerant: a broken index degrades session
 * search, but it must never break a session. Writes swallow and log; reads
 * return empty.
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionIndexDbPath, logger } from "@oh-my-pi/pi-utils";

export interface SessionIndexRecord {
	sessionId: string;
	cwd?: string;
	title?: string;
	/** Space-separated salient terms harvested from the transcript. */
	keywords?: string;
	/** Single-line theme blurb, <= 400 chars. */
	summary?: string;
}

export interface SessionIndexHit {
	sessionId: string;
	/** Normalized relevance in (0, 1]; higher is better. */
	score: number;
}

/**
 * A listed session as the backfill sees it: enough to decide whether the stored
 * row still describes the session on disk. Structurally satisfied by
 * `SessionInfo`, so the picker passes its listing straight through.
 */
export interface SessionIndexEntry {
	id: string;
	title?: string;
}

type FtsRow = { session_id: string; rank: number };
type LikeRow = { session_id: string };

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/** Upper bound on rows any one `search()` may return, mirroring `HistoryStorage`. */
const MAX_SEARCH_LIMIT = 1000;

/**
 * Host parameters per `... WHERE session_id IN (...)` batch, shared by the
 * prune deletes and the backfill's membership probe. Modern SQLite allows
 * 32766 bound variables but builds before 3.32 cap at 999, and bun ships
 * whatever the platform linked, so stay well inside the old ceiling.
 * `gc-cli.ts`'s `deleteHistoryRowsForSessions` wraps its per-session history
 * deletes in a single transaction for the same reason; we do too, so the FTS
 * mirror triggers commit atomically with the row deletes and a crash mid-prune
 * can never leave the mirror describing rows that are gone.
 */
const SESSION_ID_CHUNK = 400;

/**
 * Score floor for a Porter/FTS hit and the fixed score for a LIKE-fallback hit.
 * The bands do not overlap, so a stemmed hit always outranks a raw substring
 * hit even if a future caller merges the two result sets.
 */
const FTS_SCORE_FLOOR = 0.1;
const LIKE_HIT_SCORE = 0.05;

/**
 * Half-saturation constant for the bm25 -> (0, 1] map. bm25 magnitudes for a
 * one-or-two token query against these short documents land around 0.5-3, so
 * K = 2 spreads the useful range across the middle of the output band instead
 * of pinning everything near an asymptote.
 */
const BM25_HALF_SATURATION = 2;

// Escape LIKE wildcards so user input is treated as literal text.
// Matches the `ESCAPE '\\'` clause used by the substring-fallback statements.
function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * Hard cap on the transcript slice `extractSessionKeywords` tokenizes. A
 * session JSONL can reach tens of megabytes; the caller runs this on the
 * session's own turn loop, so the scan has to be bounded by something that
 * cannot grow with session age. 32 KiB is a few opening turns' worth of text,
 * which is where the ranking below draws its signal from anyway.
 */
const MAX_KEYWORD_INPUT_CHARS = 32 * 1024;

/**
 * Terms that carry no discriminating power for "which session was that?".
 * English function words plus the vocabulary every coding transcript shares:
 * indexing `error` or `function` would make those tokens match every session
 * and (via bm25's IDF) contribute nothing but noise and index size.
 */
const KEYWORD_STOPWORDS: ReadonlySet<string> = new Set(
	// Articles, conjunctions, prepositions, determiners, interrogatives.
	(
		"the and but for nor not yet all any both each few more most other some such than that then these this those too " +
		"very with into onto from about above after again against before below between during over under until while " +
		"here there when where which who whom why how what " +
		// Pronouns.
		"you your yours our ours its his her hers him she they them their theirs himself herself itself myself yourself " +
		"ourselves themselves " +
		// Auxiliaries and other verbs too common to tell one session from another.
		"are was were been being have has had having does did doing can could should would shall will must may might " +
		"get got let make made use used using want need please just also only now one two " +
		// Code noise: present in every transcript, so present in every session.
		"todo file files code error errors line lines function const var return import export async await true false " +
		"null undefined type types class new test tests run add fix try catch throw value string number boolean void " +
		"public private static self def end else elif case switch break continue yield print log logs src lib dir path " +
		"name names data info result results output input args arg params param options option config"
	).split(" "),
);

export class SessionIndexStorage {
	#db: Database;
	static #instances = new Map<string, SessionIndexStorage>();

	// Prepared statements held as fields: `upsert` runs on the session's own
	// turn loop and `search` runs per keystroke in the picker.
	#upsertStmt: Statement;
	#ftsSearchStmt: Statement;
	// The LIKE fallback's WHERE clause is shaped by the query's token count, so
	// cache one statement per arity rather than re-preparing on every keystroke.
	#likeStmts = new Map<number, Statement>();

	private constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });

		this.#db = new Database(dbPath);

		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		// Several omp processes share this file, and the picker reads it while
		// other sessions are writing their theme pass.
		this.#db.run("PRAGMA busy_timeout = 5000");

		const hasFts = this.#db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_index_fts'")
			.get();

		// `session_index` is keyed by the session's TEXT id, but FTS5 external
		// content demands an INTEGER `content_rowid`, so the mirror is keyed by
		// `session_index`'s implicit rowid and kept in sync by triggers. On
		// UPDATE the mirror MUST be given the delete-then-insert form: FTS5
		// external content stores no copy of the old text, so a bare insert
		// leaves the previous terms in the index forever and the table silently
		// answers queries with stale hits. The 'delete' command therefore has
		// to be handed the OLD column values verbatim.
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS session_index (
	session_id TEXT PRIMARY KEY,
	cwd TEXT,
	title TEXT,
	keywords TEXT,
	summary TEXT,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
-- No UNIQUE INDEX on session_id: a TEXT PRIMARY KEY already gets
-- sqlite_autoindex_session_index_1, and a second one would just double the
-- write cost of every upsert. This index is the useful one - the picker lists
-- and prunes by recency.
CREATE INDEX IF NOT EXISTS idx_session_index_updated_at ON session_index(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS session_index_fts USING fts5(
	title,
	keywords,
	summary,
	content='session_index',
	content_rowid='rowid',
	tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS session_index_ai AFTER INSERT ON session_index BEGIN
	INSERT INTO session_index_fts(rowid, title, keywords, summary)
	VALUES (new.rowid, new.title, new.keywords, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS session_index_ad AFTER DELETE ON session_index BEGIN
	INSERT INTO session_index_fts(session_index_fts, rowid, title, keywords, summary)
	VALUES ('delete', old.rowid, old.title, old.keywords, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS session_index_au AFTER UPDATE ON session_index BEGIN
	INSERT INTO session_index_fts(session_index_fts, rowid, title, keywords, summary)
	VALUES ('delete', old.rowid, old.title, old.keywords, old.summary);
	INSERT INTO session_index_fts(rowid, title, keywords, summary)
	VALUES (new.rowid, new.title, new.keywords, new.summary);
END;
		`);

		if (!hasFts) {
			// Rows may predate the mirror (schema bump, or a file that lost its
			// virtual table). Same tolerance as `HistoryStorage`: a failed
			// rebuild costs recall, never the session.
			try {
				this.#db.run("INSERT INTO session_index_fts(session_index_fts) VALUES('rebuild')");
			} catch (error) {
				logger.warn("SessionIndexStorage FTS rebuild failed", { error: String(error) });
			}
		}

		// `COALESCE(excluded.x, session_index.x)` is the whole point of this
		// statement: the caller upserts twice per session from different places
		// (a rename supplies `{sessionId, cwd, title}`, the theme pass supplies
		// `{sessionId, keywords, summary}`), and neither may erase the other's
		// columns. An absent field binds NULL and therefore keeps what is there.
		this.#upsertStmt = this.#db.prepare(`
INSERT INTO session_index (session_id, cwd, title, keywords, summary, updated_at)
VALUES (?, ?, ?, ?, ?, ${SQLITE_NOW_EPOCH})
ON CONFLICT(session_id) DO UPDATE SET
	cwd = COALESCE(excluded.cwd, session_index.cwd),
	title = COALESCE(excluded.title, session_index.title),
	keywords = COALESCE(excluded.keywords, session_index.keywords),
	summary = COALESCE(excluded.summary, session_index.summary),
	updated_at = excluded.updated_at
		`);

		// bm25 weights title > keywords > summary: a hit in the name the user
		// gave (or the titler derived) is a far stronger signal than a word
		// buried in a generated blurb. `bm25()` must be handed the FTS table's
		// own name, so the virtual table is not aliased here.
		this.#ftsSearchStmt = this.#db.prepare(`
SELECT s.session_id AS session_id, bm25(session_index_fts, 3.0, 2.0, 1.0) AS rank
FROM session_index_fts
JOIN session_index s ON s.rowid = session_index_fts.rowid
WHERE session_index_fts MATCH ?
ORDER BY rank
LIMIT ?
		`);
	}

	/**
	 * Open (once per database file) the index at `dbPath`.
	 *
	 * Memoized per resolved path rather than as a single instance: `omp gc`
	 * prunes the index for an explicit `--agent-dir`, and a path-blind singleton
	 * would silently hand it whichever database some earlier caller opened —
	 * i.e. prune the user's real index during a test against a temp directory.
	 */
	static open(dbPath: string = getSessionIndexDbPath()): SessionIndexStorage {
		const key = path.resolve(dbPath);
		let instance = SessionIndexStorage.#instances.get(key);
		if (!instance) {
			instance = new SessionIndexStorage(dbPath);
			SessionIndexStorage.#instances.set(key, instance);
		}
		return instance;
	}

	/** @internal Close every open index database — test-only. */
	static resetInstance(): void {
		for (const instance of SessionIndexStorage.#instances.values()) instance.#close();
		SessionIndexStorage.#instances.clear();
	}

	#close(): void {
		for (const stmt of this.#likeStmts.values()) stmt.finalize();
		this.#likeStmts.clear();
		this.#upsertStmt.finalize();
		this.#ftsSearchStmt.finalize();
		this.#db.close();
	}

	/**
	 * Insert or merge one session's searchable attributes. Fields left
	 * `undefined` keep their stored value instead of clearing it, so partial
	 * updates from independent callers compose. `updated_at` always advances.
	 */
	upsert(record: SessionIndexRecord): void {
		if (!record.sessionId) return;
		try {
			this.#upsertStmt.run(
				record.sessionId,
				record.cwd ?? null,
				record.title ?? null,
				record.keywords ?? null,
				record.summary ?? null,
			);
		} catch (error) {
			// A session that cannot be indexed is a session that is harder to
			// find later. It is not a session that should fail.
			logger.warn("SessionIndexStorage upsert failed", { sessionId: record.sessionId, error: String(error) });
		}
	}

	/**
	 * Which of `sessions` need indexing: those with no row yet, and those whose
	 * stored title no longer matches the one in the session file.
	 *
	 * Filling missing rows is what makes keyword search work on a corpus that
	 * predates the index. Reconciling drifted ones is what keeps it working.
	 * A row is written once, by whichever process reaches the session first,
	 * and the file keeps being renamed long afterwards — by a running session
	 * whose binary predates this index, by the stock upstream build, by any
	 * process that dies before its own write lands. Nothing ever re-read the
	 * row, so search went on matching a name the picker no longer displays:
	 * the user searches for the title they can see and the session does not
	 * come back, while the one hit they do get is labelled with a name they
	 * never chose.
	 *
	 * Comparison is on the trimmed title, and a session file with no title
	 * never counts as drifted — `upsert` preserves absent fields, so
	 * re-indexing one could not change the row and would re-select it forever.
	 */
	outdatedSessionIds(sessions: readonly SessionIndexEntry[]): string[] {
		if (sessions.length === 0) return [];
		const storedTitles = new Map<string, string>();
		try {
			for (let start = 0; start < sessions.length; start += SESSION_ID_CHUNK) {
				const ids = sessions.slice(start, start + SESSION_ID_CHUNK).map(session => session.id);
				const rows = this.#db
					.prepare(
						`SELECT session_id, title FROM session_index WHERE session_id IN (${ids.map(() => "?").join(",")})`,
					)
					.all(...(ids as [string, ...string[]])) as Array<{ session_id: string; title: string | null }>;
				for (const row of rows) storedTitles.set(row.session_id, row.title?.trim() ?? "");
			}
		} catch (error) {
			// Treating every session as current is the safe failure: it skips the
			// backfill rather than rewriting rows that may already be better.
			logger.warn("SessionIndexStorage outdatedSessionIds failed", { error: String(error) });
			return [];
		}
		const outdated: string[] = [];
		for (const session of sessions) {
			const stored = storedTitles.get(session.id);
			if (stored === undefined) {
				outdated.push(session.id);
				continue;
			}
			const title = session.title?.trim();
			if (title && title !== stored) outdated.push(session.id);
		}
		return outdated;
	}

	/** Upsert a batch in one transaction; the backfill's write path. */
	upsertMany(records: readonly SessionIndexRecord[]): void {
		if (records.length === 0) return;
		try {
			this.#db.transaction((batch: readonly SessionIndexRecord[]) => {
				for (const record of batch) {
					if (!record.sessionId) continue;
					this.#upsertStmt.run(
						record.sessionId,
						record.cwd ?? null,
						record.title ?? null,
						record.keywords ?? null,
						record.summary ?? null,
					);
				}
			})(records);
		} catch (error) {
			logger.warn("SessionIndexStorage bulk upsert failed", { count: records.length, error: String(error) });
		}
	}

	/**
	 * Sessions matching `query`, best first, de-duplicated, at most `limit`.
	 *
	 * Primary path is an FTS5 prefix MATCH with Porter stemming, so "deploying"
	 * reaches a session indexed as "deploy". When that finds nothing we retry as
	 * a token-AND LIKE scan, which catches the infix matches FTS5's prefix-only
	 * wildcard cannot reach ("ploy" -> "deploy") at a fixed low score.
	 */
	search(query: string, limit = 200): SessionIndexHit[] {
		const safeLimit = SessionIndexStorage.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const tokens = SessionIndexStorage.#tokenize(query);
		if (tokens.length === 0) return [];

		const hits = new Map<string, SessionIndexHit>();

		// Quote every token so FTS5 reads it as a literal term: unquoted `AND`,
		// `OR`, `NOT` and `NEAR` are query operators, and a user typing them
		// into a picker means them as words. The trailing `*` is the prefix
		// wildcard, which must sit outside the quotes.
		const ftsQuery = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" AND ");
		try {
			for (const row of this.#ftsSearchStmt.all(ftsQuery, safeLimit) as FtsRow[]) {
				if (!hits.has(row.session_id)) {
					hits.set(row.session_id, {
						sessionId: row.session_id,
						score: SessionIndexStorage.#normalizeBm25(row.rank),
					});
				}
			}
		} catch (error) {
			// Malformed FTS expression, or no FTS table at all - fall through.
			logger.debug("SessionIndexStorage FTS query failed, using substring only", { error: String(error) });
		}

		// `ORDER BY rank` already returned these best-first, and the bm25
		// normalization below is monotone, so the map's insertion order is the
		// score order. No re-sort needed.
		if (hits.size > 0) return [...hits.values()];

		try {
			for (const row of this.#searchSubstring(tokens, safeLimit)) {
				if (!hits.has(row.session_id)) {
					hits.set(row.session_id, { sessionId: row.session_id, score: LIKE_HIT_SCORE });
				}
			}
		} catch (error) {
			logger.warn("SessionIndexStorage substring search failed", { error: String(error) });
			return [];
		}

		// Every fallback hit carries the same score, so the SQL ordering
		// (recency) is what survives the slice.
		return [...hits.values()].slice(0, safeLimit);
	}

	/** Drop the index rows for `sessionIds`. The triggers keep the FTS mirror consistent. */
	prune(sessionIds: readonly string[]): void {
		if (sessionIds.length === 0) return;
		// Unlike `search`, prune runs from gc, not from a keystroke, so the
		// statements are prepared per call instead of cached per arity - the
		// remainder chunk has a different parameter count every time and a
		// permanent cache keyed by it would just accumulate dead statements.
		const statements: Statement[] = [];
		try {
			const tx = this.#db.transaction((ids: readonly string[]) => {
				for (let i = 0; i < ids.length; i += SESSION_ID_CHUNK) {
					const chunk = ids.slice(i, i + SESSION_ID_CHUNK);
					const stmt = this.#db.prepare(
						`DELETE FROM session_index WHERE session_id IN (${Array(chunk.length).fill("?").join(",")})`,
					);
					statements.push(stmt);
					stmt.run(...(chunk as [string, ...string[]]));
				}
			});
			tx(sessionIds);
		} catch (error) {
			logger.warn("SessionIndexStorage prune failed", { count: sessionIds.length, error: String(error) });
		} finally {
			for (const stmt of statements) stmt.finalize();
		}
	}

	/**
	 * Map an FTS5 bm25 rank into `(0, 1]`, higher-is-better.
	 *
	 * FTS5 returns bm25 negated (more negative = better match) and clamps a
	 * non-positive IDF to 1e-6, so the raw value is always <= 0 and its
	 * magnitude is the match strength. `s / (s + K)` is strictly increasing on
	 * `s >= 0`, which means the output ordering is exactly bm25's ordering
	 * (including the column weighting), and it asymptotes to 1 rather than
	 * clipping, so an arbitrarily strong match needs no ceiling. The result is
	 * then lifted into `[FTS_SCORE_FLOOR, 1)` so it cannot collide with the
	 * substring fallback's fixed score.
	 */
	static #normalizeBm25(rank: number): number {
		const strength = Number.isFinite(rank) ? Math.max(0, -rank) : 0;
		const saturated = strength / (strength + BM25_HALF_SATURATION);
		return FTS_SCORE_FLOOR + (1 - FTS_SCORE_FLOOR) * saturated;
	}

	static #normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		return Math.min(Math.max(0, Math.floor(limit)), MAX_SEARCH_LIMIT);
	}

	/**
	 * Split on non-alphanumeric runs, mirroring FTS5's `unicode61` tokenizer so
	 * query tokens align with how the stored text was indexed, and lowercasing
	 * for stable substring matching. Same shape as `HistoryStorage#tokenize`.
	 */
	static #tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(tok => tok.length > 0);
	}

	/**
	 * Token-AND substring scan across all three indexed columns. Each token has
	 * to appear somewhere in the concatenated haystack, not all in one column,
	 * so "deploy staging" still matches a title/summary split.
	 */
	#searchSubstring(tokens: string[], limit: number): LikeRow[] {
		const stmt = this.#getLikeStmt(tokens.length);
		const params: unknown[] = tokens.map(tok => `%${escapeLikePattern(tok)}%`);
		params.push(limit);
		return stmt.all(...(params as [string, ...unknown[]])) as LikeRow[];
	}

	#getLikeStmt(tokenCount: number): Statement {
		let stmt = this.#likeStmts.get(tokenCount);
		if (stmt) return stmt;
		const haystack = "(COALESCE(title,'') || ' ' || COALESCE(keywords,'') || ' ' || COALESCE(summary,''))";
		const whereClause = Array(tokenCount).fill(`${haystack} LIKE ? ESCAPE '\\' COLLATE NOCASE`).join(" AND ");
		stmt = this.#db.prepare(
			`SELECT session_id FROM session_index WHERE ${whereClause} ORDER BY updated_at DESC, session_id ASC LIMIT ?`,
		);
		this.#likeStmts.set(tokenCount, stmt);
		return stmt;
	}
}

/**
 * Harvest up to `limit` salient terms from transcript text, deterministically
 * and without a model.
 *
 * Identifiers are indexed both whole and split, so a later search for either
 * `getUserToken` or `token` finds the session. Ranking is frequency first, then
 * first-occurrence position, which biases the result toward the vocabulary of
 * the opening request - the words a user is most likely to remember a session
 * by - rather than toward whatever the agent was grinding on at the end.
 */
export function extractSessionKeywords(text: string, limit = 24): string[] {
	if (limit <= 0) return [];
	// Bound the scan: see MAX_KEYWORD_INPUT_CHARS.
	const bounded = text.length > MAX_KEYWORD_INPUT_CHARS ? text.slice(0, MAX_KEYWORD_INPUT_CHARS) : text;

	const counts = new Map<string, { count: number; firstSeen: number }>();
	let position = 0;
	const record = (term: string): void => {
		if (!isKeywordCandidate(term)) return;
		const existing = counts.get(term);
		if (existing) {
			existing.count++;
			return;
		}
		counts.set(term, { count: 1, firstSeen: position++ });
	};

	// Splitting on non-alphanumerics already breaks snake_case, kebab-case and
	// dotted paths apart; camelCase has no separator to split on, so each raw
	// token is additionally cut at its case boundaries.
	for (const raw of bounded.split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length === 0) continue;
		record(raw.toLowerCase());
		const parts = splitIdentifier(raw);
		if (parts.length < 2) continue;
		for (const part of parts) record(part.toLowerCase());
	}

	return [...counts.entries()]
		.sort(([, a], [, b]) => b.count - a.count || a.firstSeen - b.firstSeen)
		.slice(0, limit)
		.map(([term]) => term);
}

/**
 * Cut an identifier at camelCase boundaries, keeping acronym runs together:
 * `parseHTTPResponse` -> `parse`, `HTTP`, `Response`. Returns a single element
 * when there is no boundary to cut at.
 */
function splitIdentifier(raw: string): string[] {
	return raw
		.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
		.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
		.split(" ")
		.filter(part => part.length > 0);
}

/**
 * A term earns a place in the index if it can discriminate between sessions.
 * Pure numbers cannot (a line number or a timestamp is not a topic), and
 * neither can stopwords. Short terms are dropped as noise EXCEPT when they mix
 * letters and digits, because that is exactly the shape of the short tokens
 * worth keeping: `s3`, `v1`, `k8s`, `oauth2`.
 */
function isKeywordCandidate(term: string): boolean {
	if (KEYWORD_STOPWORDS.has(term)) return false;
	if (!/\p{L}/u.test(term)) return false;
	if (term.length < 3 && !/\p{N}/u.test(term)) return false;
	return true;
}
