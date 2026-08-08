import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AgentRowList } from "@oh-my-pi/pi-coding-agent/modes/components/agent-row-list";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { HitZoneSink } from "@oh-my-pi/pi-tui";

let focusController: SessionFocusController | undefined;

describe("AgentRowList", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		focusController?.dispose();
		focusController = undefined;
	});

	it("publishes a pointer row, paints hover across it, and drills into its agent", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: {} as AgentSession,
			status: "running",
		});
		focusController = new SessionFocusController(
			{ collabGuest: undefined } as unknown as InteractiveModeContext,
			registry,
		);
		const focusAgent = vi.spyOn(focusController, "focusAgent").mockResolvedValue();

		const list = new AgentRowList("test-agent-list");
		list.setRows(["Subagents", "└ Worker: indexing"], [{ line: 1, agentId: "Worker" }]);
		const sink = new HitZoneSink();
		list.publishHitZones(sink);

		expect(sink.zones).toHaveLength(1);
		const zone = sink.zones[0]!;
		expect(zone.row).toBe(1);
		expect(zone.rowCount).toBe(1);
		expect(zone.target.pointerShape).toBe("pointer");

		const before = list.render(40)[1];
		expect(zone.target.onZoneHover?.(true)).toBe(true);
		const hovered = list.render(40)[1];
		expect(hovered).not.toBe(before);
		expect(hovered).toContain("\x1b[48;2;");
		expect(Bun.stringWidth(Bun.stripANSI(hovered ?? ""))).toBe(39);

		expect(zone.target.onZoneClick?.({} as never)).toBe(true);
		await Promise.resolve();
		expect(focusAgent).toHaveBeenCalledWith("Worker");
	});
});
