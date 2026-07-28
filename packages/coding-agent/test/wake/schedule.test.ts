/**
 * Contracts for the pure wake rules in `src/wake/schedule.ts`.
 *
 * Every case injects `now` so the recurrence math is exercised without timers
 * (`ts-no-test-timers`), and every wall-clock expectation is built from a local
 * `Date` rather than a UTC constant so the suite is timezone-independent.
 */
import { describe, expect, it } from "bun:test";
import {
	advanceWakeSchedule,
	buildWakeSchedule,
	describeWakeSchedule,
	formatWakeClock,
	isWakeSchedule,
	MAX_WAKE_MESSAGE_CHARS,
	MAX_WAKE_SCHEDULES,
	MIN_WAKE_INTERVAL_MS,
	nextWakeId,
	parseWakeAt,
	parseWakeDuration,
	plannedWakeTotal,
	type WakeSchedule,
} from "@oh-my-pi/pi-coding-agent/wake/schedule";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Fixed local wall-clock anchor: 2026-07-28 10:30:00 local time. */
const NOW = new Date(2026, 6, 28, 10, 30, 0, 0).getTime();

const pad = (n: number): string => String(n).padStart(2, "0");

/** ISO-8601 with no offset, i.e. the local-time form of an instant. */
const localIso = (ms: number): string => {
	const d = new Date(ms);
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const schedule = (overrides: Partial<WakeSchedule> = {}): WakeSchedule => ({
	id: "w1",
	message: "check the pipeline",
	nextDueAt: NOW + HOUR,
	firedCount: 0,
	createdAt: NOW,
	...overrides,
});

/** `buildWakeSchedule`'s result union, named locally so the helpers below can be typed. */
type BuildOutcome = { schedule: WakeSchedule } | { error: string };

/** Narrow a build result to its schedule, failing loudly on the error branch. */
const built = (result: BuildOutcome): WakeSchedule => {
	if ("error" in result) throw new Error(`expected a schedule, got error: ${result.error}`);
	return result.schedule;
};

/** Narrow a build result to its error, failing loudly on the success branch. */
const rejected = (result: BuildOutcome): string => {
	if ("schedule" in result) throw new Error(`expected a rejection, got schedule ${result.schedule.id}`);
	return result.error;
};

describe("parseWakeDuration", () => {
	it("reads every supported unit", () => {
		expect(parseWakeDuration("45s")).toBe(45 * SEC);
		expect(parseWakeDuration("30m")).toBe(30 * MIN);
		expect(parseWakeDuration("2h")).toBe(2 * HOUR);
		expect(parseWakeDuration("7d")).toBe(7 * DAY);
		expect(parseWakeDuration("1w")).toBe(WEEK);
	});

	it("accepts fractional values", () => {
		expect(parseWakeDuration("1.5h")).toBe(90 * MIN);
		expect(parseWakeDuration("0.5m")).toBe(30 * SEC);
		expect(parseWakeDuration("2.25d")).toBe(54 * HOUR);
	});

	it("tolerates surrounding and internal whitespace, and either case", () => {
		expect(parseWakeDuration("  2h  ")).toBe(2 * HOUR);
		expect(parseWakeDuration("2 h")).toBe(2 * HOUR);
		expect(parseWakeDuration("2H")).toBe(2 * HOUR);
		expect(parseWakeDuration("1W")).toBe(WEEK);
	});

	it("rejects a bare number, because the unit is the whole point", () => {
		expect(parseWakeDuration("60")).toBeUndefined();
		expect(parseWakeDuration("60000")).toBeUndefined();
	});

	it("rejects zero and negative durations", () => {
		expect(parseWakeDuration("0s")).toBeUndefined();
		expect(parseWakeDuration("0.0m")).toBeUndefined();
		expect(parseWakeDuration("-5m")).toBeUndefined();
	});

	it("rejects junk", () => {
		for (const text of ["", "   ", "soon", "5x", "m", "5m5s", "1.5.5h", "5 minutes", "1e3s"]) {
			expect(parseWakeDuration(text)).toBeUndefined();
		}
	});
});

describe("parseWakeAt", () => {
	it("resolves a relative `+duration` against the injected now", () => {
		expect(parseWakeAt("+90m", NOW)).toBe(NOW + 90 * MIN);
		expect(parseWakeAt(" +7d ", NOW)).toBe(NOW + 7 * DAY);
	});

	it("resolves HH:MM later today to today", () => {
		expect(parseWakeAt("14:30", NOW)).toBe(new Date(2026, 6, 28, 14, 30, 0, 0).getTime());
	});

	it("resolves HH:MM that has already passed to the same wall-clock time tomorrow", () => {
		const at = parseWakeAt("09:00", NOW);
		expect(at).toBeDefined();
		const resolved = new Date(at!);
		// Same clock time, next calendar day — asserted on local fields rather
		// than as `NOW + 24h` so a DST-shifted day still satisfies the contract.
		expect(resolved.getHours()).toBe(9);
		expect(resolved.getMinutes()).toBe(0);
		expect(resolved.getSeconds()).toBe(0);
		expect(resolved.getDate()).toBe(29);
		expect(resolved.getMonth()).toBe(6);
		expect(resolved.getFullYear()).toBe(2026);
	});

	it("treats the current minute as already passed, so it never resolves to now", () => {
		const at = parseWakeAt("10:30", NOW);
		expect(at).toBeDefined();
		expect(at!).toBeGreaterThan(NOW);
		expect(new Date(at!).getDate()).toBe(29);
		expect(new Date(at!).getHours()).toBe(10);
	});

	it("rejects out-of-range clock values", () => {
		expect(parseWakeAt("25:00", NOW)).toBeUndefined();
		expect(parseWakeAt("24:00", NOW)).toBeUndefined();
		expect(parseWakeAt("12:60", NOW)).toBeUndefined();
		expect(parseWakeAt("12:99", NOW)).toBeUndefined();
	});

	it("reads an ISO timestamp pinned with Z", () => {
		expect(parseWakeAt("2026-07-29T09:00:00Z", NOW)).toBe(Date.UTC(2026, 6, 29, 9, 0, 0));
	});

	it("reads an ISO timestamp pinned with a numeric offset", () => {
		expect(parseWakeAt("2026-07-29T09:00:00+02:00", NOW)).toBe(Date.UTC(2026, 6, 29, 7, 0, 0));
	});

	it("reads an offset-free ISO timestamp as local time", () => {
		const target = new Date(2026, 6, 29, 9, 0, 0, 0).getTime();
		expect(parseWakeAt(localIso(target), NOW)).toBe(target);
	});

	it("rejects junk", () => {
		for (const text of ["", "   ", "not a time", "+", "+90", "later", "tomorrow at nine"]) {
			expect(parseWakeAt(text, NOW)).toBeUndefined();
		}
	});
});

describe("advanceWakeSchedule", () => {
	it("retires a one-shot", () => {
		expect(advanceWakeSchedule(schedule({ nextDueAt: NOW }), NOW)).toEqual({ retired: "one-shot" });
	});

	it("retires once the limit is reached", () => {
		const at2of3 = schedule({ nextDueAt: NOW, everyMs: HOUR, limit: 3, firedCount: 2 });
		expect(advanceWakeSchedule(at2of3, NOW)).toEqual({ retired: "limit" });
	});

	it("keeps going while the limit is not yet reached", () => {
		const at1of3 = schedule({ nextDueAt: NOW, everyMs: HOUR, limit: 3, firedCount: 1 });
		const outcome = advanceWakeSchedule(at1of3, NOW);
		expect(outcome).toEqual({ next: { ...at1of3, nextDueAt: NOW + HOUR, firedCount: 2 } });
	});

	it("retires when the next slot would fall past `until`", () => {
		const ending = schedule({ nextDueAt: NOW, everyMs: HOUR, untilAt: NOW + 30 * MIN });
		expect(advanceWakeSchedule(ending, NOW)).toEqual({ retired: "until" });
	});

	it("keeps going when the next slot still lands on `until`", () => {
		const ending = schedule({ nextDueAt: NOW, everyMs: HOUR, untilAt: NOW + HOUR });
		const outcome = advanceWakeSchedule(ending, NOW);
		expect(outcome).toEqual({ next: { ...ending, nextDueAt: NOW + HOUR, firedCount: 1 } });
	});

	it("skips missed occurrences instead of replaying them", () => {
		// Six hourly slots elapsed while the machine slept. The wake owes one
		// delivery, not six: firedCount moves by 1 and the next slot is the
		// first one still in the future.
		const slept = schedule({ nextDueAt: NOW - 5 * HOUR - 30 * MIN, everyMs: HOUR, firedCount: 4 });
		const outcome = advanceWakeSchedule(slept, NOW);
		expect(outcome).toHaveProperty("next");
		if (!("next" in outcome)) return;
		expect(outcome.next.nextDueAt).toBe(NOW + 30 * MIN);
		expect(outcome.next.firedCount).toBe(5);
	});

	it("increments firedCount by exactly one per advance", () => {
		let current = schedule({ nextDueAt: NOW, everyMs: HOUR });
		for (let i = 1; i <= 3; i++) {
			const outcome = advanceWakeSchedule(current, current.nextDueAt);
			expect(outcome).toHaveProperty("next");
			if (!("next" in outcome)) return;
			current = outcome.next;
			expect(current.firedCount).toBe(i);
			expect(current.nextDueAt).toBe(NOW + i * HOUR);
		}
	});

	it("does not mutate the schedule it advances", () => {
		const original = schedule({ nextDueAt: NOW, everyMs: HOUR });
		const snapshot = { ...original };
		advanceWakeSchedule(original, NOW);
		expect(original).toEqual(snapshot);
	});
});

describe("plannedWakeTotal", () => {
	it("is 1 for a one-shot", () => {
		expect(plannedWakeTotal(schedule())).toBe(1);
	});

	it("is the explicit limit when one is set, even alongside `until`", () => {
		expect(plannedWakeTotal(schedule({ everyMs: HOUR, limit: 8, untilAt: NOW + WEEK }))).toBe(8);
	});

	it("derives the count from `every` + `until`", () => {
		// Fires at NOW, +1h, +2h, +3h.
		expect(plannedWakeTotal(schedule({ nextDueAt: NOW, everyMs: HOUR, untilAt: NOW + 3 * HOUR }))).toBe(4);
		// A partial final interval adds no delivery.
		expect(plannedWakeTotal(schedule({ nextDueAt: NOW, everyMs: HOUR, untilAt: NOW + 3 * HOUR + 59 * MIN }))).toBe(4);
	});

	it("counts deliveries already made toward the total", () => {
		expect(
			plannedWakeTotal(schedule({ nextDueAt: NOW, everyMs: HOUR, untilAt: NOW + 2 * HOUR, firedCount: 2 })),
		).toBe(5);
	});

	it("reports the fired count once `until` is already behind the next slot", () => {
		expect(plannedWakeTotal(schedule({ nextDueAt: NOW + HOUR, everyMs: HOUR, untilAt: NOW, firedCount: 3 }))).toBe(3);
	});

	it("is unknowable for an open-ended recurring wake", () => {
		expect(plannedWakeTotal(schedule({ everyMs: HOUR }))).toBeUndefined();
	});
});

describe("nextWakeId", () => {
	it("starts at w1", () => {
		expect(nextWakeId([])).toBe("w1");
	});

	it("continues past the highest existing handle", () => {
		expect(nextWakeId([schedule({ id: "w1" }), schedule({ id: "w2" })])).toBe("w3");
	});

	it("never reuses a handle freed by a cancellation", () => {
		expect(nextWakeId([schedule({ id: "w1" }), schedule({ id: "w5" })])).toBe("w6");
	});

	it("ignores handles that are not w<N>", () => {
		expect(nextWakeId([schedule({ id: "abc" }), schedule({ id: "w" }), schedule({ id: "w1x" })])).toBe("w1");
		expect(nextWakeId([schedule({ id: "w3" }), schedule({ id: "wake-9" })])).toBe("w4");
	});

	it("is order-independent", () => {
		expect(nextWakeId([schedule({ id: "w7" }), schedule({ id: "w2" })])).toBe("w8");
	});
});

describe("buildWakeSchedule rejections", () => {
	it("requires a message", () => {
		expect(rejected(buildWakeSchedule({ message: "", at: "+1h" }, [], NOW))).toContain("`message` is required");
	});

	it("treats a whitespace-only message as missing", () => {
		expect(rejected(buildWakeSchedule({ message: "   \n ", at: "+1h" }, [], NOW))).toContain("`message` is required");
	});

	it("caps the message length", () => {
		const long = "x".repeat(MAX_WAKE_MESSAGE_CHARS + 1);
		const error = rejected(buildWakeSchedule({ message: long, at: "+1h" }, [], NOW));
		expect(error).toContain(String(MAX_WAKE_MESSAGE_CHARS + 1));
		expect(error).toContain(String(MAX_WAKE_MESSAGE_CHARS));
	});

	it("refuses to exceed the per-session schedule ceiling", () => {
		const full = Array.from({ length: MAX_WAKE_SCHEDULES }, (_, i) => schedule({ id: `w${i + 1}` }));
		expect(rejected(buildWakeSchedule({ message: "one more", at: "+1h" }, full, NOW))).toContain(
			`${MAX_WAKE_SCHEDULES} wakes already scheduled`,
		);
	});

	it("requires at least one of `at` and `every`", () => {
		const error = rejected(buildWakeSchedule({ message: "when?" }, [], NOW));
		expect(error).toContain("`at`");
		expect(error).toContain("`every`");
	});

	it("rejects an unparseable `every`", () => {
		expect(rejected(buildWakeSchedule({ message: "m", every: "hourly" }, [], NOW))).toContain('`every: "hourly"`');
	});

	it("rejects an `every` below the interval floor", () => {
		const error = rejected(buildWakeSchedule({ message: "m", every: "30s" }, [], NOW));
		expect(error).toContain("`every` must be at least");
		expect(error).toContain("30s");
		expect(parseWakeDuration("30s")).toBeLessThan(MIN_WAKE_INTERVAL_MS);
	});

	it("rejects an unparseable `at`", () => {
		expect(rejected(buildWakeSchedule({ message: "m", at: "midnight" }, [], NOW))).toContain('`at: "midnight"`');
	});

	it("rejects a past `at` on a one-shot", () => {
		const past = localIso(NOW - 2 * HOUR);
		const error = rejected(buildWakeSchedule({ message: "m", at: past }, [], NOW));
		expect(error).toContain("is in the past");
		expect(error).toContain("2h");
	});

	it("rejects an unparseable `until`", () => {
		expect(rejected(buildWakeSchedule({ message: "m", every: "1h", until: "eventually" }, [], NOW))).toContain(
			'`until: "eventually"`',
		);
	});

	it("rejects an `until` that is not in the future", () => {
		const past = localIso(NOW - HOUR);
		expect(rejected(buildWakeSchedule({ message: "m", every: "1h", until: past }, [], NOW))).toContain(
			"is not in the future",
		);
	});

	it("rejects an `until` that falls before the first wake", () => {
		const error = rejected(buildWakeSchedule({ message: "m", at: "+3h", every: "1h", until: "+1h" }, [], NOW));
		expect(error).toContain("before the first wake");
	});

	it("rejects a non-integer limit", () => {
		expect(rejected(buildWakeSchedule({ message: "m", every: "1h", limit: 1.5 }, [], NOW))).toContain(
			"`limit` must be a positive integer",
		);
	});

	it("rejects a non-positive limit", () => {
		expect(rejected(buildWakeSchedule({ message: "m", every: "1h", limit: 0 }, [], NOW))).toContain(
			"`limit` must be a positive integer",
		);
		expect(rejected(buildWakeSchedule({ message: "m", every: "1h", limit: -3 }, [], NOW))).toContain(
			"`limit` must be a positive integer",
		);
	});

	it("rejects a limit above 1 without `every`", () => {
		expect(rejected(buildWakeSchedule({ message: "m", at: "+1h", limit: 4 }, [], NOW))).toContain("needs `every`");
	});
});

describe("buildWakeSchedule acceptance", () => {
	it("builds a one-shot from `at` alone", () => {
		const result = built(buildWakeSchedule({ message: "  ship it  ", at: "+30m" }, [], NOW));
		expect(result).toEqual({
			id: "w1",
			message: "ship it",
			nextDueAt: NOW + 30 * MIN,
			firedCount: 0,
			createdAt: NOW,
		});
		// Optional fields stay absent rather than explicitly undefined: the
		// schedule is JSON-persisted and round-tripped through `isWakeSchedule`.
		expect(Object.hasOwn(result, "everyMs")).toBe(false);
		expect(Object.hasOwn(result, "untilAt")).toBe(false);
		expect(Object.hasOwn(result, "limit")).toBe(false);
	});

	it("starts an `every`-only cadence one interval out, not immediately", () => {
		const result = built(buildWakeSchedule({ message: "watch", every: "1h" }, [], NOW));
		expect(result.nextDueAt).toBe(NOW + HOUR);
		expect(result.everyMs).toBe(HOUR);
	});

	it("anchors a cadence to `at` when both are given", () => {
		const result = built(buildWakeSchedule({ message: "watch", at: "+10m", every: "1h" }, [], NOW));
		expect(result.nextDueAt).toBe(NOW + 10 * MIN);
		expect(result.everyMs).toBe(HOUR);
	});

	it("rolls a past `at` forward to the next live slot when `every` is set", () => {
		// "hourly on the half hour", phrased by naming a time that has gone by.
		const result = built(buildWakeSchedule({ message: "watch", at: localIso(NOW - 2 * HOUR), every: "1h" }, [], NOW));
		expect(result.nextDueAt).toBe(NOW + HOUR);
		expect(result.nextDueAt).toBeGreaterThan(NOW);
	});

	it("accepts an `at` that has only just gone by, within the clock-skew grace", () => {
		const result = built(buildWakeSchedule({ message: "now-ish", at: localIso(NOW - 2 * SEC) }, [], NOW));
		expect(result.nextDueAt).toBe(NOW - 2 * SEC);
		expect(Object.hasOwn(result, "everyMs")).toBe(false);
	});

	it("carries `until` through as an absolute stop", () => {
		const result = built(buildWakeSchedule({ message: "watch", every: "1h", until: "+7d" }, [], NOW));
		expect(result.untilAt).toBe(NOW + 7 * DAY);
		expect(plannedWakeTotal(result)).toBe(7 * 24);
	});

	it("carries `limit` through", () => {
		const result = built(buildWakeSchedule({ message: "watch", every: "15m", limit: 8 }, [], NOW));
		expect(result.limit).toBe(8);
		expect(result.everyMs).toBe(15 * MIN);
		expect(plannedWakeTotal(result)).toBe(8);
	});

	it("allocates the next free handle against the existing list", () => {
		const existing = [schedule({ id: "w1" }), schedule({ id: "w4" })];
		expect(built(buildWakeSchedule({ message: "watch", at: "+1h" }, existing, NOW)).id).toBe("w5");
	});

	it("produces a schedule the runtime guard accepts", () => {
		const result = built(buildWakeSchedule({ message: "watch", every: "1h", until: "+1d", limit: 5 }, [], NOW));
		expect(isWakeSchedule(JSON.parse(JSON.stringify(result)))).toBe(true);
	});
});

describe("isWakeSchedule", () => {
	it("accepts a full schedule", () => {
		expect(isWakeSchedule(schedule({ everyMs: HOUR, untilAt: NOW + DAY, limit: 5 }))).toBe(true);
	});

	it("accepts a minimal one-shot with the optional fields absent", () => {
		expect(isWakeSchedule(schedule())).toBe(true);
	});

	it("rejects non-objects", () => {
		for (const value of [null, undefined, "w1", 42, true, [], [schedule()]]) {
			expect(isWakeSchedule(value)).toBe(false);
		}
	});

	it("rejects a missing or empty id", () => {
		expect(isWakeSchedule({ ...schedule(), id: undefined })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), id: "" })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), id: 1 })).toBe(false);
	});

	it("rejects a missing or empty message", () => {
		expect(isWakeSchedule({ ...schedule(), message: undefined })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), message: "" })).toBe(false);
	});

	it("rejects missing required numbers", () => {
		expect(isWakeSchedule({ ...schedule(), nextDueAt: undefined })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), firedCount: undefined })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), createdAt: undefined })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), nextDueAt: "2026-07-28" })).toBe(false);
	});

	it("rejects non-finite numbers, which JSON round-trips into null", () => {
		expect(isWakeSchedule({ ...schedule(), nextDueAt: Number.NaN })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), createdAt: Number.POSITIVE_INFINITY })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), firedCount: Number.NaN })).toBe(false);
	});

	it("rejects malformed optional fields but tolerates their absence", () => {
		expect(isWakeSchedule({ ...schedule(), everyMs: "1h" })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), untilAt: Number.NaN })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), limit: null })).toBe(false);
		expect(isWakeSchedule({ ...schedule(), everyMs: undefined, untilAt: undefined, limit: undefined })).toBe(true);
	});
});

describe("formatWakeClock", () => {
	it("shows bare HH:MM for a time later the same day", () => {
		const at = new Date(2026, 6, 28, 14, 5, 0, 0).getTime();
		expect(formatWakeClock(at, NOW)).toBe("14:05");
	});

	it("zero-pads the hour", () => {
		const at = new Date(2026, 6, 28, 9, 0, 0, 0).getTime();
		expect(formatWakeClock(at, NOW)).toBe("09:00");
	});

	it("prefixes the date once the wake is not today", () => {
		const at = new Date(2026, 7, 4, 9, 0, 0, 0).getTime();
		const formatted = formatWakeClock(at, NOW);
		expect(formatted).toMatch(/^[A-Z][a-z]{2} 4 09:00$/);
	});

	it("treats the same clock time on a different year as a different day", () => {
		const at = new Date(2027, 6, 28, 10, 30, 0, 0).getTime();
		expect(formatWakeClock(at, NOW)).toContain("28 10:30");
		expect(formatWakeClock(at, NOW)).not.toBe("10:30");
	});
});

describe("describeWakeSchedule", () => {
	it("leads with the delay and the clock time for a pending wake", () => {
		const description = describeWakeSchedule(schedule({ nextDueAt: NOW + HOUR }), NOW);
		expect(description).toContain("in 1h");
		expect(description).toContain("(11:30)");
	});

	it("says `now` for a wake that is already due", () => {
		expect(describeWakeSchedule(schedule({ nextDueAt: NOW }), NOW)).toStartWith("now");
		expect(describeWakeSchedule(schedule({ nextDueAt: NOW - HOUR }), NOW)).toStartWith("now");
	});

	it("names the cadence and the stop time for a bounded recurring wake", () => {
		const bounded = schedule({ nextDueAt: NOW + HOUR, everyMs: HOUR, untilAt: NOW + 3 * HOUR, firedCount: 2 });
		const description = describeWakeSchedule(bounded, NOW);
		expect(description).toContain("every 1h");
		expect(description).toContain("until 13:30");
		expect(description).toContain("2/5 fired");
	});

	it("omits the progress fraction when the total is unknowable", () => {
		const openEnded = schedule({ nextDueAt: NOW + HOUR, everyMs: HOUR, firedCount: 3 });
		const description = describeWakeSchedule(openEnded, NOW);
		expect(description).toContain("every 1h");
		expect(description).toContain("3 fired");
		expect(description).not.toContain("/");
	});

	it("says nothing about firings on a fresh one-shot", () => {
		const description = describeWakeSchedule(schedule({ nextDueAt: NOW + HOUR }), NOW);
		expect(description).not.toContain("fired");
		expect(description).not.toContain("every");
		expect(description).not.toContain("until");
	});
});
