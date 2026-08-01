import {
	type Component,
	Container,
	FuzzyText,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionInfo, SessionStatus } from "../../session/session-listing";
import { shortenPath } from "../../tools/render-utils";
import { DynamicBorder } from "./dynamic-border";
import { HookSelectorComponent } from "./hook-selector";

/**
 * Themed glyph + colored label for a session's lifecycle status, or `undefined`
 * when there is nothing useful to show (`unknown`/unset) so the metadata line
 * stays uncluttered. The glyph resolves through the active symbol preset
 * (nerdfont / unicode / ascii) via `theme.status.*`.
 */
function formatSessionStatus(status: SessionStatus | undefined): string | undefined {
	switch (status) {
		case "complete":
			return theme.fg("success", `${theme.status.success} done`);
		case "interrupted":
			return theme.fg("warning", `${theme.status.warning} interrupted`);
		case "aborted":
			return theme.fg("muted", `${theme.status.aborted} aborted`);
		case "error":
			return theme.fg("error", `${theme.status.error} error`);
		case "pending":
			return theme.fg("accent", `${theme.status.pending} pending`);
		default:
			return undefined;
	}
}

/** Returns the IDs of sessions whose recorded prompts match a query, best first. */
export type SessionHistoryMatcher = (query: string) => string[];

/**
 * Out-of-band relevance signals for a query, gathered from SQLite rather than
 * from the in-memory listing. Both are expensive enough to need debouncing off
 * the keystroke path, so they travel together through one seam.
 */
export interface SessionSearchSignals {
	/** Session IDs whose recorded prompts matched, best first; duplicates tolerated. */
	historyIds?: readonly string[];
	/** Session ID to keyword-index relevance in (0, 1]; higher is better. */
	indexScores?: ReadonlyMap<string, number>;
}

/** Resolves the debounced SQLite-backed signals for a query. */
export type SessionSignalMatcher = (query: string) => SessionSearchSignals;

/**
 * Per-field weights.
 *
 * Resume search is a name lookup first and a full-text search second: when the
 * user types the words they remember, the session whose *title* carries them
 * has to win, even against a much newer session that merely mentions them
 * somewhere in its opening 4KB. Flattening every field into a single haystack
 * (the previous behaviour) made those two indistinguishable and left recency to
 * break the tie, which is exactly the "I typed the name and something else came
 * up first" failure.
 *
 * The ID stays present but nearly weightless: resuming by ID prefix is a real
 * workflow, yet hex IDs substring-match short queries constantly, so
 * {@link idMatchQuality} restricts it to prefixes. `path` is deliberately not a
 * field at all — it is the ID plus a timestamped filename, so it contributed
 * only false hits on date-shaped queries.
 */
const FIELD_WEIGHT = {
	title: 1,
	dirName: 0.55,
	firstMessage: 0.5,
	body: 0.3,
	cwd: 0.25,
	id: 0.12,
} as const;

// Match-kind multipliers applied to the field weight. Graded by how completely
// the token consumes a word, never by where in the field that word sits:
// "Window resize issues" is no less about resizing than "Resize controls" is,
// so position is noise and recency is the honest tiebreaker between them.
const MATCH_EXACT = 1;
const MATCH_WORD = 0.8;
const MATCH_WORD_PREFIX = 0.65;
const MATCH_SUBSTRING = 0.4;

/** Extra credit when the whole multi-token query appears verbatim in the title. */
const TITLE_PHRASE_BONUS = 0.35;

/**
 * Weight of a prompt-history hit. Below a whole-word title match (0.8) and
 * above a body substring (0.3 × 0.4): a session whose transcript contains the
 * phrase is a better guess than one that mentions it in passing, but it must
 * never displace the session actually named after it. Promoting history matches
 * unconditionally (the previous behaviour) is what made an exact title match
 * lose to an unrelated session that once had the word in a prompt.
 */
const HISTORY_SIGNAL_WEIGHT = 0.5;
/** Fraction of {@link HISTORY_SIGNAL_WEIGHT} shed across the history ranking. */
const HISTORY_RANK_DECAY = 0.4;
/** Weight of a stemmed keyword-index hit, scaled by the index's own relevance. */
const INDEX_SIGNAL_WEIGHT = 0.45;

/**
 * Ceiling for the fuzzy fallback, reached only by a perfect subsequence match.
 * Fuzzy hits are a last resort — they exist so a typo or an acronym still finds
 * something — so their best case stays below the weakest literal title hit.
 */
const FUZZY_SIGNAL_WEIGHT = 0.28;
/** `FuzzyText` score for an exact word hit; the normalization denominator. */
const FUZZY_BEST_SCORE = -200;

const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

/** Per-field lowercased text for one session, plus the fuzzy fallback corpus. */
interface SessionSearchFields {
	title: string;
	/** Basename of `cwd`: the project name, which is what users actually type. */
	dirName: string;
	firstMessage: string;
	body: string;
	cwd: string;
	id: string;
	/** Combined corpus, used only when no field matched literally. */
	haystack: string;
}

/**
 * Per-session search fields, built once and cached on the {@link SessionInfo}
 * itself (so they die with the listing that produced them). Rebuilding them per
 * keystroke — several string slices plus `toLowerCase` over a ~4KB corpus per
 * session — was one of the costs that made resume search visibly lag.
 *
 * Only strings are cached. A prebuilt fuzzy index (~60KB per 4KB session) would
 * cost hundreds of MB on multi-thousand-session listings, so fuzzy indexes are
 * built transiently per scan visit instead (see {@link scoreFuzzySession}).
 */
const kSearchFields = Symbol("session.searchFields");

interface SearchableSessionInfo extends SessionInfo {
	[kSearchFields]?: SessionSearchFields;
}

function sessionFields(session: SessionInfo): SessionSearchFields {
	const tagged = session as SearchableSessionInfo;
	let fields = tagged[kSearchFields];
	if (fields === undefined) {
		const cwd = (session.cwd ?? "").toLowerCase();
		fields = {
			title: (session.title ?? "").toLowerCase(),
			dirName: cwd.slice(Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\")) + 1),
			firstMessage: (session.firstMessage ?? "").toLowerCase(),
			body: (session.allMessagesText ?? "").toLowerCase(),
			cwd,
			id: session.id.toLowerCase(),
			haystack: "",
		};
		fields.haystack = [fields.title, fields.cwd, fields.firstMessage, fields.body, fields.id]
			.filter(Boolean)
			.join(" ");
		tagged[kSearchFields] = fields;
	}
	return fields;
}

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSessionRecency(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

function isWordChar(code: number): boolean {
	// 0-9, A-Z, a-z. Fields are already lowercased, but the uppercase range is
	// kept so the helper stays correct if it is ever pointed at raw text.
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Best match kind for `token` anywhere in `field`, as a multiplier in [0, 1].
 * Scans every occurrence because the first one is often the worst: "auth" in
 * "reauthenticate the auth proxy" should score as a word hit, not a substring.
 */
function matchQuality(field: string, token: string): number {
	if (!field || !token) return 0;
	if (field === token) return MATCH_EXACT;
	let best = 0;
	for (let at = field.indexOf(token); at !== -1; at = field.indexOf(token, at + 1)) {
		const end = at + token.length;
		if (at > 0 && isWordChar(field.charCodeAt(at - 1))) {
			if (best < MATCH_SUBSTRING) best = MATCH_SUBSTRING;
			continue;
		}
		const quality = end === field.length || !isWordChar(field.charCodeAt(end)) ? MATCH_WORD : MATCH_WORD_PREFIX;
		if (quality > best) best = quality;
		if (best === MATCH_WORD) break;
	}
	return best;
}

/** Session IDs match by prefix only: a hex ID substring-matches short queries constantly. */
function idMatchQuality(id: string, token: string): number {
	if (!id || !token) return 0;
	if (id === token) return MATCH_EXACT;
	return id.startsWith(token) ? MATCH_WORD_PREFIX : 0;
}

/** One ranked search hit; `index` is the session's position in the unfiltered list. */
interface RankedSessionMatch {
	session: SessionInfo;
	/** Text relevance. Query-independent signals are added at compose time. */
	quality: number;
	index: number;
}

/**
 * Field-weighted relevance for one session, or undefined when some query token
 * matches no field at all. Tokens are ANDed and the per-token bests are
 * averaged, so adding a token that only matches weakly drags the whole session
 * down rather than padding its score.
 */
function scoreSessionFields(fields: SessionSearchFields, tokens: string[], phrase: string): number | undefined {
	let total = 0;
	for (const token of tokens) {
		const quality = Math.max(
			FIELD_WEIGHT.title * matchQuality(fields.title, token),
			FIELD_WEIGHT.dirName * matchQuality(fields.dirName, token),
			FIELD_WEIGHT.firstMessage * matchQuality(fields.firstMessage, token),
			FIELD_WEIGHT.body * matchQuality(fields.body, token),
			FIELD_WEIGHT.cwd * matchQuality(fields.cwd, token),
			FIELD_WEIGHT.id * idMatchQuality(fields.id, token),
		);
		if (quality === 0) return undefined;
		total += quality;
	}
	let score = total / tokens.length;
	// Word order carries intent: "resize buffer" naming a session beats a
	// session that happens to contain both words far apart.
	if (tokens.length > 1 && fields.title.includes(phrase)) score += TITLE_PHRASE_BONUS;
	return score;
}

/**
 * Fuzzy-score one session that matched no field literally. Returns undefined
 * when a token fails to match or the weakest token is pure-fuzzy noise. The
 * caller builds `fuzzy` once per session visit so multi-token queries share a
 * single index.
 */
function scoreFuzzySession(tokens: string[], fuzzy: FuzzyText): number | undefined {
	let total = 0;
	let worstTokenScore = Number.NEGATIVE_INFINITY;
	for (const token of tokens) {
		const match = fuzzy.match(token);
		if (!match.matches) return undefined;
		total += match.score;
		worstTokenScore = Math.max(worstTokenScore, match.score);
	}
	if (worstTokenScore >= MIN_PURE_FUZZY_TOKEN_SCORE) return undefined;
	// FuzzyText scores are negative and more negative is better; normalize
	// against an exact-word hit and clamp, since phrase bonuses overshoot it.
	const normalized = Math.min(1, total / tokens.length / FUZZY_BEST_SCORE);
	return normalized * FUZZY_SIGNAL_WEIGHT;
}

/**
 * Rank-decayed credit for a prompt-history hit, so the best-matching prompt
 * outranks the tenth one without either dropping out of contention.
 */
function historyBonus(rank: number, count: number): number {
	return HISTORY_SIGNAL_WEIGHT * (1 - (count > 1 ? (HISTORY_RANK_DECAY * rank) / (count - 1) : 0));
}

/**
 * Fold the SQLite-backed signals into the text scores and produce the final
 * order: score descending, then recency, then original list position.
 *
 * Signals both boost and admit. A session whose transcript matched deep past
 * the 4KB listing corpus, or whose harvested keywords matched a word the
 * transcript never spells, has no text score at all and would otherwise be
 * invisible; here it enters the results carrying only its signal weight, which
 * keeps it below anything the query literally names.
 */
function composeSessionRanking(
	matches: readonly RankedSessionMatch[],
	allSessions: readonly SessionInfo[],
	signals: SessionSearchSignals | undefined,
): SessionInfo[] {
	const bonuses = new Map<string, number>();
	const historyIds = signals?.historyIds;
	if (historyIds && historyIds.length > 0) {
		for (let rank = 0; rank < historyIds.length; rank++) {
			const id = historyIds[rank]!;
			if (bonuses.has(id)) continue;
			bonuses.set(id, historyBonus(rank, historyIds.length));
		}
	}
	const indexScores = signals?.indexScores;
	if (indexScores) {
		for (const [id, score] of indexScores) {
			bonuses.set(id, (bonuses.get(id) ?? 0) + INDEX_SIGNAL_WEIGHT * score);
		}
	}

	const scored: RankedSessionMatch[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		seen.add(match.session.path);
		const bonus = bonuses.get(match.session.id);
		scored.push(bonus === undefined ? match : { ...match, quality: match.quality + bonus });
	}
	if (bonuses.size > 0) {
		for (let index = 0; index < allSessions.length; index++) {
			const session = allSessions[index]!;
			if (seen.has(session.path)) continue;
			const bonus = bonuses.get(session.id);
			if (bonus === undefined) continue;
			seen.add(session.path);
			scored.push({ session, quality: bonus, index });
		}
	}

	scored.sort((a, b) => b.quality - a.quality || compareSessionRecency(a.session, b.session) || a.index - b.index);
	return scored.map(match => match.session);
}

/**
 * Filter and rank session picker search results.
 *
 * Every session is scored per field ({@link scoreSessionFields}); those that
 * match no field literally fall back to a fuzzy pass over the combined corpus.
 * Prompt-history and keyword-index signals are added on top rather than
 * reordering the result wholesale, and recency only breaks ties — sessions that
 * match the query the same way end up in recency order, which is the behaviour
 * that made the old recency-first ranking feel right on ambiguous queries
 * without letting it override an unambiguous one.
 *
 * This is the synchronous reference implementation; {@link SessionList} runs
 * the same primitives incrementally so huge listings never block a keystroke.
 */
export function rankSessionSearchMatches(
	allSessions: SessionInfo[],
	query: string,
	signals?: SessionSearchSignals,
): SessionInfo[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return allSessions;
	const phrase = tokens.join(" ");

	const matches: RankedSessionMatch[] = [];
	for (let index = 0; index < allSessions.length; index++) {
		const session = allSessions[index]!;
		const fields = sessionFields(session);
		const literal = scoreSessionFields(fields, tokens, phrase);
		if (literal !== undefined) {
			matches.push({ session, quality: literal, index });
			continue;
		}
		const fuzzy = scoreFuzzySession(tokens, new FuzzyText(fields.haystack));
		if (fuzzy !== undefined) matches.push({ session, quality: fuzzy, index });
	}
	return composeSessionRanking(matches, allSessions, signals);
}

/**
 * Delay before the SQLite-backed signal DBs are consulted for the current
 * query. Both lookups are synchronous (an FTS lookup plus a LIKE scan over
 * every stored prompt — tens to hundreds of ms on a year-old database), so
 * they must never run per keystroke: text results render immediately and the
 * signal merge lands once typing pauses.
 */
const SIGNAL_MERGE_DEBOUNCE_MS = 150;
/**
 * Minimum query length for signal augmentation. A single character matches
 * essentially every stored prompt — the most expensive FTS prefix to expand —
 * and only reorders the result list by noise.
 */
const SIGNAL_MERGE_MIN_QUERY = 2;

/**
 * Sessions fuzzy-scored synchronously inside the keystroke itself. Small
 * listings finish within it, keeping the complete-in-one-frame behavior;
 * anything left spills into async chunks. A fuzzy visit costs ~100µs (index
 * build over the ≤4KB per-session corpus dominates), so 100 visits ≈ 10ms —
 * about one frame. Counts rather than a deadline keep chunk boundaries
 * deterministic (and testable under fake timers).
 */
const FUZZY_SCAN_INLINE_COUNT = 100;
/**
 * Sessions fuzzy-scored per async chunk (~15ms). Each chunk yields back to
 * the event loop so the next keystroke is never blocked behind a long scan; a
 * new query bumps the scan generation and orphans pending chunks.
 */
const FUZZY_SCAN_CHUNK_COUNT = 150;

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex: number = 0;
	// Maps a 0-based line within this list's own render to a filtered-session
	// index, or undefined for chrome rows (search line, blanks, scrollbar gap).
	// Rebuilt every render so the picker's mouse hit-testing tracks the live
	// scroll window. Only consulted while the picker holds the alternate screen
	// (where the overlay enables mouse tracking and paints from screen row 0).
	#hitRows: (number | undefined)[] = [];
	readonly #searchInput: Input;
	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;
	// Snapshot of the live terminal-row getter; the visible window is derived
	// from it per render so the picker fits the viewport (and adapts to resize).
	readonly #getTerminalRows: () => number;

	onDeleteRequest?: (session: SessionInfo) => void;

	#allSessions: SessionInfo[];
	#showCwd: boolean;
	readonly #signalMatcher?: SessionSignalMatcher;
	#signalMergeTimer: NodeJS.Timeout | undefined;
	/** Re-render hook for async list updates (fuzzy scan chunks, signal merge). */
	onRequestRender?: () => void;

	// ── Incremental search state ──────────────────────────────────────────
	// #filteredSessions is always composed from these three inputs (see
	// #composeFiltered), so late-arriving fuzzy chunks and the debounced
	// signal merge can land in any order without clobbering each other.
	/** Field-scored matches: every session where some field matched literally. */
	#textRanked: RankedSessionMatch[] = [];
	/** Fuzzy-only matches, appended by scan chunks. */
	#fuzzyRanked: RankedSessionMatch[] = [];
	/** Prompt-history and keyword-index signals, once the merge landed. */
	#signals: SessionSearchSignals | undefined;
	/** Invalidates in-flight scan chunks when the query or dataset changes. */
	#scanGeneration = 0;
	#scanTimer: NodeJS.Timeout | undefined;
	/**
	 * True once the user moved the selection for the current query; blocks the
	 * signal merge from reordering the list under their cursor. Fuzzy chunks
	 * still compose in — a query with only fuzzy hits would otherwise render
	 * empty forever — but they score below every strong literal hit, so they
	 * land at the bottom rather than under the cursor.
	 */
	#selectionMoved = false;

	constructor(
		sessions: SessionInfo[],
		showCwd = false,
		signalMatcher?: SessionSignalMatcher,
		getTerminalRows: () => number = () => 24,
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#signalMatcher = signalMatcher;
		this.#filteredSessions = sessions;
		this.#searchInput = new Input();

		// Handle Enter in search input - select current item
		this.#searchInput.onSubmit = () => {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) {
				this.onSelect?.(selected);
			}
		};
	}

	/**
	 * Number of sessions to show at once, sized so the whole picker fits the
	 * current viewport instead of pushing its header/search off the top.
	 *
	 * Budget = rows − chrome − reserve, divided by the worst-case per-session
	 * height. Chrome (12) is the surrounding spacers/borders/header (7) plus the
	 * list's search line, blank, scroll indicator, blank, and hint (5). A titled
	 * session is the tallest item at 4 lines (title + preview + metadata +
	 * blank); budgeting for that guarantees no overflow even when every visible
	 * entry has a title. The reserve covers below-editor hook widgets / cursor.
	 */
	#visibleCount(): number {
		const CHROME = 12;
		const PER_SESSION = 4;
		const RESERVE = 1;
		const budget = this.#getTerminalRows() - CHROME - RESERVE;
		return Math.max(2, Math.floor(budget / PER_SESSION));
	}

	/** Replace the visible dataset, e.g. when toggling folder/all-projects scope. */
	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#selectedIndex = 0;
		this.#filterSessions(this.#searchInput.getValue());
	}

	#filterSessions(query: string): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		this.#selectionMoved = false;
		this.#signals = undefined;
		this.#textRanked = [];
		this.#fuzzyRanked = [];

		const tokens = tokenizeSessionQuery(query);
		if (tokens.length === 0) {
			this.#filteredSessions = this.#allSessions;
			this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
			this.#scheduleSignalMerge(query);
			return;
		}

		// Field pass: a handful of substring scans per token per session,
		// synchronous so every keystroke gets immediate feedback regardless of
		// listing size. Cost is dominated by the ≤4KB body field, i.e. the same
		// order as the single-haystack scan it replaced.
		const phrase = tokens.join(" ");
		const text: RankedSessionMatch[] = [];
		const rest: number[] = [];
		const all = this.#allSessions;
		for (let index = 0; index < all.length; index++) {
			const session = all[index]!;
			const quality = scoreSessionFields(sessionFields(session), tokens, phrase);
			if (quality === undefined) rest.push(index);
			else text.push({ session, quality, index });
		}
		this.#textRanked = text;

		// Fuzzy pass: building a fuzzy index per session is too expensive to run
		// across a huge listing inside one keystroke, so scan a bounded slice now
		// and spill the remainder into async chunks.
		this.#scanFuzzySlice(this.#scanGeneration, tokens, rest, 0, FUZZY_SCAN_INLINE_COUNT);
		this.#composeFiltered();
		this.#scheduleSignalMerge(query);
	}

	/**
	 * Score up to `budget` sessions from `rest[start..]` (indexes into the
	 * unfiltered list), then schedule the remainder on a macrotask so pending
	 * input events run first. Chunks that added matches recompose the visible
	 * list and request a render; a stale generation aborts silently.
	 */
	#scanFuzzySlice(generation: number, tokens: string[], rest: number[], start: number, budget: number): void {
		const all = this.#allSessions;
		const end = Math.min(rest.length, start + budget);
		for (let i = start; i < end; i++) {
			const index = rest[i]!;
			const session = all[index]!;
			const quality = scoreFuzzySession(tokens, new FuzzyText(sessionFields(session).haystack));
			if (quality !== undefined) this.#fuzzyRanked.push({ session, quality, index });
		}
		if (end >= rest.length) return;
		this.#scanTimer = setTimeout(() => {
			this.#scanTimer = undefined;
			if (generation !== this.#scanGeneration) return;
			const before = this.#fuzzyRanked.length;
			this.#scanFuzzySlice(generation, tokens, rest, end, FUZZY_SCAN_CHUNK_COUNT);
			if (this.#fuzzyRanked.length > before) {
				this.#composeFiltered();
				this.onRequestRender?.();
			}
		}, 0);
	}

	/**
	 * Rebuild {@link #filteredSessions} from the field pass, the fuzzy chunks
	 * that have landed so far, and the debounced signals, through the same
	 * composer the synchronous {@link rankSessionSearchMatches} uses — so the
	 * incremental result converges on exactly the reference order.
	 */
	#composeFiltered(): void {
		this.#filteredSessions = composeSessionRanking(
			[...this.#textRanked, ...this.#fuzzyRanked],
			this.#allSessions,
			this.#signals,
		);
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
	}

	/**
	 * Augment ranked results with the SQLite-backed signals without replacing
	 * them. The session-list corpus only sees the first 4KB of each session, so a
	 * prompt typed deep into a long session is invisible to text search, and a
	 * session's harvested topic keywords live outside the JSONL entirely;
	 * `signalMatcher` recovers both. The lookups hit SQLite synchronously, so
	 * they are debounced off the keystroke path
	 * ({@link SIGNAL_MERGE_DEBOUNCE_MS}) and composed in when they land,
	 * discarded if the query changed meanwhile.
	 */
	#scheduleSignalMerge(query: string): void {
		if (this.#signalMergeTimer !== undefined) {
			clearTimeout(this.#signalMergeTimer);
			this.#signalMergeTimer = undefined;
		}
		const matcher = this.#signalMatcher;
		const trimmed = query.trim();
		if (!matcher || trimmed.length < SIGNAL_MERGE_MIN_QUERY) return;
		this.#signalMergeTimer = setTimeout(() => {
			this.#signalMergeTimer = undefined;
			if (this.#searchInput.getValue() !== query) return;
			if (this.#selectionMoved) return;
			const signals = matcher(trimmed);
			if ((signals.historyIds?.length ?? 0) === 0 && (signals.indexScores?.size ?? 0) === 0) return;
			this.#signals = signals;
			this.#composeFiltered();
			this.onRequestRender?.();
		}, SIGNAL_MERGE_DEBOUNCE_MS);
	}

	/** Cancel pending async search work; idempotent, called on every picker exit path. */
	dispose(): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		if (this.#signalMergeTimer !== undefined) {
			clearTimeout(this.#signalMergeTimer);
			this.#signalMergeTimer = undefined;
		}
	}

	removeSession(sessionPath: string): void {
		const index = this.#allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.#allSessions.splice(index, 1);
		// Re-filter to update filteredSessions
		this.#filterSessions(this.#searchInput.getValue());
		// Adjust selectedIndex if we deleted the last item or beyond
		if (this.#selectedIndex >= this.#filteredSessions.length) {
			this.#selectedIndex = Math.max(0, this.#filteredSessions.length - 1);
		}
	}

	/** Resolve a list-local rendered-line index to a filtered-session index. */
	hitTestSession(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Wheel notch: move the selection one step (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#filteredSessions.length === 0) return;
		this.#selectionMoved = true;
		this.#selectedIndex = Math.max(0, Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + delta));
	}

	/** Mouse click: select the session under the pointer and resume it. */
	selectAndConfirm(index: number): void {
		const session = this.#filteredSessions[index];
		if (!session) return;
		this.#selectedIndex = index;
		this.onSelect?.(session);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		// Render search input
		lines.push(...this.#searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.#filteredSessions.length === 0) {
			if (this.#showCwd) {
				// "All" scope - no sessions anywhere that match filter
				lines.push(truncateToWidth(theme.fg("muted", "  No sessions found"), width));
			} else {
				// "Current folder" scope - hint to try "all"
				lines.push(
					truncateToWidth(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		// Format dates
		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return "just now";
			if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
			if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
			if (diffDays === 1) return "1 day ago";
			if (diffDays < 7) return `${diffDays} days ago`;

			return date.toLocaleDateString();
		};

		// Calculate visible range with scrolling. The window is sized to the
		// current viewport so the picker never overflows past the top.
		const maxVisible = this.#visibleCount();
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredSessions.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#filteredSessions.length);

		// Render visible sessions (3 lines, or 4 when a title adds a preview line).
		// Each session block is built into sessionLines, then wrapped by ScrollView
		// so the right-edge scrollbar is proportional at the physical-line level.
		const sessionLines: string[] = [];
		const sessionRowIndex: number[] = [];
		const overflow = this.#filteredSessions.length > maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		for (let i = startIndex; i < endIndex; i++) {
			const blockStart = sessionLines.length;
			const session = this.#filteredSessions[i];
			const isSelected = i === this.#selectedIndex;

			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + title (or first message if no title)
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth; // Account for cursor width

			if (session.title) {
				// Has title: show title on first line, dimmed first message on second line
				const truncatedTitle = truncateToWidth(session.title, maxWidth);
				const titleLine = cursor + (isSelected ? theme.bold(truncatedTitle) : truncatedTitle);
				sessionLines.push(titleLine);

				// Second line: dimmed first message preview
				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				sessionLines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				// No title: show first message as main line
				const truncatedMsg = truncateToWidth(normalizedMessage, maxWidth);
				const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);
				sessionLines.push(messageLine);
			}

			// Metadata line: date + file size + lifecycle status (+ project dir in
			// all-projects scope). The status segment carries its own color, so each
			// segment is dimmed individually rather than wrapping the whole line.
			const dim = (s: string) => theme.fg("dim", s);
			const dot = dim(theme.sep.dot);
			const modified = formatDate(session.modified);
			let metadata = `  ${dim(modified)} ${dot} ${dim(formatBytes(session.size))}`;
			const status = formatSessionStatus(session.status);
			if (status) {
				metadata += ` ${dot} ${status}`;
			}
			if (session.parentSessionPath) {
				metadata += ` ${dot} ${dim(`${theme.icon.branch} fork`)}`;
			}
			if (this.#showCwd && session.cwd) {
				metadata += ` ${dot} ${dim(shortenPath(session.cwd))}`;
			}
			const metadataLine = truncateToWidth(metadata, rowWidth);

			sessionLines.push(metadataLine);
			sessionLines.push(""); // Blank line between sessions
			for (let k = blockStart; k < sessionLines.length; k++) sessionRowIndex[k] = i;
		}

		// Wrap the rendered window in a ScrollView for a proportional right-edge bar.
		const visibleCount = endIndex - startIndex;
		const linesPerItem = visibleCount > 0 ? sessionLines.length / visibleCount : 1;
		const sv = new ScrollView(sessionLines, {
			height: sessionLines.length,
			scrollbar: "auto",
			totalRows: Math.round(this.#filteredSessions.length * linesPerItem),
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(Math.round(startIndex * linesPerItem));
		const sessionRegionStart = lines.length;
		const svLines = sv.render(width);
		for (let k = 0; k < svLines.length; k++) this.#hitRows[sessionRegionStart + k] = sessionRowIndex[k];
		lines.push(...svLines);

		return lines;
	}

	handleInput(keyData: string): void {
		// Delete key — or Backspace on an empty search query — request delete
		// confirmation from the parent. macOS laptops have no dedicated Forward
		// Delete key: Fn+Backspace is the only way to send \e[3~, and many macOS
		// terminals (Terminal.app, some iTerm2 profiles) deliver \x7f for that
		// combo instead. Regular Backspace on an empty query means "delete
		// session"; with a typed query it stays bound to the search Input so users
		// can still edit their filter text.
		if (
			matchesKey(keyData, "delete") ||
			(matchesKey(keyData, "backspace") && this.#searchInput.getValue().length === 0)
		) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onDeleteRequest) {
				this.onDeleteRequest(selected);
			}
			return;
		}
		// Up arrow
		if (matchesSelectUp(keyData)) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		// Down arrow
		if (matchesSelectDown(keyData)) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + 1);
			return;
		}
		// Page up - jump up by maxVisible items
		if (matchesKey(keyData, "pageUp")) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#visibleCount());
			return;
		}
		// Page down - jump down by maxVisible items
		if (matchesKey(keyData, "pageDown")) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + this.#visibleCount());
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected);
			}
			return;
		}
		// Escape - cancel
		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}
		// Ctrl+C - exit
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		// Tab - toggle folder / all-projects scope
		if (matchesKey(keyData, "tab")) {
			this.onToggleScope?.();
			return;
		}
		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

export interface SessionSelectorOptions {
	onDelete?: (session: SessionInfo) => Promise<boolean>;
	/** Resolves the debounced prompt-history and keyword-index signals for a query. */
	signalMatcher?: SessionSignalMatcher;
	/** Loads sessions across all projects for the all-projects scope toggle (Tab). */
	loadAllSessions?: () => Promise<SessionInfo[]>;
	/** Preloaded all-projects list; cached so the first Tab toggle is instant. */
	allSessions?: SessionInfo[];
	/** Picker heading; defaults to "Resume Session". */
	title?: string;
	/** Fixed scope label, or false to omit the scope suffix. */
	scopeLabel?: string | false;
	/** Show each session's working directory in the list. */
	showCwd?: boolean;
	/**
	 * Reads the live terminal height so the visible window fits the viewport.
	 * Omitted only in tests; defaults to a conservative 24 rows.
	 */
	getTerminalRows?: () => number;
	/**
	 * Fill the whole viewport and pin the footer (hint + bottom border) to the
	 * last rows, so the footer stops drifting as the list window changes height.
	 * Set by the standalone `--resume` picker (fullscreen alternate screen); the
	 * in-editor selector leaves it off and renders compactly.
	 */
	fillHeight?: boolean;
}

/**
 * Component that renders a session selector with optional confirmation dialog
 */
export class SessionSelectorComponent extends Container {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	// Hosts whichever of `#sessionList` / `#confirmationDialog` is live this
	// frame. The delete dialog REPLACES the list in this slot rather than being
	// appended below the picker chrome, so the picker is always
	// `chrome + max(list, dialog) + chrome` and never overflows the viewport
	// (issue #3283: an overflowing dialog frame committed the header into
	// scrollback, stranding it above the viewport once the dialog closed).
	#contentSlot: Container;
	#messageContainer: Container;
	#headerText: Text;
	#onDelete?: (session: SessionInfo) => Promise<boolean>;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<SessionInfo[]>;
	#folderSessions: SessionInfo[];
	#globalSessions: SessionInfo[] | null = null;
	#scope: "folder" | "all" = "folder";
	#toggling = false;
	#inputLocked = false;
	// 0-based line where the session list begins within this component's own
	// render, captured each frame. The fullscreen picker overlay paints from
	// screen row 0, so a mouse row maps to `row - #listLineOffset` inside the
	// list. Only meaningful while the picker holds the alternate screen.
	#listLineOffset = 0;
	// 0-based line where the pinned footer begins; clicks at or below it never
	// hit-test the list, so a footer click on a cramped (trimmed) frame can't
	// resume a session scrolled off-screen.
	#footerStart = 0;
	readonly #getTerminalRows: () => number;
	readonly #fillHeight: boolean;
	readonly #bottomBorder = new DynamicBorder();
	readonly #title: string;
	readonly #scopeLabel: string | false | undefined;

	constructor(
		sessions: SessionInfo[],
		onSelect: (session: SessionInfo) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionSelectorOptions = {},
	) {
		super();

		this.#messageContainer = new Container();
		this.#onDelete = options.onDelete;
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		this.#globalSessions = options.allSessions ?? null;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		this.#fillHeight = options.fillHeight ?? false;
		this.#title = options.title ?? "Resume Session";
		this.#scopeLabel = options.scopeLabel;
		// Add header
		this.addChild(new Spacer(1));
		this.#headerText = new Text(this.#headerLabel(), 1, 0);
		this.addChild(this.#headerText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		// Create session list in folder scope; the empty-state hint invites the
		// user to Tab into all-projects rather than silently surfacing other
		// projects' history (issue #3099).
		this.#sessionList = new SessionList(
			sessions,
			options.showCwd ?? false,
			options.signalMatcher,
			options.getTerminalRows,
		);
		// Every exit path cancels the list's pending signal merge, so a stale
		// debounce timer can never run its SQLite lookups after the picker closed.
		this.#sessionList.onSelect = session => {
			this.#sessionList.dispose();
			onSelect(session);
		};
		this.#sessionList.onCancel = () => {
			this.#sessionList.dispose();
			onCancel();
		};
		this.#sessionList.onExit = () => {
			this.#sessionList.dispose();
			onExit();
		};
		this.#sessionList.onRequestRender = () => this.#onRequestRender?.();
		this.#sessionList.onDeleteRequest = (session: SessionInfo) => {
			this.#showDeleteConfirmation(session);
		};
		if (this.#loadAllSessions || this.#globalSessions) {
			this.#sessionList.onToggleScope = () => {
				void this.#toggleScope();
			};
		}
		this.#contentSlot = new Container();
		this.#contentSlot.addChild(this.#sessionList);
		this.addChild(this.#contentSlot);
	}

	#headerLabel(): string {
		if (this.#scopeLabel === false) return theme.bold(this.#title);
		const scopeLabel = this.#scopeLabel ?? (this.#scope === "all" ? "all projects" : "current folder");
		return `${theme.bold(this.#title)} ${theme.fg("muted", `(${scopeLabel})`)}`;
	}

	/**
	 * Toggle between current-folder and all-projects scope. The global list is
	 * loaded lazily on first switch and cached, so the common folder-scope path
	 * never pays for the cross-project scan.
	 */
	async #toggleScope(): Promise<void> {
		if (this.#toggling || this.#confirmationDialog) return;
		if (this.#scope === "folder") {
			let global = this.#globalSessions;
			if (!global) {
				if (!this.#loadAllSessions) return;
				this.#toggling = true;
				this.#messageContainer.clear();
				this.#messageContainer.addChild(new Text(theme.fg("muted", "  Loading all projects…"), 1, 0));
				this.#onRequestRender?.();
				try {
					global = await this.#loadAllSessions();
				} catch (err) {
					this.#showError(err instanceof Error ? err.message : String(err));
					this.#toggling = false;
					this.#onRequestRender?.();
					return;
				}
				this.#globalSessions = global;
				this.#messageContainer.clear();
				this.#toggling = false;
			}
			this.#scope = "all";
			this.#sessionList.setSessions(global, true);
		} else {
			this.#scope = "folder";
			this.#sessionList.setSessions(this.#folderSessions, false);
		}
		this.#headerText.setText(this.#headerLabel());
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}
	/** Ignore input after selection while the host resumes the session. */
	lockInput(): void {
		this.#inputLocked = true;
	}
	/** Re-enable input after a failed resume so the user can pick again. */
	unlockInput(): void {
		this.#inputLocked = false;
	}

	/**
	 * Dispose the session list explicitly: while the delete-confirmation dialog
	 * is mounted the list is detached from the child tree, so Container's
	 * child-walking dispose would miss its pending history-merge timer.
	 */
	override dispose(): void {
		this.#sessionList.dispose();
		super.dispose();
	}

	#clearError(): void {
		this.#messageContainer.clear();
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 1, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: SessionInfo): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		const closeDialog = () => {
			this.#confirmationDialog = null;
			// Restore the SessionList into the content slot so the picker is back
			// to its normal layout on the very next render — the same frame the
			// dialog disappears.
			this.#contentSlot.clear();
			this.#contentSlot.addChild(this.#sessionList);
			this.#onRequestRender?.();
		};
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete session?\n${displayName}`,
			["Yes", "No"],
			async (option: string) => {
				if (option === "Yes" && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
						}
					} catch (err) {
						this.#showError(err instanceof Error ? err.message : String(err));
					}
				}
				closeDialog();
			},
			closeDialog,
		);
		// Swap the SessionList out of the content slot and mount the dialog in its
		// place: the dialog competes only with the SessionList's rendered budget,
		// never the SessionList AND the picker chrome, so the picker frame stays
		// inside the terminal viewport and the TUI never commits the header into
		// scrollback (issue #3283).
		this.#contentSlot.clear();
		this.#contentSlot.addChild(this.#confirmationDialog);
		this.#onRequestRender?.();
	}

	/**
	 * Concatenate the children's renders (like {@link Container}) while recording
	 * the line where the session list begins, so the fullscreen picker can hit-
	 * test mouse rows against the live list window. SessionList rebuilds its lines
	 * every frame, so Container's reference-memoization never applied here.
	 *
	 * In fill-height mode the body is padded (or, on a cramped terminal, trimmed)
	 * to leave exactly enough room for the footer at the screen bottom, so the
	 * footer is always visible and never drifts as the list window resizes. The
	 * in-editor selector just appends the footer directly.
	 */
	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			if (child === this.#contentSlot) this.#listLineOffset = lines.length;
			for (const line of childLines) lines.push(line);
		}
		const footer = this.#footerLines(width);
		if (this.#fillHeight) {
			const target = Math.max(0, this.#getTerminalRows() - footer.length);
			if (lines.length > target) lines.length = target;
			else for (let i = lines.length; i < target; i++) lines.push("");
		}
		this.#footerStart = lines.length;
		for (const line of footer) lines.push(line);
		return lines;
	}

	/** Blank · keybinding hint · bottom border. Rendered by {@link render}. */
	#footerLines(width: number): string[] {
		const scopeHint = this.#scope === "all" ? "current folder" : "all projects";
		const hint = theme.fg("muted", `  [Del/⌫ delete · Enter select · Tab ${scopeHint} · Esc cancel]`);
		return ["", hint, "", ...this.#bottomBorder.render(width)];
	}

	handleInput(keyData: string): void {
		if (this.#inputLocked) return;
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	/**
	 * SGR mouse reports, delivered only while the picker holds the alternate
	 * screen (the fullscreen overlay enables tracking and paints from screen row
	 * 0). Wheel scrolls the list; a left click resumes the session under the
	 * pointer. Mouse is inert while the delete-confirmation dialog is open.
	 */
	#handleMouse(data: string): void {
		if (this.#confirmationDialog) return;
		routeSgrMouseInput(data, event => {
			if (event.wheel !== null) {
				this.#sessionList.handleWheel(event.wheel);
				return true;
			}
			if (!event.leftClick || event.row >= this.#footerStart) return true;
			const index = this.#sessionList.hitTestSession(event.row - this.#listLineOffset);
			if (index !== undefined) this.#sessionList.selectAndConfirm(index);
			return true;
		});
	}

	getSessionList(): SessionList {
		return this.#sessionList;
	}
}
