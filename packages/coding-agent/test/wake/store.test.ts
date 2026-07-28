/**
 * Contracts for wake persistence and the delivered-message text.
 *
 * The transcript is the only source of truth for schedules, so the reader has
 * to survive a hand-edited or half-written entry; the delivery text is the only
 * thing the model sees, so its envelope is asserted line by line.
 */
import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { DueWake, WakeSchedule } from "@oh-my-pi/pi-coding-agent/wake/schedule";
import {
	formatWakeChipText,
	formatWakeDeliveryText,
	getLatestWakeSchedulesFromEntries,
	WAKE_SCHEDULES_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/wake/store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 6, 28, 10, 30, 0, 0).getTime();
const TS = "2026-07-28T10:30:00.000Z";

let entrySeq = 0;

const schedule = (overrides: Partial<WakeSchedule> = {}): WakeSchedule => ({
	id: "w1",
	message: "check the pipeline",
	nextDueAt: NOW + HOUR,
	firedCount: 0,
	createdAt: NOW,
	...overrides,
});

/** A `custom` transcript entry, with `data` passed through untouched. */
const customEntry = (customType: string, data: unknown): SessionEntry => ({
	type: "custom",
	id: `e${++entrySeq}`,
	parentId: null,
	timestamp: TS,
	customType,
	data,
});

const wakeEntry = (data: unknown): SessionEntry => customEntry(WAKE_SCHEDULES_CUSTOM_TYPE, data);

const messageEntry = (text: string): SessionEntry => ({
	type: "message",
	id: `e${++entrySeq}`,
	parentId: null,
	timestamp: TS,
	message: { role: "user", content: text, timestamp: NOW },
});

const due = (overrides: Partial<DueWake> = {}): DueWake => ({
	schedule: schedule(),
	occurrence: 1,
	final: false,
	...overrides,
});

describe("getLatestWakeSchedulesFromEntries", () => {
	it("returns an empty list for an empty transcript", () => {
		expect(getLatestWakeSchedulesFromEntries([])).toEqual([]);
	});

	it("returns an empty list when the transcript holds no wake entry", () => {
		const entries = [messageEntry("hello"), customEntry("todo_phases", { phases: [] })];
		expect(getLatestWakeSchedulesFromEntries(entries)).toEqual([]);
	});

	it("takes the newest snapshot, since each change appends a full list", () => {
		const entries = [
			wakeEntry({ schedules: [schedule({ id: "w1" })] }),
			messageEntry("something happened"),
			wakeEntry({ schedules: [schedule({ id: "w1" }), schedule({ id: "w2" })] }),
		];
		expect(getLatestWakeSchedulesFromEntries(entries).map(s => s.id)).toEqual(["w1", "w2"]);
	});

	it("honours a newest snapshot that cancelled everything", () => {
		const entries = [wakeEntry({ schedules: [schedule()] }), wakeEntry({ schedules: [] })];
		expect(getLatestWakeSchedulesFromEntries(entries)).toEqual([]);
	});

	it("ignores custom entries of other types", () => {
		const entries = [
			wakeEntry({ schedules: [schedule({ id: "w3" })] }),
			customEntry("todo_phases", { schedules: [schedule({ id: "w9" })] }),
		];
		expect(getLatestWakeSchedulesFromEntries(entries).map(s => s.id)).toEqual(["w3"]);
	});

	it("drops individually malformed rows and keeps the valid ones", () => {
		const entries = [
			wakeEntry({
				schedules: [
					schedule({ id: "w1" }),
					{ id: "w2", message: "no timestamps" },
					null,
					"w3",
					{ ...schedule({ id: "w4" }), nextDueAt: null },
					schedule({ id: "w5" }),
				],
			}),
		];
		expect(getLatestWakeSchedulesFromEntries(entries).map(s => s.id)).toEqual(["w1", "w5"]);
	});

	it("tolerates a wake entry whose data is missing, null, or not an object", () => {
		for (const data of [undefined, null, "schedules", 7, []]) {
			expect(getLatestWakeSchedulesFromEntries([wakeEntry(data)])).toEqual([]);
		}
	});

	it("tolerates a wake entry whose `schedules` is not an array", () => {
		expect(getLatestWakeSchedulesFromEntries([wakeEntry({ schedules: { w1: schedule() } })])).toEqual([]);
	});

	it("lets a malformed newest snapshot mask an older valid one, rather than resurrecting stale wakes", () => {
		const entries = [wakeEntry({ schedules: [schedule({ id: "w1" })] }), wakeEntry({ broken: true })];
		expect(getLatestWakeSchedulesFromEntries(entries)).toEqual([]);
	});

	it("preserves the stored field values, not just the ids", () => {
		const stored = schedule({ id: "w2", everyMs: HOUR, untilAt: NOW + 3 * HOUR, limit: 4, firedCount: 2 });
		const roundTripped: unknown = JSON.parse(JSON.stringify({ schedules: [stored] }));
		const [restored] = getLatestWakeSchedulesFromEntries([wakeEntry(roundTripped)]);
		expect(restored).toEqual(stored);
	});
});

describe("formatWakeDeliveryText", () => {
	it("labels a one-shot and offers no cancel handle", () => {
		const text = formatWakeDeliveryText(due({ schedule: schedule({ id: "w1" }), plannedTotal: 1, final: true }));
		expect(text.split("\n")[0]).toBe("⏰ Scheduled wake w1 (one-shot).");
		expect(text).not.toContain("cancel with");
	});

	it("shows progress, cadence, and the cancel handle on a recurring delivery", () => {
		const text = formatWakeDeliveryText(
			due({ schedule: schedule({ id: "w4", everyMs: HOUR }), occurrence: 2, plannedTotal: 168 }),
		);
		const header = text.split("\n")[0] ?? "";
		expect(header).toContain("wake w4");
		expect(header).toContain("(2/168, every 1h)");
		expect(header).toContain('cancel with `wake({op:"cancel",id:"w4"})`');
	});

	it("names the delivery number when the total is unknowable", () => {
		const text = formatWakeDeliveryText(due({ schedule: schedule({ everyMs: 30 * MIN }), occurrence: 3 }));
		expect(text.split("\n")[0]).toContain("(delivery 3, every 30m)");
	});

	it("says final and withdraws the cancel handle on the last delivery", () => {
		const text = formatWakeDeliveryText(
			due({ schedule: schedule({ id: "w4", everyMs: HOUR }), occurrence: 168, plannedTotal: 168, final: true }),
		);
		expect(text.split("\n")[0]).toBe("⏰ Scheduled wake w4 (168/168, final delivery).");
		// The schedule is already off the list, so a cancel handle would dangle.
		expect(text).not.toContain("cancel");
	});

	it("carries the agent's own message verbatim after a blank line", () => {
		const message = "Check `MR !412`\n\n- report only if it changed state\n- do not re-run the pipeline";
		const text = formatWakeDeliveryText(due({ schedule: schedule({ message, everyMs: HOUR }) }));
		expect(text.endsWith(`\n\n${message}`)).toBe(true);
		// Exactly one envelope line precedes it.
		expect(text.slice(0, text.length - message.length - 2)).not.toContain("\n");
	});
});

describe("formatWakeChipText", () => {
	it("names the schedule so a queued wake is identifiable at a glance", () => {
		expect(formatWakeChipText(due({ schedule: schedule({ id: "w7" }) }))).toContain("w7");
	});

	it("does not inline the wake message, which may be up to 2k chars", () => {
		const chip = formatWakeChipText(due({ schedule: schedule({ message: "x".repeat(500) }) }));
		expect(chip).not.toContain("x");
		expect(chip).not.toContain("\n");
	});
});
