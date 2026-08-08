/**
 * Contracts for `WakeScheduler`: fire exactly what is due, exactly once, and
 * keep the persisted list honest.
 *
 * `pump(nowMs)` is driven explicitly with a mutable fake clock — no test ever
 * waits on a real timer (`ts-no-test-timers`). Arming still uses `setTimeout`
 * internally, so every scheduler is disposed at the end of its test.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { DueWake, WakeRetireReason, WakeSchedule } from "@oh-my-pi/pi-coding-agent/wake/schedule";
import { WakeScheduler } from "@oh-my-pi/pi-coding-agent/wake/scheduler";

const MIN = 60_000;
const HOUR = 60 * MIN;

const NOW = new Date(2026, 6, 28, 10, 30, 0, 0).getTime();

interface Harness {
	scheduler: WakeScheduler;
	/** Every wake handed to `deliver`, in delivery order. */
	delivered: DueWake[];
	/** Every list handed to `persist`, snapshotted at call time. */
	persisted: WakeSchedule[][];
	/** Every schedule that left the list on its own, with why. */
	retired: Array<{ id: string; reason: WakeRetireReason }>;
	/** Mutable fake clock, read by the scheduler's internal arming. */
	setNow: (ms: number) => void;
}

const live: WakeScheduler[] = [];

/** Build a scheduler wired to recording callbacks and a fake clock. */
const harness = (options: { deliver?: (wake: DueWake) => void } = {}): Harness => {
	let now = NOW;
	const delivered: DueWake[] = [];
	const persisted: WakeSchedule[][] = [];
	const retired: Array<{ id: string; reason: WakeRetireReason }> = [];
	const scheduler = new WakeScheduler({
		now: () => now,
		deliver: wake => {
			delivered.push(wake);
			options.deliver?.(wake);
		},
		// Snapshot: the scheduler keeps mutating its own array afterwards.
		persist: schedules => persisted.push([...schedules]),
		onRetire: (schedule, reason) => retired.push({ id: schedule.id, reason }),
	});
	live.push(scheduler);
	return {
		scheduler,
		delivered,
		persisted,
		retired,
		setNow: ms => {
			now = ms;
		},
	};
};

const schedule = (overrides: Partial<WakeSchedule> = {}): WakeSchedule => ({
	id: "w1",
	message: "check the pipeline",
	nextDueAt: NOW + HOUR,
	firedCount: 0,
	createdAt: NOW,
	...overrides,
});

const ids = (schedules: readonly WakeSchedule[]): string[] => schedules.map(s => s.id);

afterEach(() => {
	for (const scheduler of live.splice(0)) scheduler.dispose();
});

describe("WakeScheduler.pump", () => {
	it("delivers nothing and reports the next due time when nothing is due", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW + HOUR })]);
		h.persisted.length = 0;

		expect(h.scheduler.pump(NOW)).toBe(NOW + HOUR);
		expect(h.delivered).toHaveLength(0);
		expect(h.persisted).toHaveLength(0);
		expect(h.retired).toHaveLength(0);
	});

	it("reports no next due time when the list is empty", () => {
		const h = harness();
		expect(h.scheduler.pump(NOW)).toBeUndefined();
	});

	it("delivers a due one-shot once, retires it, and persists the remainder", () => {
		const h = harness();
		const once = schedule({ id: "w1", nextDueAt: NOW });
		const later = schedule({ id: "w2", nextDueAt: NOW + 2 * HOUR, createdAt: NOW + 1 });
		h.scheduler.update([once, later]);
		h.persisted.length = 0;

		const next = h.scheduler.pump(NOW);

		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]?.schedule.id).toBe("w1");
		expect(h.delivered[0]?.occurrence).toBe(1);
		expect(h.delivered[0]?.plannedTotal).toBe(1);
		expect(h.delivered[0]?.final).toBe(true);
		expect(ids(h.scheduler.schedules)).toEqual(["w2"]);
		expect(h.persisted).toHaveLength(1);
		expect(ids(h.persisted[0]!)).toEqual(["w2"]);
		expect(h.retired).toEqual([{ id: "w1", reason: "one-shot" }]);
		expect(next).toBe(NOW + 2 * HOUR);
	});

	it("does not re-deliver a schedule already fired at the same instant", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW, everyMs: HOUR })]);

		h.scheduler.pump(NOW);
		h.scheduler.pump(NOW);

		expect(h.delivered).toHaveLength(1);
	});

	it("advances a recurring schedule and keeps it in the list", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW, everyMs: HOUR })]);
		h.persisted.length = 0;

		const next = h.scheduler.pump(NOW);

		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]?.final).toBe(false);
		expect(h.scheduler.schedules).toHaveLength(1);
		expect(h.scheduler.schedules[0]?.nextDueAt).toBe(NOW + HOUR);
		expect(h.scheduler.schedules[0]?.firedCount).toBe(1);
		expect(h.persisted[0]?.[0]?.firedCount).toBe(1);
		expect(h.retired).toHaveLength(0);
		expect(next).toBe(NOW + HOUR);
	});

	it("numbers occurrences and flags the final one across a bounded run", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW, everyMs: HOUR, limit: 3 })]);

		h.scheduler.pump(NOW);
		h.scheduler.pump(NOW + HOUR);
		h.scheduler.pump(NOW + 2 * HOUR);

		expect(h.delivered.map(w => w.occurrence)).toEqual([1, 2, 3]);
		expect(h.delivered.map(w => w.plannedTotal)).toEqual([3, 3, 3]);
		expect(h.delivered.map(w => w.final)).toEqual([false, false, true]);
		expect(h.scheduler.schedules).toHaveLength(0);
		expect(h.retired).toEqual([{ id: "w1", reason: "limit" }]);
	});

	it("retires at `until` and reports the reason", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW, everyMs: HOUR, untilAt: NOW + 30 * MIN })]);

		h.scheduler.pump(NOW);

		expect(h.delivered[0]?.final).toBe(true);
		expect(h.retired).toEqual([{ id: "w1", reason: "until" }]);
		expect(h.scheduler.schedules).toHaveLength(0);
	});

	it("omits plannedTotal for an open-ended recurring wake", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW, everyMs: HOUR })]);

		h.scheduler.pump(NOW);

		expect(h.delivered[0]?.plannedTotal).toBeUndefined();
		expect(Object.hasOwn(h.delivered[0]!, "plannedTotal")).toBe(false);
	});

	it("fires an overdue schedule once, at the first live slot", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW - 5 * HOUR, everyMs: HOUR })]);

		h.scheduler.pump(NOW);

		expect(h.delivered).toHaveLength(1);
		expect(h.scheduler.schedules[0]?.nextDueAt).toBe(NOW + HOUR);
		expect(h.scheduler.schedules[0]?.firedCount).toBe(1);
	});

	it("delivers every schedule due in the same pump", () => {
		const h = harness();
		h.scheduler.update([
			schedule({ id: "w1", nextDueAt: NOW, everyMs: HOUR }),
			schedule({ id: "w2", nextDueAt: NOW, createdAt: NOW + 1 }),
			schedule({ id: "w3", nextDueAt: NOW + HOUR, createdAt: NOW + 2 }),
		]);
		h.persisted.length = 0;

		const next = h.scheduler.pump(NOW);

		expect(h.delivered.map(w => w.schedule.id)).toEqual(["w1", "w2"]);
		expect(ids(h.scheduler.schedules)).toEqual(["w1", "w3"]);
		// One persist for the whole pump, not one per delivery.
		expect(h.persisted).toHaveLength(1);
		expect(next).toBe(NOW + HOUR);
	});

	it("advances past a delivery that throws, so one broken wake is not a hot loop", () => {
		const h = harness({
			deliver: wake => {
				if (wake.schedule.id === "w1") throw new Error("injection failed");
			},
		});
		h.scheduler.update([
			schedule({ id: "w1", nextDueAt: NOW, everyMs: HOUR }),
			schedule({ id: "w2", nextDueAt: NOW, everyMs: HOUR, createdAt: NOW + 1 }),
		]);

		h.scheduler.pump(NOW);

		// The thrower was attempted exactly once and moved on...
		expect(h.delivered.filter(w => w.schedule.id === "w1")).toHaveLength(1);
		expect(h.scheduler.schedules.find(s => s.id === "w1")?.nextDueAt).toBe(NOW + HOUR);
		// ...and it did not swallow its neighbour.
		expect(h.delivered.filter(w => w.schedule.id === "w2")).toHaveLength(1);

		// A second pump at the same instant finds nothing still due.
		h.scheduler.pump(NOW);
		expect(h.delivered).toHaveLength(2);
	});

	it("retires a throwing one-shot rather than retrying it forever", () => {
		const h = harness({
			deliver: () => {
				throw new Error("injection failed");
			},
		});
		h.scheduler.update([schedule({ nextDueAt: NOW })]);

		h.scheduler.pump(NOW);

		expect(h.scheduler.schedules).toHaveLength(0);
		expect(h.retired).toEqual([{ id: "w1", reason: "one-shot" }]);
	});

	it("keeps the list in creation order after a fire reshuffles it", () => {
		const h = harness();
		h.scheduler.update([
			schedule({ id: "w1", nextDueAt: NOW + HOUR, createdAt: NOW }),
			schedule({ id: "w2", nextDueAt: NOW, everyMs: 5 * HOUR, createdAt: NOW + 1 }),
			schedule({ id: "w3", nextDueAt: NOW + 2 * HOUR, createdAt: NOW + 2 }),
		]);

		h.scheduler.pump(NOW);

		// w2 is now the furthest out, but ordering follows creation, not due time.
		expect(ids(h.scheduler.schedules)).toEqual(["w1", "w2", "w3"]);
		expect(ids(h.persisted.at(-1)!)).toEqual(["w1", "w2", "w3"]);
	});

	it("defaults nowMs to the injected clock", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW + HOUR })]);

		expect(h.scheduler.pump()).toBe(NOW + HOUR);
		expect(h.delivered).toHaveLength(0);

		h.setNow(NOW + HOUR);
		h.scheduler.pump();
		expect(h.delivered).toHaveLength(1);
	});
});

describe("WakeScheduler list management", () => {
	it("adopts persisted schedules without re-persisting them", () => {
		const h = harness();
		h.scheduler.load([schedule({ id: "w1" }), schedule({ id: "w2", createdAt: NOW + 1 })]);

		expect(ids(h.scheduler.schedules)).toEqual(["w1", "w2"]);
		expect(h.persisted).toHaveLength(0);
	});

	it("persists a caller-driven change", () => {
		const h = harness();
		h.scheduler.update([schedule()]);

		expect(h.persisted).toHaveLength(1);
		expect(ids(h.persisted[0]!)).toEqual(["w1"]);

		h.scheduler.update([]);
		expect(h.persisted).toHaveLength(2);
		expect(h.persisted[1]).toEqual([]);
	});

	it("copies the incoming list so a caller's later mutation cannot reach it", () => {
		const h = harness();
		const incoming = [schedule({ id: "w1" })];
		h.scheduler.update(incoming);
		incoming.push(schedule({ id: "w2", createdAt: NOW + 1 }));

		expect(ids(h.scheduler.schedules)).toEqual(["w1"]);
	});

	it("delivers loaded schedules that are already overdue on the next pump", () => {
		const h = harness();
		h.scheduler.load([schedule({ nextDueAt: NOW - HOUR })]);

		h.scheduler.pump(NOW);

		expect(h.delivered).toHaveLength(1);
		// The adoption itself did not write; only the fire did.
		expect(h.persisted).toHaveLength(1);
	});
});

describe("WakeScheduler.dispose", () => {
	it("drops the schedules and delivers nothing afterwards", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW, everyMs: HOUR })]);
		h.scheduler.dispose();

		expect(h.scheduler.pump(NOW + 10 * HOUR)).toBeUndefined();
		expect(h.scheduler.schedules).toHaveLength(0);
		expect(h.delivered).toHaveLength(0);
	});

	it("is idempotent", () => {
		const h = harness();
		h.scheduler.update([schedule({ nextDueAt: NOW })]);
		h.scheduler.dispose();
		h.scheduler.dispose();

		expect(h.scheduler.pump(NOW)).toBeUndefined();
	});
});

describe("WakeScheduler arming", () => {
	/**
	 * A manual timer driver: `setTimer` records instead of sleeping, so the arm
	 * / re-arm decisions are asserted without real timers. The bug this guards
	 * is structural: an intermediate re-check tick that finds nothing due must
	 * re-arm, or a long-horizon wake goes silent after its first 60-second tick
	 * — invisible to a suite that only ever calls `pump()` directly.
	 */
	interface RecordedTimer {
		callback: () => void;
		delayMs: number;
		cleared: boolean;
	}

	function armedHarness() {
		let now = NOW;
		const timers: RecordedTimer[] = [];
		const delivered: DueWake[] = [];
		const scheduler = new WakeScheduler({
			now: () => now,
			deliver: wake => delivered.push(wake),
			persist: () => {},
			setTimer: (callback, delayMs) => {
				const timer: RecordedTimer = { callback, delayMs, cleared: false };
				timers.push(timer);
				return timer as unknown as Timer;
			},
			clearTimer: timer => {
				(timer as unknown as RecordedTimer).cleared = true;
			},
		});
		live.push(scheduler);
		return {
			scheduler,
			timers,
			delivered,
			/** Advance the clock and run the most recent armed callback. */
			tick: (advanceMs: number) => {
				now += advanceMs;
				const timer = [...timers].reverse().find(t => !t.cleared);
				expect(timer, "expected an armed timer to tick").toBeDefined();
				timer!.callback();
			},
		};
	}

	it("clamps the arm to MAX_ARM_MS and re-arms after an empty tick", () => {
		const h = armedHarness();
		h.scheduler.update([schedule({ nextDueAt: NOW + 120_000 })]);

		expect(h.timers).toHaveLength(1);
		expect(h.timers[0]!.delayMs).toBe(60_000);

		// First re-check tick: nothing due yet, and the scheduler must arm the
		// next one itself — this is the regression this describe exists for.
		h.tick(60_000);
		expect(h.delivered).toHaveLength(0);
		expect(h.timers).toHaveLength(2);
		expect(h.timers[1]!.delayMs).toBe(60_000);

		// Second tick crosses the deadline: the wake fires once.
		h.tick(61_000);
		expect(h.delivered).toHaveLength(1);
	});

	it("arms a one-shot delivery without leaving a timer behind", () => {
		const h = armedHarness();
		h.scheduler.update([schedule({ nextDueAt: NOW + 30_000 })]);

		h.tick(30_000);
		expect(h.delivered).toHaveLength(1);
		// The retired schedule armed nothing new. (The timer that fired is not
		// "cleared": its callback already ran, so there is nothing to cancel.)
		expect(h.timers).toHaveLength(1);
	});

	it("delays a load-time overdue wake to the grace window, not immediately", () => {
		const h = armedHarness();
		h.scheduler.load([schedule({ nextDueAt: NOW - HOUR })]);

		expect(h.timers).toHaveLength(1);
		// The TUI attaches after the session constructs; firing inside the
		// constructor would make the wake visible only on history replay.
		expect(h.timers[0]!.delayMs).toBe(2_000);

		h.tick(2_000);
		expect(h.delivered).toHaveLength(1);
	});

	it("stops arming after dispose", () => {
		const h = armedHarness();
		h.scheduler.update([schedule({ nextDueAt: NOW + HOUR })]);
		h.scheduler.dispose();

		expect(h.timers.every(t => t.cleared)).toBe(true);
	});
});
