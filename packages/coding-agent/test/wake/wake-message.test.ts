import { beforeAll, describe, expect, it, vi } from "bun:test";
import {
	formatWakeBadgeFacts,
	stripWakeEnvelope,
	WakeMessageComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/wake-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { DueWake, WakeSchedule } from "@oh-my-pi/pi-coding-agent/wake/schedule";
import {
	formatWakeDeliveryText,
	WAKE_PROMPT_MESSAGE_TYPE,
	type WakePromptDetails,
} from "@oh-my-pi/pi-coding-agent/wake/store";

const HOUR = 3_600_000;
const MESSAGE = "Check the pipeline for MR !412 and report only if it changed state.";

beforeAll(async () => {
	await initTheme();
});

function schedule(overrides: Partial<WakeSchedule> = {}): WakeSchedule {
	return {
		id: "w1",
		message: MESSAGE,
		// Relative to the wall clock because `/wake` and `describeWakeSchedule`
		// read `Date.now()`; assertions below stay off the clock-derived parts.
		nextDueAt: Date.now() + HOUR,
		firedCount: 0,
		createdAt: Date.now(),
		...overrides,
	};
}

/** Render a delivered wake the way the transcript does, minus the ANSI. */
function renderCard(details: WakePromptDetails | undefined, content: string): string {
	const message: CustomMessage<WakePromptDetails> = {
		role: "custom",
		customType: WAKE_PROMPT_MESSAGE_TYPE,
		content,
		display: true,
		details,
		attribution: "user",
		timestamp: Date.now(),
	};
	return Bun.stripANSI(new WakeMessageComponent(message).render(80).join("\n"));
}

function wakeRuntime(schedules: WakeSchedule[]) {
	let live = schedules;
	const output = vi.fn(async (_text: string) => {});
	const setWakeSchedules = vi.fn((next: WakeSchedule[]) => {
		live = next;
	});
	const runtime = {
		session: { getWakeSchedules: () => [...live], setWakeSchedules },
		output,
	} as unknown as SlashCommandRuntime;
	return {
		runtime,
		setWakeSchedules,
		remaining: () => live,
		text: () => output.mock.calls.map(call => call[0]).join("\n"),
	};
}

describe("stripWakeEnvelope", () => {
	it("drops the envelope formatWakeDeliveryText prepends", () => {
		const wake: DueWake = {
			schedule: schedule({ everyMs: HOUR, limit: 168, firedCount: 1 }),
			occurrence: 2,
			plannedTotal: 168,
			final: false,
		};

		const stripped = stripWakeEnvelope(formatWakeDeliveryText(wake));

		expect(stripped).toBe(MESSAGE);
		expect(stripped).not.toContain("Scheduled wake");
	});

	it("keeps a multi-paragraph body intact below the envelope", () => {
		const wake: DueWake = { schedule: schedule({ message: "first\n\nsecond" }), occurrence: 1, final: true };

		expect(stripWakeEnvelope(formatWakeDeliveryText(wake))).toBe("first\n\nsecond");
	});

	it("keeps text whose first line is not an envelope", () => {
		const text = "Check the pipeline\n\nand report back.";

		expect(stripWakeEnvelope(text)).toBe(text);
	});

	it("keeps an envelope-shaped line that is not followed by a blank line", () => {
		const text = "⏰ Scheduled wake w1 (one-shot).\nthis is the body";

		expect(stripWakeEnvelope(text)).toBe(text);
	});

	it("keeps single-line text", () => {
		const text = "⏰ Scheduled wake w1 (one-shot).";

		expect(stripWakeEnvelope(text)).toBe(text);
	});

	it("keeps the raw text when stripping would leave nothing to show", () => {
		const text = "⏰ Scheduled wake w1 (one-shot).\n\n   \n";

		expect(stripWakeEnvelope(text)).toBe(text);
	});
});

describe("formatWakeBadgeFacts", () => {
	it("labels a one-shot delivery", () => {
		expect(formatWakeBadgeFacts({ id: "w1", occurrence: 1 })).toBe("one-shot");
	});

	it("shows progress and cadence for a bounded recurring wake", () => {
		expect(formatWakeBadgeFacts({ id: "w1", occurrence: 2, plannedTotal: 168, everyMs: HOUR })).toBe(
			"2/168 · every 1h",
		);
	});

	it("counts deliveries when the total is not knowable", () => {
		expect(formatWakeBadgeFacts({ id: "w2", occurrence: 3, everyMs: 900_000 })).toBe("delivery 3 · every 15m");
	});

	it("marks the last delivery final instead of promising another", () => {
		expect(formatWakeBadgeFacts({ id: "w1", occurrence: 168, plannedTotal: 168, everyMs: HOUR, final: true })).toBe(
			"168/168 · final",
		);
	});

	it("falls back to a bare label for transcripts recorded without details", () => {
		expect(formatWakeBadgeFacts(undefined)).toBe("scheduled");
	});
});

describe("WakeMessageComponent", () => {
	it("badges the arrival and renders the body without the envelope", () => {
		const wake: DueWake = {
			schedule: schedule({ everyMs: HOUR, limit: 168, firedCount: 1 }),
			occurrence: 2,
			plannedTotal: 168,
			final: false,
		};
		const details: WakePromptDetails = { id: "w1", occurrence: 2, plannedTotal: 168, everyMs: HOUR };

		const rendered = renderCard(details, formatWakeDeliveryText(wake));

		expect(rendered).toContain("⏰ wake w1");
		expect(rendered).toContain("2/168 · every 1h");
		expect(rendered).toContain("MR !412");
		expect(rendered).not.toContain("Scheduled wake");
	});

	it("still shows the agent's prompt when details are missing", () => {
		const rendered = renderCard(undefined, "Poll the deploy status.");

		expect(rendered).toContain("⏰ wake");
		expect(rendered).toContain("scheduled");
		expect(rendered).toContain("Poll the deploy status.");
	});
});

describe("/wake", () => {
	it("is advertised to text-mode clients with its cancel hint", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "wake");

		expect(advertised?.description).toBe("List or cancel scheduled wakeups");
		expect(advertised?.input?.hint).toBe("[cancel <id|all>]");
	});

	it("lists each active schedule with its id and a clipped prompt", async () => {
		const h = wakeRuntime([
			schedule({ everyMs: HOUR }),
			schedule({ id: "w2", message: "Ping the on-call channel." }),
		]);

		await executeAcpBuiltinSlashCommand("/wake", h.runtime);

		const text = h.text();
		expect(text).toContain("Scheduled wakeups:");
		expect(text).toContain("w1");
		expect(text).toContain("every 1h");
		expect(text).toContain("Ping the on-call channel.");
	});

	it("clips a long prompt to one line", async () => {
		const h = wakeRuntime([schedule({ message: `${"x".repeat(400)}\nsecond line` })]);

		await executeAcpBuiltinSlashCommand("/wake", h.runtime);

		const lines = h.text().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("…");
		expect(lines[1]!.length).toBeLessThan(200);
	});

	it("reports an empty state when nothing is scheduled", async () => {
		const h = wakeRuntime([]);

		await executeAcpBuiltinSlashCommand("/wake", h.runtime);

		expect(h.text()).toContain("No scheduled wakeups");
	});

	it("cancels one schedule by id and leaves the rest armed", async () => {
		const h = wakeRuntime([schedule(), schedule({ id: "w2", message: "Ping the on-call channel." })]);

		await executeAcpBuiltinSlashCommand("/wake cancel w1", h.runtime);

		expect(h.remaining().map(s => s.id)).toEqual(["w2"]);
		expect(h.text()).toContain("Cancelled wakeup w1");
	});

	it("names the live ids when the id does not resolve", async () => {
		const h = wakeRuntime([schedule(), schedule({ id: "w2" })]);

		await executeAcpBuiltinSlashCommand("/wake cancel w9", h.runtime);

		expect(h.setWakeSchedules).not.toHaveBeenCalled();
		expect(h.text()).toContain("w1, w2");
	});

	it("cancels every schedule and confirms the count", async () => {
		const h = wakeRuntime([schedule(), schedule({ id: "w2" }), schedule({ id: "w3" })]);

		await executeAcpBuiltinSlashCommand("/wake cancel all", h.runtime);

		expect(h.remaining()).toEqual([]);
		expect(h.text()).toContain("Cancelled 3 scheduled wakeups.");
	});

	it("rejects an unknown subcommand without touching the schedules", async () => {
		const h = wakeRuntime([schedule()]);

		await executeAcpBuiltinSlashCommand("/wake snooze w1", h.runtime);

		expect(h.setWakeSchedules).not.toHaveBeenCalled();
		expect(h.text()).toContain("/wake [cancel <id|all>]");
	});

	it("requires a target for cancel", async () => {
		const h = wakeRuntime([schedule()]);

		await executeAcpBuiltinSlashCommand("/wake cancel", h.runtime);

		expect(h.setWakeSchedules).not.toHaveBeenCalled();
		expect(h.text()).toContain("Usage: /wake cancel <id|all>");
	});
});
