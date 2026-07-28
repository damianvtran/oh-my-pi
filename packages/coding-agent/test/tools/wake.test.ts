import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WakeTool, wakeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools";
import { MAX_WAKE_SCHEDULES, type WakeSchedule } from "@oh-my-pi/pi-coding-agent/wake/schedule";

interface WakeSession {
	session: ToolSession;
	/** Live list the tool writes through `setWakeSchedules`. */
	stored: () => WakeSchedule[];
}

function createSession(taskDepth = 0, initial: WakeSchedule[] = []): WakeSession {
	let schedules = initial;
	return {
		stored: () => schedules,
		session: {
			cwd: "/tmp/test",
			hasUI: false,
			taskDepth,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getWakeSchedules: () => schedules,
			setWakeSchedules: next => {
				schedules = next;
			},
		},
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

beforeAll(async () => {
	await initTheme();
});

describe("WakeTool.createIf", () => {
	it("creates the tool for a top-level session with wake accessors", () => {
		expect(WakeTool.createIf(createSession().session)).toBeInstanceOf(WakeTool);
	});

	it("returns null for a subagent, whose session ends before a wake could fire", () => {
		expect(WakeTool.createIf(createSession(1).session)).toBeNull();
	});

	it("returns null when the session cannot store schedules", () => {
		const { session } = createSession();
		session.setWakeSchedules = undefined;
		expect(WakeTool.createIf(session)).toBeNull();
	});
});

describe("WakeTool create", () => {
	it("schedules a one-shot from `at` and reports the cancel handle", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);

		const result = await tool.execute("c1", { at: "+2h", message: "Check the deploy" });

		expect(result.isError).toBeUndefined();
		expect(fake.stored()).toHaveLength(1);
		const [schedule] = fake.stored();
		expect(schedule.id).toBe("w1");
		expect(schedule.message).toBe("Check the deploy");
		expect(schedule.everyMs).toBeUndefined();
		expect(schedule.nextDueAt).toBeGreaterThan(Date.now());
		expect(result.details?.op).toBe("create");
		expect(result.details?.targetId).toBe("w1");
		expect(textOf(result)).toContain("Wake w1 scheduled");
		expect(textOf(result)).toContain('wake({op:"cancel",id:"w1"})');
	});

	it("schedules a recurring wake bounded by `until`", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);

		const result = await tool.execute("c1", { every: "1h", until: "+7d", message: "Poll the pipeline" });

		expect(result.isError).toBeUndefined();
		const [schedule] = fake.stored();
		expect(schedule.everyMs).toBe(60 * 60 * 1000);
		expect(schedule.untilAt).toBeGreaterThan(schedule.nextDueAt);
		expect(textOf(result)).toContain("every 1h");
	});

	it("assigns sequential ids and keeps earlier schedules", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);

		await tool.execute("c1", { at: "+1h", message: "first" });
		const second = await tool.execute("c2", { at: "+2h", message: "second" });

		expect(fake.stored().map(schedule => schedule.id)).toEqual(["w1", "w2"]);
		expect(textOf(second)).toContain("2 wakes now armed");
	});

	it("surfaces the core's rejection sentence for a sub-minute interval", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);

		const result = await tool.execute("c1", { every: "10s", message: "too fast" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("`every` must be at least");
		expect(fake.stored()).toHaveLength(0);
	});

	it("surfaces the core's rejection when neither `at` nor `every` is given", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);

		const result = await tool.execute("c1", { message: "when?" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Give `at` (one-shot) or `every` (recurring)");
		expect(fake.stored()).toHaveLength(0);
	});

	it("rejects `id` on a create call instead of dropping it", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);

		const result = await tool.execute("c1", { at: "+1h", message: "watch", id: "w3" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('`id` only applies to `op: "cancel"`');
		expect(fake.stored()).toHaveLength(0);
	});

	it("refuses to exceed the schedule ceiling", async () => {
		const full: WakeSchedule[] = Array.from({ length: MAX_WAKE_SCHEDULES }, (_unused, index) => ({
			id: `w${index + 1}`,
			message: `watch ${index}`,
			nextDueAt: Date.now() + 60_000,
			firedCount: 0,
			createdAt: Date.now(),
		}));
		const fake = createSession(0, full);
		const tool = new WakeTool(fake.session);

		const result = await tool.execute("c1", { at: "+1h", message: "one more" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("already scheduled");
		expect(fake.stored()).toHaveLength(MAX_WAKE_SCHEDULES);
	});
});

describe("WakeTool list", () => {
	it("says so plainly when nothing is armed", async () => {
		const tool = new WakeTool(createSession().session);

		const result = await tool.execute("c1", { op: "list" });

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe("No wakes scheduled.");
		expect(result.details?.op).toBe("list");
	});

	it("reflects the schedules created so far", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		await tool.execute("c1", { at: "+1h", message: "check the queue depth" });
		await tool.execute("c2", { every: "30m", limit: 4, message: "poll the rollout" });

		const result = await tool.execute("c3", { op: "list" });

		const text = textOf(result);
		expect(text).toContain("2 wakes scheduled:");
		expect(text).toContain("w1 — ");
		expect(text).toContain("check the queue depth");
		expect(text).toContain("w2 — ");
		expect(text).toContain("every 30m");
		expect(result.details?.schedules).toHaveLength(2);
	});

	it("rejects a list call carrying create arguments", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);

		const result = await tool.execute("c1", { op: "list", message: "watch", every: "1h" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('`op: "list"` takes no other arguments');
		expect(textOf(result)).toContain("`message`, `every`");
		expect(fake.stored()).toHaveLength(0);
	});
});

describe("WakeTool cancel", () => {
	it("removes the named schedule and leaves the rest", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		await tool.execute("c1", { at: "+1h", message: "first" });
		await tool.execute("c2", { at: "+2h", message: "second" });

		const result = await tool.execute("c3", { op: "cancel", id: "w1" });

		expect(result.isError).toBeUndefined();
		expect(fake.stored().map(schedule => schedule.id)).toEqual(["w2"]);
		expect(textOf(result)).toContain("Wake w1 cancelled");
		expect(textOf(result)).toContain("1 wake still scheduled.");
		expect(result.details?.targetId).toBe("w1");
	});

	it("names the live ids when the id is unknown", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		await tool.execute("c1", { at: "+1h", message: "first" });
		await tool.execute("c2", { at: "+2h", message: "second" });

		const result = await tool.execute("c3", { op: "cancel", id: "w9" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('No wake with id "w9"');
		expect(textOf(result)).toContain("Live ids: w1, w2.");
		expect(fake.stored()).toHaveLength(2);
	});

	it("asks for an id rather than guessing", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		await tool.execute("c1", { at: "+1h", message: "first" });

		const result = await tool.execute("c2", { op: "cancel" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("needs `id`");
		expect(fake.stored()).toHaveLength(1);
	});

	it("rejects a cancel call carrying create arguments", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		await tool.execute("c1", { at: "+1h", message: "first" });

		const result = await tool.execute("c2", { op: "cancel", id: "w1", every: "1h" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('`op: "cancel"` takes only `id`');
		expect(fake.stored()).toHaveLength(1);
	});
});

describe("wakeToolRenderer", () => {
	const options = { expanded: true, isPartial: false, spinnerFrame: 0 };

	it("renders a pending create call without throwing", () => {
		const component = wakeToolRenderer.renderCall({ at: "+2h", message: "Check the deploy status" }, options, theme);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("Wake");
		expect(rendered).toContain("Check the deploy status");
	});

	it("tolerates half-typed streaming args", () => {
		const args = { op: 1, message: null, id: [] } as unknown as Parameters<typeof wakeToolRenderer.renderCall>[0];

		expect(() => wakeToolRenderer.renderCall(args, options, theme)).not.toThrow();
	});

	it("renders a create result with the new id", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		const result = await tool.execute("c1", { every: "1h", until: "+7d", message: "Poll the pipeline" });

		const component = wakeToolRenderer.renderResult(result, options, theme);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("w1");
		expect(rendered).toContain("every 1h");
		expect(rendered).toContain("Poll the pipeline");
	});

	it("renders a list result with one row per schedule", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		await tool.execute("c1", { at: "+1h", message: "first watch" });
		await tool.execute("c2", { at: "+2h", message: "second watch" });
		const result = await tool.execute("c3", { op: "list" });

		const rendered = Bun.stripANSI(wakeToolRenderer.renderResult(result, options, theme).render(120).join("\n"));

		expect(rendered).toContain("2 wakes scheduled");
		expect(rendered).toContain("w1");
		expect(rendered).toContain("w2");
	});

	it("renders the retired id for a cancel result", async () => {
		const fake = createSession();
		const tool = new WakeTool(fake.session);
		await tool.execute("c1", { at: "+1h", message: "first watch" });
		const result = await tool.execute("c2", { op: "cancel", id: "w1" });

		const rendered = Bun.stripANSI(wakeToolRenderer.renderResult(result, options, theme).render(120).join("\n"));

		expect(rendered).toContain("w1 cancelled");
	});

	it("renders an error result as an error line", async () => {
		const tool = new WakeTool(createSession().session);
		const result = await tool.execute("c1", { every: "10s", message: "too fast" });

		const rendered = Bun.stripANSI(wakeToolRenderer.renderResult(result, options, theme).render(120).join("\n"));

		expect(rendered).toContain("Error:");
		expect(rendered).toContain("`every` must be at least");
	});
});
