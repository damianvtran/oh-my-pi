/**
 * Session theme naming: the prompt that names a session and the policy deciding
 * when that name may change.
 *
 * The failure mode this replaces: every accepted `todo` tool result scheduled a
 * title refresh, and the refresh saw only the last handful of turns. A session
 * was therefore renamed on each replan, to whatever had just been typed. Working
 * sessions ended up called after the file open at the moment of the last replan,
 * and the name a user had learned to recognize in the picker kept moving.
 *
 * Three parts fix it, and none of them works alone:
 *
 * 1. Hysteresis (this module) — a refresh is allowed only after the transcript
 *    has grown substantially since the last one, and only a bounded number of
 *    times. Without the gate, better context just produces a better title far
 *    too often.
 * 2. Whole-trajectory context (`buildSessionThemeContext`) — the sampler keeps
 *    the opening turns, which are the only ones that state the subject rather
 *    than a step inside it. Without them, a rate limit only slows the drift.
 * 3. A current-title anchor (`<current-title>` in the theme prompt) — the model
 *    is asked to repeat the existing name verbatim unless the subject genuinely
 *    changed. Without it, two runs over the same conversation still disagree on
 *    wording, so the name churns even when the theme is stable.
 *
 * Resulting schedule, with `lastTitledTurnCount` set on each accepted title:
 * titled at turn 1, next refresh at turn >= 6, then >= 16, then >= 36, then
 * >= 76, then >= 156 — five refreshes, then never again. The spacing is
 * geometric on purpose: an early session is still deciding what it is about and
 * should re-title cheaply, while a long-running one is settled and its name must
 * stop tracking the cursor.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import titleThemeSystemPrompt from "../prompts/system/title-theme-system.md" with { type: "text" };
import { stripChatScaffolding } from "../tiny/message-preproc";
import { extractSessionKeywords } from "./session-index-storage";

/** System prompt asking for the conversation's overall theme, not its last turn. */
export const THEME_TITLE_SYSTEM_PROMPT = prompt.render(titleThemeSystemPrompt);

/**
 * Hard cap on automatic theme refreshes per session. Past this the name is
 * final: a session with hundreds of turns has an established identity, and the
 * growth gate alone would still permit a rename after a long enough run.
 */
export const THEME_REFRESH_MAX = 5;
/**
 * Required multiple of the transcript length at the last titling. Growth, not
 * elapsed turns, is the signal: doubling the conversation is roughly the point
 * at which the earlier sample can no longer represent it.
 */
export const THEME_REFRESH_GROWTH_FACTOR = 2;
/**
 * Absolute floor added to the growth requirement. Also carries the never-titled
 * case (`lastTitledTurnCount` 0), where the gate reduces to four turns: enough
 * for a request plus a reply to have established a subject.
 */
export const THEME_REFRESH_MIN_TURNS = 4;

/**
 * Whether the session's automatic theme title may be regenerated now.
 *
 * Pure and side-effect free so trigger sites stay dumb: they count turns and
 * ask, rather than each carrying its own idea of "enough has changed".
 */
export function shouldRefreshSessionTheme(input: {
	/** Convertible user/assistant turns in the session so far. */
	turnCount: number;
	/** `turnCount` at the moment the auto title was last set; 0 when never titled. */
	lastTitledTurnCount: number;
	/** Auto theme refreshes already performed for this session. */
	refreshCount: number;
}): boolean {
	if (input.refreshCount >= THEME_REFRESH_MAX) return false;
	return input.turnCount >= input.lastTitledTurnCount * THEME_REFRESH_GROWTH_FACTOR + THEME_REFRESH_MIN_TURNS;
}

/** Longest theme blurb stored per session; the picker never renders it, it only matches on it. */
const THEME_SUMMARY_MAX_CHARS = 400;

/** Searchable attributes derived from a session's sampled trajectory. */
export interface SessionThemeAttributes {
	/** Space-separated salient terms, for the stemmed keyword index. */
	keywords: string;
	/** Leading prose of the trajectory sample, bounded and single-line. */
	summary: string;
}

/**
 * Harvest a session's searchable attributes from the same `<chat>` trajectory
 * sample that feeds the naming model.
 *
 * Deliberately deterministic rather than model-generated. The naming model runs
 * a handful of times per session and can fail, be disabled, or return nothing;
 * findability should not depend on any of that. Reusing the sample is what
 * makes these attributes worth storing: it spans the whole conversation, while
 * the picker's own corpus stops at the session file's first 4KB.
 */
export function harvestSessionTheme(themeContext: string): SessionThemeAttributes {
	const text = stripChatScaffolding(themeContext).replace(/\s+/g, " ").trim();
	return {
		keywords: extractSessionKeywords(text).join(" "),
		summary: text.slice(0, THEME_SUMMARY_MAX_CHARS),
	};
}
