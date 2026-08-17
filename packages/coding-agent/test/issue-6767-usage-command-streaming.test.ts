import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

const usageReports: UsageReport[] = [
	{
		provider: "openai-codex",
		fetchedAt: 1_700_000_000_000,
		limits: [
			{
				id: "codex-weekly",
				label: "Weekly",
				scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
				window: { id: "weekly", label: "weekly" },
				amount: { remainingFraction: 0.25, unit: "requests" },
				status: "ok",
			},
		],
		metadata: { email: "user@example.com" },
	},
];

describe("issue #6767 /usage output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-6767-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps the usage panel out of the transcript entirely, mid-stream and after", async () => {
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);
		const showOverlay = vi.spyOn(mode.ui, "showOverlay");

		await mode.handleUsageCommand(usageReports);

		// The original defect (#6767) was the finalized panel mounting above a
		// growing live block and duplicating in native scrollback. The panel is
		// now a floating overlay, so it never touches the transcript at all —
		// which is what makes the defect unreachable rather than merely deferred.
		expect(mode.chatContainer.children).toEqual([streamedReply]);
		expect(showOverlay).toHaveBeenCalledTimes(1);
		const panel = showOverlay.mock.calls[0]?.[0] as { render(width: number): readonly string[] };
		expect(Bun.stripANSI(panel.render(80).join("\n"))).toContain("Usage");

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.chatContainer.children).toEqual([streamedReply]);
		expect(showOverlay).toHaveBeenCalledTimes(1);
	});
});
