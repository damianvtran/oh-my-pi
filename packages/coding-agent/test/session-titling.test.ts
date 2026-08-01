import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildSessionThemeContext,
	THEME_CONTEXT_HEAD_TURNS,
	THEME_CONTEXT_TAIL_TURNS,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	shouldRefreshSessionTheme,
	THEME_REFRESH_GROWTH_FACTOR,
	THEME_REFRESH_MAX,
	THEME_REFRESH_MIN_TURNS,
	THEME_TITLE_SYSTEM_PROMPT,
} from "@oh-my-pi/pi-coding-agent/session/session-titling";
import { isPreformattedChatContext, stripChatScaffolding } from "@oh-my-pi/pi-coding-agent/tiny/message-preproc";

/** Distinct, code-block-free turn text so each sampled turn is identifiable in the output. */
function userTurns(count: number): AgentMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		role: "user" as const,
		content: [{ type: "text" as const, text: `request number ${i} about the subject` }],
		timestamp: i + 1,
	}));
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("shouldRefreshSessionTheme", () => {
	it("allows a refresh exactly at the growth threshold and refuses one turn below", () => {
		// Titled at turn 1 => threshold 1 * 2 + 4 = 6. The boundary is the whole
		// point of the gate: off by one here and a replan-triggered refresh fires
		// again immediately, which is the drift being fixed.
		expect(shouldRefreshSessionTheme({ turnCount: 6, lastTitledTurnCount: 1, refreshCount: 1 })).toBe(true);
		expect(shouldRefreshSessionTheme({ turnCount: 5, lastTitledTurnCount: 1, refreshCount: 1 })).toBe(false);
	});

	it("reduces to a flat minimum-turn gate when the session was never titled", () => {
		expect(
			shouldRefreshSessionTheme({ turnCount: THEME_REFRESH_MIN_TURNS, lastTitledTurnCount: 0, refreshCount: 0 }),
		).toBe(true);
		expect(
			shouldRefreshSessionTheme({ turnCount: THEME_REFRESH_MIN_TURNS - 1, lastTitledTurnCount: 0, refreshCount: 0 }),
		).toBe(false);
	});

	it("stops refreshing at the cap no matter how far the transcript has grown", () => {
		expect(
			shouldRefreshSessionTheme({ turnCount: 10_000, lastTitledTurnCount: 1, refreshCount: THEME_REFRESH_MAX }),
		).toBe(false);
		expect(
			shouldRefreshSessionTheme({ turnCount: 10_000, lastTitledTurnCount: 1, refreshCount: THEME_REFRESH_MAX - 1 }),
		).toBe(true);
	});

	it("produces geometrically widening thresholds so the name converges", () => {
		// Walk the documented schedule: titled at turn 1, then 6, 16, 36, 76, 156,
		// and nothing after five refreshes.
		const thresholds: number[] = [];
		let lastTitledTurnCount = 1;
		let refreshCount = 0;
		for (let turnCount = 2; turnCount <= 500; turnCount++) {
			if (!shouldRefreshSessionTheme({ turnCount, lastTitledTurnCount, refreshCount })) continue;
			thresholds.push(turnCount);
			lastTitledTurnCount = turnCount;
			refreshCount++;
		}
		expect(thresholds).toEqual([6, 16, 36, 76, 156]);
		expect(thresholds).toHaveLength(THEME_REFRESH_MAX);
		expect(thresholds[1]).toBe(thresholds[0] * THEME_REFRESH_GROWTH_FACTOR + THEME_REFRESH_MIN_TURNS);
	});
});

describe("THEME_TITLE_SYSTEM_PROMPT", () => {
	it("renders the prompt file rather than resolving to an empty string", () => {
		// Guards the `with { type: "text" }` import plus prompt.render wiring: a
		// silently empty system prompt would still title, just without any of the
		// theme rules.
		expect(THEME_TITLE_SYSTEM_PROMPT.length).toBeGreaterThan(200);
	});
});

describe("buildSessionThemeContext", () => {
	it("keeps the opening turn in a conversation long enough for a tail window to drop it", () => {
		const messages = userTurns(40);

		const context = buildSessionThemeContext(messages);

		expect(context).toContain("request number 0 about the subject");
		expect(context).toContain("request number 39 about the subject");
		// The middle is what a whole-trajectory sampler gives up in exchange.
		expect(context).not.toContain("request number 20 about the subject");
	});

	it("samples exactly the head and the tail without duplicating turns", () => {
		const messages = userTurns(40);

		const context = buildSessionThemeContext(messages);

		expect(countOccurrences(context, "<user>")).toBe(THEME_CONTEXT_HEAD_TURNS + THEME_CONTEXT_TAIL_TURNS);
		for (let i = 0; i < THEME_CONTEXT_HEAD_TURNS; i++) {
			expect(countOccurrences(context, `request number ${i} about the subject`)).toBe(1);
		}
		for (let i = 40 - THEME_CONTEXT_TAIL_TURNS; i < 40; i++) {
			expect(countOccurrences(context, `request number ${i} about the subject`)).toBe(1);
		}
	});

	it("emits every turn exactly once when head and tail windows overlap", () => {
		const total = THEME_CONTEXT_HEAD_TURNS + THEME_CONTEXT_TAIL_TURNS - 2;

		const context = buildSessionThemeContext(userTurns(total));

		expect(countOccurrences(context, "<user>")).toBe(total);
		expect(context).not.toContain("<elided/>");
	});

	it("marks the gap only when turns were actually skipped", () => {
		const contiguous = THEME_CONTEXT_HEAD_TURNS + THEME_CONTEXT_TAIL_TURNS;

		expect(buildSessionThemeContext(userTurns(contiguous))).not.toContain("<elided/>");
		expect(buildSessionThemeContext(userTurns(contiguous + 1))).toContain("<elided/>");
	});

	it("places the gap marker between the head and the tail, never at the end", () => {
		const context = buildSessionThemeContext(userTurns(40));

		const marker = context.indexOf("<elided/>");
		expect(marker).toBeGreaterThan(context.indexOf(`request number ${THEME_CONTEXT_HEAD_TURNS - 1}`));
		expect(marker).toBeLessThan(context.indexOf("request number 39"));
	});

	it("includes the current title only when one is supplied", () => {
		const messages = userTurns(40);

		const anchored = buildSessionThemeContext(messages, { currentTitle: "Rework session titling" });
		const bare = buildSessionThemeContext(messages);

		expect(anchored).toContain("Rework session titling");
		expect(anchored).toContain("<current-title>");
		expect(bare).not.toContain("<current-title>");
	});

	it("stays a preformatted chat context with and without the current title", () => {
		// The envelope check is what keeps this string out of preprocessTinyMessage,
		// whose paired-tag stripping would delete the whole context.
		const messages = userTurns(40);

		expect(isPreformattedChatContext(buildSessionThemeContext(messages))).toBe(true);
		expect(isPreformattedChatContext(buildSessionThemeContext(messages, { currentTitle: "Rework titling" }))).toBe(
			true,
		);
	});

	it("exposes all scaffolding to stripChatScaffolding, including the new tags", () => {
		const context = buildSessionThemeContext(userTurns(40), { currentTitle: "Rework session titling" });

		const stripped = stripChatScaffolding(context);

		expect(stripped).not.toContain("<");
		expect(stripped).toContain("Rework session titling");
		expect(stripped).toContain("request number 0 about the subject");
	});

	it("returns an empty context when no message carries titleable content", () => {
		expect(buildSessionThemeContext([])).toBe("");
		expect(buildSessionThemeContext([{ role: "user", content: [], timestamp: 1 }])).toBe("");
	});
});
