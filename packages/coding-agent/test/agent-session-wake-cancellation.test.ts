import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type CustomMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { WakeSchedule } from "@oh-my-pi/pi-coding-agent/wake/schedule";
import { WAKE_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/wake/store";

function schedule(id: string): WakeSchedule {
	return {
		id,
		message: `poll ${id}`,
		nextDueAt: Date.now() + 60_000,
		everyMs: 60_000,
		firedCount: 1,
		createdAt: Date.now(),
	};
}

function queuedWake(id: string, occurrence: number): CustomMessage {
	return {
		role: "custom",
		customType: WAKE_PROMPT_MESSAGE_TYPE,
		content: `wake ${id}`,
		display: true,
		details: { id, occurrence },
		attribution: "user",
		timestamp: Date.now(),
	};
}

describe("AgentSession wake cancellation", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("purges already-fired prompts for the cancelled schedule only", () => {
		const session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["system"], messages: [], tools: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);
		const first = schedule("w1");
		const second = schedule("w2");
		session.setWakeSchedules([first, second]);
		session.agent.steer(queuedWake("w1", 2));
		session.agent.followUp(queuedWake("w1", 3));
		session.agent.followUp({
			role: "custom",
			customType: "unrelated",
			content: "keep me",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		});
		session.agent.followUp(queuedWake("w2", 2));

		const purged = session.setWakeSchedules([second]);

		expect(purged).toBe(2);
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(
			session.agent
				.peekFollowUpQueue()
				.map(message =>
					message.role === "custom" ? [message.customType, message.details] : [message.role, undefined],
				),
		).toEqual([
			["unrelated", undefined],
			[WAKE_PROMPT_MESSAGE_TYPE, { id: "w2", occurrence: 2 }],
		]);
	});

	it("drops a fired delivery cancelled during async queue preparation", async () => {
		const session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["system"], messages: [], tools: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);
		let guardCalls = 0;

		await session.promptCustomMessage(queuedWake("w1", 2), {
			streamingBehavior: "followUp",
			queueOnly: true,
			queueGuard: () => {
				guardCalls++;
				return false;
			},
		});

		expect(guardCalls).toBe(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
});
