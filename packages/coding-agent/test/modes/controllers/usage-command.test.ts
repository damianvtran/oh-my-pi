import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface RenderableBlock {
	render(width: number): string[];
}

interface UsageOverlayHarness {
	ctx: InteractiveModeContext;
	showOverlay: ReturnType<typeof vi.fn>;
	hideOverlay: ReturnType<typeof vi.fn>;
}
function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
}

function createUsageSessionDouble() {
	return { getUsageReportingModelSelectors: () => [] };
}

function createUsageContext(): UsageOverlayHarness {
	const hideOverlay = vi.fn();
	const showOverlay = vi.fn(() => ({ hide: hideOverlay }));
	const ctx = {
		session: createUsageSessionDouble(),
		editor: {},
		ui: {
			terminal: { columns: 100, rows: 30 },
			showOverlay,
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		},
		present: vi.fn(),
		presentCommandOutput: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, showOverlay, hideOverlay };
}

describe("CommandController /usage", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", async () => {
		const { ctx, showOverlay, hideOverlay } = createUsageContext();
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
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

		await controller.handleUsageCommand(reports);

		expect(showOverlay).toHaveBeenCalledTimes(1);
		const overlay = showOverlay.mock.calls[0]?.[0];
		const output = renderPresentedBlocks(overlay);
		// The panel owns a titled chrome row, so the report body's own "Usage"
		// heading is dropped. That heading always carries an age, which a broken
		// escape in the matcher silently failed to match — printing the title
		// twice on every open.
		expect(output.match(/Usage/g)).toHaveLength(1);
		expect(output).not.toMatch(/Usage \(/);
		// The wheel is the affordance a reader cannot otherwise discover.
		expect(output).toContain("wheel scroll");
		expect(output).toContain("Esc/q close");
		overlay.handleInput("\x1b");
		expect(hideOverlay).toHaveBeenCalledTimes(1);
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const { ctx, showOverlay } = createUsageContext();
		const controller = new CommandController(ctx);
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(showOverlay).toHaveBeenCalledTimes(1);
		const output = renderPresentedBlocks(showOverlay.mock.calls[0]?.[0]);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", async () => {
		const { ctx, showOverlay } = createUsageContext();
		const controller = new CommandController(ctx);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		await controller.handleUsageCommand(reports);

		expect(showOverlay).toHaveBeenCalledTimes(1);
		const output = renderPresentedBlocks(showOverlay.mock.calls[0]?.[0]);
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});
});
