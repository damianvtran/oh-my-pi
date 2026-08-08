import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CollabPromptMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/collab-prompt-message";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

/**
 * In the fullscreen viewport the card owns a block's surface. A block that also
 * paints its own `userMessageBg` fills every row out to the full content width,
 * overrunning the card's inset with a second colour no neighbouring block has.
 */

function message(text: string): CustomMessage<CollabPromptDetails> {
	return {
		role: "custom",
		customType: COLLAB_PROMPT_MESSAGE_TYPE,
		content: text,
		display: true,
		details: { from: "ada" },
		timestamp: 0,
	};
}

async function boot(viewport: "append" | "fullscreen"): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "tui.viewport": viewport } } as never);
	await initTheme(false, undefined, undefined, "dark", "light");
}

afterEach(() => {
	resetSettingsForTest();
});

describe("CollabPromptMessageComponent", () => {
	describe("fullscreen viewport", () => {
		beforeEach(async () => {
			await boot("fullscreen");
		});

		it("hands the surface to the card instead of painting a userMessageBg bubble", () => {
			const rows = new CollabPromptMessageComponent(message("hello from the guest")).render(60);
			const raw = rows.join("\n");
			expect(raw).not.toContain(theme.getBgAnsi("userMessageBg"));
			// The card's fill is what every other transcript block shows.
			expect(raw).toContain(theme.panelBgAnsi);
			expect(Bun.stripANSI(raw)).toContain("«ada» ›");
			expect(Bun.stripANSI(raw)).toContain("hello from the guest");
			// Card inset: a blank padding row top and bottom, body indented by
			// CARD_PADDING_X, and every row painted out to the full width.
			expect(Bun.stripANSI(rows[0]!)).toBe(" ".repeat(60));
			expect(Bun.stripANSI(rows.at(-1)!)).toBe(" ".repeat(60));
			expect(Bun.stripANSI(rows[1]!)).toStartWith("  «ada» ›");
			for (const row of rows) expect(Bun.stripANSI(row)).toHaveLength(60);
		});
	});

	describe("append viewport", () => {
		beforeEach(async () => {
			await boot("append");
		});

		it("keeps the userMessageBg bubble, which is the only surface it has", () => {
			const raw = new CollabPromptMessageComponent(message("hello from the guest")).render(60).join("\n");
			expect(raw).toContain(theme.getBgAnsi("userMessageBg"));
			expect(Bun.stripANSI(raw)).toContain("«ada» ›");
			expect(Bun.stripANSI(raw)).toContain("hello from the guest");
		});
	});
});
