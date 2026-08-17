import { describe, expect, it } from "bun:test";
import { extractRetryHint } from "@oh-my-pi/pi-utils";

// The fail-fast regex used inside the provider to distinguish "known quota errors" (throw immediately)
// from "ambiguous 429s" (retry up to RATE_LIMIT_BUDGET_MS).
// Option A (minimal): only hard quota limits fail-fast; transient rate-limit messages fall through to retry.
const FAIL_FAST_RE = /quota|exhausted/i;
const shouldFailFast = (errorText: string) => FAIL_FAST_RE.test(errorText);

describe("google-gemini-cli 429 fail-fast detection", () => {
	it("fails fast on 'Quota exceeded' messages", () => {
		expect(shouldFailFast("Quota exceeded for project")).toBe(true);
	});

	it("fails fast on 'exhausted' messages", () => {
		expect(shouldFailFast("Resource has been exhausted")).toBe(true);
	});

	it("does not fail fast on ambiguous 429 ('Please retry in 5s')", () => {
		expect(shouldFailFast("Please retry in 5s")).toBe(false);
	});

	it("does not fail fast on generic rate-limit text", () => {
		expect(shouldFailFast("Rate limit exceeded, please slow down")).toBe(false);
	});

	it("matches case-insensitively", () => {
		expect(shouldFailFast("QUOTA EXCEEDED")).toBe(true);
		expect(shouldFailFast("Resource Has Been Exhausted")).toBe(true);
	});

	it("does not fail fast on empty error", () => {
		expect(shouldFailFast("")).toBe(false);
	});
});

describe("extractRetryHint – header parsing", () => {
	it("reads retry-after header as seconds", () => {
		const headers = new Headers({ "retry-after": "5" });
		expect(extractRetryHint(headers)).toBe(5_000);
	});

	it("reads x-ratelimit-reset-after header as seconds", () => {
		const headers = new Headers({ "x-ratelimit-reset-after": "30" });
		expect(extractRetryHint(headers)).toBe(30_000);
	});

	it("prefers retry-after over x-ratelimit-reset-after when both are present", () => {
		const headers = new Headers({ "retry-after": "5", "x-ratelimit-reset-after": "30" });
		expect(extractRetryHint(headers)).toBe(5_000);
	});
});

describe("extractRetryHint – body text parsing", () => {
	it("parses 'retryDelay' JSON field in seconds", () => {
		expect(extractRetryHint(undefined, '"retryDelay": "3s"')).toBe(3_000);
	});

	it("parses 'retryDelay' JSON field in milliseconds", () => {
		expect(extractRetryHint(undefined, '"retryDelay": "500ms"')).toBe(500);
	});

	it("parses 'Please retry in Xs' pattern", () => {
		expect(extractRetryHint(undefined, "Please retry in 5s")).toBe(5_000);
	});

	it("parses 'quota will reset after Xs' simple duration", () => {
		expect(extractRetryHint(undefined, "Your quota will reset after 39s")).toBe(39_000);
	});

	it("parses compound duration 'reset after 1h30m10s'", () => {
		expect(extractRetryHint(undefined, "Your quota will reset after 1h30m10s")).toBe(5_410_000);
	});

	it("parses Codex-style 'try again in Xms'", () => {
		expect(extractRetryHint(undefined, "try again in 250ms")).toBe(250);
	});

	it("parses Codex-style 'try again in Xs'", () => {
		expect(extractRetryHint(undefined, "try again in 12s")).toBe(12_000);
	});

	it("parses Codex 'Try again in ~X min.' (usage_limit_reached friendly text)", () => {
		// Verbatim shape Codex's parseCodexError builds when usage_limit_reached
		// arrives with a `resets_at` minutes-out reset time. Used to fall
		// through to undefined → the gateway and TUI both had no retry-after
		// signal to honour, so they defaulted to QUOTA_EXHAUSTED's 30-min
		// blanket and rotated immediately even when the actual reset window
		// was much longer.
		expect(extractRetryHint(undefined, "Try again in ~158 min.")).toBe(158 * 60_000);
	});

	it("parses 'try again in X min' / 'X minutes' without the tilde", () => {
		expect(extractRetryHint(undefined, "try again in 5 min")).toBe(5 * 60_000);
		expect(extractRetryHint(undefined, "try again in 90 minutes")).toBe(90 * 60_000);
	});

	it("parses 'try again in X h' / 'X hour' / 'X hours'", () => {
		expect(extractRetryHint(undefined, "try again in 2 h")).toBe(2 * 60 * 60_000);
		expect(extractRetryHint(undefined, "try again in 1 hour")).toBe(60 * 60_000);
		expect(extractRetryHint(undefined, "try again in 3 hours")).toBe(3 * 60 * 60_000);
	});

	it("returns undefined when body contains no recognised delay pattern", () => {
		expect(extractRetryHint(undefined, "Quota exceeded, please try again later")).toBeUndefined();
	});

	it("returns undefined for empty error string and no headers", () => {
		expect(extractRetryHint(undefined, "")).toBeUndefined();
	});
});

describe("extractRetryHint – absolute reset instants", () => {
	/** `MM-DD HH:MM:SS` in UTC, as Alibaba's Token Plan 429 states it. */
	function utcStamp(at: Date, withYear = false): string {
		const p = (value: number) => String(value).padStart(2, "0");
		const date = `${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}`;
		const time = `${p(at.getUTCHours())}:${p(at.getUTCMinutes())}:${p(at.getUTCSeconds())}`;
		return withYear ? `${at.getUTCFullYear()}-${date} ${time}` : `${date} ${time}`;
	}

	it("parses the Token Plan year-less reset stamp", () => {
		const target = new Date(Date.now() + 3 * 60 * 60 * 1000);
		const body = `Your token-plan 1-week quota has been exhausted. The quota will reset at ${utcStamp(target)} UTC.`;
		const hint = extractRetryHint(undefined, body);
		expect(hint).toBeDefined();
		// Within a second of three hours — the clock moves between the two calls.
		expect(Math.abs(hint! - 3 * 60 * 60 * 1000)).toBeLessThan(1000);
	});

	it("parses an explicit-year reset stamp", () => {
		const target = new Date(Date.now() + 26 * 60 * 60 * 1000);
		const hint = extractRetryHint(undefined, `quota will reset at ${utcStamp(target, true)} UTC`);
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - 26 * 60 * 60 * 1000)).toBeLessThan(1000);
	});

	it("rolls a already-passed year-less stamp forward to next year", () => {
		// A stamp one day in the past resolves to the same date next year, which
		// exceeds the sanity ceiling and is rejected rather than returned negative.
		const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
		expect(extractRetryHint(undefined, `quota will reset at ${utcStamp(past)} UTC`)).toBeUndefined();
	});

	it("ignores an impossible calendar date instead of normalising it", () => {
		expect(extractRetryHint(undefined, "quota will reset at 02-31 09:25:00 UTC")).toBeUndefined();
	});

	it("leaves a relative hint in the same body taking precedence", () => {
		const target = new Date(Date.now() + 5 * 60 * 60 * 1000);
		const body = `try again in 30s; quota will reset at ${utcStamp(target)} UTC`;
		expect(extractRetryHint(undefined, body)).toBe(30_000);
	});
});
