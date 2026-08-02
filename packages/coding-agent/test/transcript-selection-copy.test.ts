/**
 * What the pointer puts on the clipboard, asserted against a real composed
 * frame rather than against a component's return value.
 *
 * Two gestures reach the clipboard and they answer different questions:
 *
 *  - a DRAG selects glyphs, so it must yield exactly the text under the
 *    highlight — not the card padding the rectangle also crosses, and not the
 *    accent rail a user card paints into its own first column;
 *  - a COPY CLICK (Alt+click on any block, or click two on copy-only prose)
 *    means "that source", so it must recover content a collapsed card is not
 *    even showing without letting activation reflow the target between clicks.
 *
 * Both were wrong before this file existed: the drag cut a rectangle through
 * the chrome, and the copy click did not exist.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { CollabPromptMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/collab-prompt-message";
import { EvalExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/eval-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import {
	CollapsedSyntheticMessageComponent,
	UserMessageComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const WIDTH = 60;
/** Window gutter; card insets are published separately by each component. */
const PAD_X = 2;
const HEIGHT = 20;
/** The user text is deliberately long enough to wrap, so interior rows exist. */
const USER_TEXT = "copy me exactly and nothing else at all, not the padding either";
const ASSISTANT_TEXT = "assistant starts at its first cell";
const TOOL_OUTPUT = Array.from({ length: 40 }, (_, i) => `output line ${i + 1}`).join("\n");
const READ_OUTPUT = Array.from({ length: 12 }, (_, i) => `read line ${i + 1}`).join("\n");
const ERROR_OUTPUT = "provider rejected this turn";
const LONG_OUTPUT = "x".repeat(4_001);

/** Mirrors InteractiveMode#applyViewportChrome so the frame under test is the real one. */
function applyChrome(tui: TUI, active: Theme): void {
	tui.setViewportChrome({
		padX: PAD_X,
		padTop: 0,
		padBottom: 1,
		fill: (line, width) => active.surfaceBg(line, width),
		overlayFill: (line, width) => active.overlayBg(line, width),
	});
}

interface Harness {
	tui: TUI;
	term: VirtualTerminal;
	copied: string[];
	settle: () => Promise<void>;
	/** Screen row a substring lands on, or -1. */
	rowOf(text: string): number;
}

async function mountWith(
	active: Theme,
	populate: (transcript: TranscriptContainer, tui: TUI) => void,
): Promise<Harness> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 500);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.setViewportMode("fullscreen");
	applyChrome(tui, active);

	const copied: string[] = [];
	tui.onCopy = text => copied.push(text);

	const transcript = new TranscriptContainer();
	tui.addChild(transcript);
	populate(transcript, tui);
	tui.start();

	const settle = () => scheduler.drain(term);
	tui.requestRender();
	await settle();

	const rowOf = (needle: string): number => {
		const rows = term.getViewport().map(line => Bun.stripANSI(line));
		return rows.findIndex(line => line.includes(needle));
	};
	return { tui, term, copied, settle, rowOf };
}

async function mount(active: Theme): Promise<Harness> {
	return mountWith(active, (transcript, tui) => {
		transcript.addChild(new UserMessageComponent(USER_TEXT));
		transcript.addChild(new AssistantMessageComponent(createAssistantMessage(ASSISTANT_TEXT)));
		const tool = new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, tui);
		tool.updateResult({ content: [{ type: "text", text: TOOL_OUTPUT }], isError: false }, false);
		transcript.addChild(tool);
	});
}

/** One SGR press/release pair at a screen cell. `mods` are the SGR button bits. */
function click(term: VirtualTerminal, row: number, col: number, mods = 0): void {
	term.sendInput(`\x1b[<${mods};${col + 1};${row + 1}M`);
	term.sendInput(`\x1b[<${mods};${col + 1};${row + 1}m`);
}

/** Press, move to a second cell, release: the engine's drag-select gesture. */
function drag(term: VirtualTerminal, from: [number, number], to: [number, number]): void {
	term.sendInput(`\x1b[<0;${from[1] + 1};${from[0] + 1}M`);
	term.sendInput(`\x1b[<32;${to[1] + 1};${to[0] + 1}M`);
	term.sendInput(`\x1b[<0;${to[1] + 1};${to[0] + 1}m`);
}

describe("transcript drag-selection", () => {
	let active: Theme;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "tui.viewport": "fullscreen" } } as never);
		const dark = await getThemeByName("dark");
		expect(dark).toBeDefined();
		setThemeInstance(dark!);
		active = dark!;
	});

	it("copies the text without the card padding it drags across", async () => {
		const { term, copied, rowOf } = await mount(active);
		const row = rowOf("copy me exactly");
		expect(row).toBeGreaterThanOrEqual(0);

		// From column 0 — outside the card's text entirely — to the far right
		// edge. A rectangular cut would take the gutter, the card inset and the
		// trailing fill along with the words.
		drag(term, [row, 0], [row, WIDTH - 1]);

		expect(copied).toHaveLength(1);
		expect(copied[0]).toBe("copy me exactly and nothing else at all, not the");
		expect(copied[0]!.startsWith(" ")).toBe(false);
	});

	it("keeps the accent rail out of a multi-row selection", async () => {
		const { term, copied, rowOf } = await mount(active);
		const first = rowOf("copy me exactly");
		const last = rowOf("padding either");
		expect(last).toBeGreaterThan(first);

		drag(term, [first, 0], [last, WIDTH - 1]);

		const text = copied[0] ?? "";
		// The rail is a literal glyph painted into column 0 of every user-card
		// row, so it survives ANSI stripping and lands in the clipboard unless
		// the cut is bounded by the card's content columns.
		expect(text).not.toContain("▌");
		expect(text.split("\n").every(line => !line.startsWith(" "))).toBe(true);
		expect(text).toContain("copy me exactly");
		expect(text).toContain("padding either");
	});

	it("keeps the first cell of unpadded assistant prose", async () => {
		const { term, copied, rowOf } = await mount(active);
		const row = rowOf(ASSISTANT_TEXT);
		expect(row).toBeGreaterThanOrEqual(0);

		drag(term, [row, 0], [row, WIDTH - 1]);

		expect(copied).toEqual([ASSISTANT_TEXT]);
	});

	it("composes a tool card's inset with its padded result rows", async () => {
		const harness = await mountWith(active, (transcript, tui) => {
			const tool = new ToolExecutionComponent("glob", { path: "/tmp/*.ts" }, {}, undefined, tui);
			tool.updateResult({ content: [{ type: "text", text: "/tmp/alpha.ts\n/tmp/beta.ts" }], isError: false }, false);
			tool.setExpanded(true);
			transcript.addChild(tool);
		});
		const row = harness.rowOf("/tmp/alpha.ts");
		expect(row).toBeGreaterThanOrEqual(0);

		drag(harness.term, [row, 0], [row, WIDTH - 1]);

		expect(harness.copied).toHaveLength(1);
		expect(harness.copied[0]).toContain("/tmp/alpha.ts");
		expect(harness.copied[0]!.startsWith(" ")).toBe(false);
	});
});

describe("transcript copy gesture", () => {
	let active: Theme;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "tui.viewport": "fullscreen" } } as never);
		const dark = await getThemeByName("dark");
		expect(dark).toBeDefined();
		setThemeInstance(dark!);
		active = dark!;
	});

	it("copies a user message's source on alt+click", async () => {
		const { term, copied, rowOf } = await mount(active);
		const row = rowOf("copy me exactly");

		// Button 8 is a plain left click with the alt bit set.
		click(term, row, 10, 8);

		expect(copied).toEqual([USER_TEXT]);
	});

	it("copies an assistant error row without expanding it", async () => {
		const harness = await mountWith(active, transcript => {
			transcript.addChild(
				new AssistantMessageComponent({
					...createAssistantMessage(""),
					stopReason: "error",
					errorMessage: ERROR_OUTPUT,
				}),
			);
		});
		const row = harness.rowOf(`Error: ${ERROR_OUTPUT}`);
		expect(row).toBeGreaterThanOrEqual(0);
		const before = Bun.stripANSI(harness.term.getViewport().join("\n"));

		click(harness.term, row, 10, 8);
		await harness.settle();

		expect(harness.copied).toEqual([ERROR_OUTPUT]);
		expect(Bun.stripANSI(harness.term.getViewport().join("\n"))).toBe(before);
	});

	it("copies the inline error instead of partial assistant prose", async () => {
		const harness = await mountWith(active, transcript => {
			transcript.addChild(
				new AssistantMessageComponent({
					...createAssistantMessage("partial answer before failure"),
					stopReason: "error",
					errorMessage: ERROR_OUTPUT,
				}),
			);
		});
		const row = harness.rowOf(`Error: ${ERROR_OUTPUT}`);
		expect(row).toBeGreaterThanOrEqual(0);
		const before = Bun.stripANSI(harness.term.getViewport().join("\n"));

		click(harness.term, row, 10, 8);
		await harness.settle();

		expect(harness.copied).toEqual([ERROR_OUTPUT]);
		expect(Bun.stripANSI(harness.term.getViewport().join("\n"))).toBe(before);
	});

	it("copies local bash source and output without toggling the card", async () => {
		const harness = await mountWith(active, (transcript, tui) => {
			const bash = new BashExecutionComponent("printf hello", tui);
			bash.setComplete(0, false, { output: "hello\nworld" });
			transcript.addChild(bash);
		});
		const before = Bun.stripANSI(harness.term.getViewport().join("\n"));

		click(harness.term, harness.rowOf("$ printf hello"), 10, 8);
		await harness.settle();

		expect(harness.copied).toEqual(["Bash:\n\nprintf hello\n\nOutput:\nhello\nworld"]);
		expect(Bun.stripANSI(harness.term.getViewport().join("\n"))).toBe(before);
	});

	it("copies retained bash output beyond the display-line cap", async () => {
		const harness = await mountWith(active, (transcript, tui) => {
			const bash = new BashExecutionComponent("printf long", tui);
			bash.setComplete(0, false, { output: LONG_OUTPUT });
			transcript.addChild(bash);
		});
		const rendered = Bun.stripANSI(harness.term.getViewport().join("\n"));
		expect(rendered).toContain("visible columns omitted");
		expect(rendered).not.toContain(LONG_OUTPUT);

		click(harness.term, harness.rowOf("$ printf long"), 10, 8);

		expect(harness.copied).toEqual([`Bash:\n\nprintf long\n\nOutput:\n${LONG_OUTPUT}`]);
	});

	it("copies local eval source and output without toggling the card", async () => {
		const harness = await mountWith(active, (transcript, tui) => {
			const evalBlock = new EvalExecutionComponent("print('hi')", tui);
			evalBlock.setComplete(0, false, { output: "hi" });
			transcript.addChild(evalBlock);
		});
		const before = Bun.stripANSI(harness.term.getViewport().join("\n"));

		click(harness.term, harness.rowOf(">>>"), 10, 8);
		await harness.settle();

		expect(harness.copied).toEqual(["Eval (python):\n\nprint('hi')\n\nOutput:\nhi"]);
		expect(Bun.stripANSI(harness.term.getViewport().join("\n"))).toBe(before);
	});

	it("copies retained eval output beyond the display-line cap", async () => {
		const harness = await mountWith(active, (transcript, tui) => {
			const evalBlock = new EvalExecutionComponent("print('long')", tui);
			evalBlock.setComplete(0, false, { output: LONG_OUTPUT });
			transcript.addChild(evalBlock);
		});
		const rendered = Bun.stripANSI(harness.term.getViewport().join("\n"));
		expect(rendered).toContain("chars omitted");
		expect(rendered).not.toContain(LONG_OUTPUT);

		click(harness.term, harness.rowOf(">>>"), 10, 8);

		expect(harness.copied).toEqual([`Eval (python):\n\nprint('long')\n\nOutput:\n${LONG_OUTPUT}`]);
	});

	it("copies a collab guest's attribution and original prose", async () => {
		const harness = await mountWith(active, transcript => {
			transcript.addChild(
				new CollabPromptMessageComponent({
					role: "custom",
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content: "hello from the guest",
					display: true,
					details: { from: "ada" },
					timestamp: 0,
				}),
			);
		});

		click(harness.term, harness.rowOf("«ada»"), 10, 8);

		expect(harness.copied).toEqual(["From ada:\n\nhello from the guest"]);
	});

	it("copies a collapsed synthetic user's complete source", async () => {
		const source = "# Session update\n\nA complete remote transcript payload.";
		const harness = await mountWith(active, transcript => {
			transcript.addChild(new CollapsedSyntheticMessageComponent(source));
		});

		click(harness.term, harness.rowOf("Session update"), 10, 8);

		expect(harness.copied).toEqual([source]);
	});

	it("copies a tool card's whole output, not the rows on screen", async () => {
		const { term, copied, rowOf } = await mount(active);
		const row = rowOf("Bash: ls");
		expect(row).toBeGreaterThanOrEqual(0);

		click(term, row, 10, 8);

		expect(copied).toHaveLength(1);
		// The card is collapsed to a preview, so the last line is not painted
		// anywhere in the frame. Copying it is the entire point of the gesture.
		expect(copied[0]).toContain("output line 40");
		expect(Bun.stripANSI(term.getViewport().join("\n"))).not.toContain("output line 40");
	});

	it("copies a copy-only message on click two and starts a new pair on click three", async () => {
		const { term, copied, rowOf } = await mount(active);
		const row = rowOf("copy me exactly");

		click(term, row, 10);
		expect(copied).toHaveLength(0);
		click(term, row, 10);
		expect(copied).toEqual([USER_TEXT]);
		click(term, row, 10);

		expect(copied).toEqual([USER_TEXT]);
	});

	it("does not copy two deliberate clicks in the same place", async () => {
		const { term, copied, rowOf } = await mount(active);
		const row = rowOf("copy me exactly");

		click(term, row, 10);
		await Bun.sleep(450);
		click(term, row, 10);

		expect(copied).toHaveLength(0);
	});

	it("leaves a tool card's expansion alone when alt+click copies it", async () => {
		const { term, copied, rowOf } = await mount(active);
		const before = Bun.stripANSI(term.getViewport().join("\n"));

		click(term, rowOf("Bash: ls"), 10, 8);

		expect(copied).toHaveLength(1);
		expect(Bun.stripANSI(term.getViewport().join("\n"))).toBe(before);
	});

	it("treats double-click on a collapsible tool as two toggles, not copy", async () => {
		const { term, copied, settle, rowOf } = await mount(active);
		const before = Bun.stripANSI(term.getViewport().join("\n"));
		const row = rowOf("Bash: ls");

		click(term, row, 10);
		await settle();
		expect(Bun.stripANSI(term.getViewport().join("\n"))).toContain("output line 40");
		click(term, row, 10);
		await settle();

		expect(copied).toHaveLength(0);
		expect(Bun.stripANSI(term.getViewport().join("\n"))).toBe(before);
	});

	it("copies every grouped read result, including an empty file, with path labels", async () => {
		const harness = await mountWith(active, transcript => {
			const reads = new ReadToolGroupComponent({ showContentPreview: true });
			reads.updateArgs({ path: "/tmp/empty.txt" }, "read-empty");
			reads.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "read-empty");
			reads.updateArgs({ path: "/tmp/a.txt" }, "read-1");
			reads.updateResult({ content: [{ type: "text", text: READ_OUTPUT }], isError: false }, false, "read-1");
			transcript.addChild(reads);
		});

		click(harness.term, harness.rowOf("empty.txt"), 10, 8);

		expect(harness.copied).toEqual([`Read: /tmp/empty.txt\n\nRead: /tmp/a.txt\n\n${READ_OUTPUT}`]);
	});
});
