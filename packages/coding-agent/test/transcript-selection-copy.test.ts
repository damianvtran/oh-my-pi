/**
 * What the pointer puts on the clipboard, asserted against a real composed
 * frame rather than against a component's return value.
 *
 * Two gestures reach the clipboard and they answer different questions:
 *
 *  - a DRAG selects glyphs, so it must yield exactly the text under the
 *    highlight — not the card padding the rectangle also crosses, and not the
 *    accent rail a user card paints into its own first column;
 *  - a COPY CLICK (alt+click, or the second click of a double click) means
 *    "that message", so it must yield the block's source, which for a
 *    collapsed tool card is content the frame is not even showing.
 *
 * Both were wrong before this file existed: the drag cut a rectangle through
 * the chrome, and the copy click did not exist.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CARD_PADDING_X } from "@oh-my-pi/pi-coding-agent/modes/components/collapsible-block";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 60;
/** Matches the chrome below; the card's text starts PAD_X + CARD_PADDING_X in. */
const PAD_X = 2;
const HEIGHT = 20;
/** The user text is deliberately long enough to wrap, so interior rows exist. */
const USER_TEXT = "copy me exactly and nothing else at all, not the padding either";
const TOOL_OUTPUT = Array.from({ length: 40 }, (_, i) => `output line ${i + 1}`).join("\n");

/** Mirrors InteractiveMode#applyViewportChrome so the frame under test is the real one. */
function applyChrome(tui: TUI, active: Theme): void {
	tui.setViewportChrome({
		padX: PAD_X,
		padTop: 0,
		padBottom: 1,
		textInset: CARD_PADDING_X,
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

async function mount(active: Theme): Promise<Harness> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 500);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.setViewportMode("fullscreen");
	applyChrome(tui, active);

	const copied: string[] = [];
	tui.onCopy = text => copied.push(text);

	const transcript = new TranscriptContainer();
	tui.addChild(transcript);
	transcript.addChild(new UserMessageComponent(USER_TEXT));
	const tool = new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, tui);
	tool.updateResult({ content: [{ type: "text", text: TOOL_OUTPUT }], isError: false }, false);
	transcript.addChild(tool);
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

	it("copies on the second click of a double click", async () => {
		const { term, copied, rowOf } = await mount(active);
		const row = rowOf("copy me exactly");

		click(term, row, 10);
		expect(copied).toHaveLength(0);
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
});
