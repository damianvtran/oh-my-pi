import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { CompactionSummaryMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/compaction-summary-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { Container, Spacer } from "@oh-my-pi/pi-tui";
import { buildSessionContext } from "../src/session/session-context";
import type { SessionEntry } from "../src/session/session-entries";

/**
 * Contract under test: with `display.collapseCompacted` off (the default), a
 * compaction shrinks the MODEL's context but not the visible transcript, so the
 * TUI must leave the cards on screen alone and only add the divider. The old
 * behaviour tore the transcript down and cleared native scrollback on every
 * compaction, which with the collapse disabled erased history the user could
 * still legitimately scroll back through.
 */

const timestamp = "2026-08-02T00:00:00.000Z";

/** m0 is compacted away for the model; m1 onward is the kept tail. */
const entries = [
	{
		type: "message",
		id: "m0",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "dropped from the model context" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "m1",
		parentId: "m0",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "kept tail" }], timestamp: 2 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "m1",
		timestamp,
		summary: "the summary",
		firstKeptEntryId: "m1",
		tokensBefore: 4096,
	},
	{
		type: "message",
		id: "m2",
		parentId: "c1",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 3 },
	},
] satisfies SessionEntry[];

function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap(block => (block.type === "text" ? [block.text] : []));
	});
}

function buildCtx(collapseCompacted: boolean) {
	const chatContainer = new Container();
	const statusContainer = new Container();
	// Settled transcript content the user can still scroll through. A rebuild
	// replaces these instances; the inline path must keep them identical.
	chatContainer.addChild(new Spacer(1));
	chatContainer.addChild(new Spacer(1));
	const settled = [...chatContainer.children];

	const requestRender = vi.fn();
	const rebuildChatFromMessages = vi.fn();
	const appendCompactionDivider = vi.fn();
	const ctx = {
		loadingAnimation: undefined,
		chatContainer,
		statusContainer,
		ui: { requestRender, requestComponentRender: vi.fn() },
		session: {
			compact: vi.fn(
				async (): Promise<CompactionResult<unknown>> => ({ summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
			),
		},
		rebuildChatFromMessages,
		appendCompactionDivider,
		statusLine: { invalidate: vi.fn() },
		showError: vi.fn(),
		flushCompactionQueue: vi.fn(async () => undefined),
		settings: { get: vi.fn(() => collapseCompacted) },
	} as unknown as InteractiveModeContext;

	return { ctx, chatContainer, settled, requestRender, rebuildChatFromMessages, appendCompactionDivider };
}

beforeAll(async () => {
	await initTheme(false);
});

describe("compaction with inline history", () => {
	it("keeps the transcript and scrollback intact, appending only the divider", async () => {
		const { ctx, chatContainer, settled, requestRender, rebuildChatFromMessages, appendCompactionDivider } =
			buildCtx(false);

		expect(await new CommandController(ctx).executeCompaction()).toBe("ok");

		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(appendCompactionDivider).toHaveBeenCalledTimes(1);
		// Same component instances: no card lost its expand state to a rebuild.
		expect(chatContainer.children).toEqual(settled);
		// A plain repaint. `requestRender(true, { clearScrollback: true })` would
		// purge the terminal scrollback holding the pre-compaction history.
		expect(requestRender).toHaveBeenCalledWith();
		expect(requestRender).not.toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("still replaces the transcript when collapsing is enabled", async () => {
		const { ctx, requestRender, rebuildChatFromMessages, appendCompactionDivider } = buildCtx(true);

		expect(await new CommandController(ctx).executeCompaction()).toBe("ok");

		expect(rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		expect(appendCompactionDivider).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("keeps pre-compaction messages in the transcript while dropping them from the model context", () => {
		const transcript = buildSessionContext(entries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: false,
		});
		const agent = buildSessionContext(entries, undefined, undefined, {});

		expect(userTexts(transcript.messages)).toEqual([
			"dropped from the model context",
			"kept tail",
			"after compaction",
		]);
		expect(userTexts(agent.messages)).toEqual(["kept tail", "after compaction"]);
		// Both still carry the summary; only its placement differs.
		expect(agent.messages.filter(message => message.role === "compactionSummary")).toHaveLength(1);
	});

	it("renders the divider the inline path appends from the transcript context", () => {
		const chatContainer = new TranscriptContainer();
		const helpers = new UiHelpers({
			chatContainer,
			transcriptMessageComponents: new WeakMap(),
			getUserMessageText: (message: Message) =>
				message.role === "user" && typeof message.content === "string" ? message.content : "",
			viewSession: { extensionRunner: undefined, sessionManager: { putBlobSync: () => "unused" } },
			ui: { requestRender: vi.fn(), imageBudget: undefined },
			settings: { get: vi.fn(() => false) },
			toolOutputExpanded: false,
		} as unknown as InteractiveModeContext);

		// Exactly what `appendCompactionDivider` does: take the newest summary out
		// of a transcript context and hand it to the normal message factory.
		const { messages } = buildSessionContext(entries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: false,
		});
		const summary = messages.findLast(message => message.role === "compactionSummary");
		if (!summary) throw new Error("Expected a compaction summary in the transcript context");
		helpers.addMessageToChat(summary);

		expect(chatContainer.children).toHaveLength(1);
		expect(chatContainer.children[0]).toBeInstanceOf(CompactionSummaryMessageComponent);
	});
});
