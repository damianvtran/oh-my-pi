/**
 * End-to-end contracts for the fullscreen viewport frame, asserted against a
 * real terminal grid rather than against the strings a component returns.
 *
 * Two defects motivated this file and neither was visible to a string-level
 * test:
 *
 *  - a user card's blank inset rows are painted, so a scroll offset that lands
 *    between two cards could leave a lone panel-coloured row on screen with no
 *    text anywhere in it — a grey bar with no apparent cause;
 *  - the gap above the first block used to be viewport chrome, so it stayed
 *    pinned at the top of a scrolled transcript instead of scrolling away.
 *
 * Both are properties of the composed frame, so the assertions read cell
 * backgrounds out of the emulator (`getViewportRowBackgrounds`) after driving
 * the engine the way the app does.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 60;
const HEIGHT = 14;

/** Mirrors InteractiveMode#applyViewportChrome so the frame under test is the real one. */
function applyChrome(tui: TUI, active: Theme): void {
	tui.setViewportChrome({
		padX: 2,
		padTop: 0,
		padBottom: 1,
		fill: (line, width) => active.surfaceBg(line, width),
		overlayFill: (line, width) => active.overlayBg(line, width),
	});
}

/** A pinned bottom chrome row, standing in for the composer. */
class PinnedRow extends Container {
	isFullscreenPinned(): boolean {
		return true;
	}
}

class StaticRows extends Container {
	#lines: string[];
	constructor(lines: string[]) {
		super();
		this.#lines = lines;
	}
	override render(): readonly string[] {
		return this.#lines;
	}
}

interface Harness {
	term: VirtualTerminal;
	tui: TUI;
	transcript: TranscriptContainer;
	settle: () => Promise<void>;
}

/**
 * The real `TranscriptContainer`, not a plain `Container`: it assembles its own
 * rows, inserts a separator between blocks and never populates the base render
 * memo, so a stand-in would exercise a block-boundary path the product never
 * takes — which is exactly how the defect under test survived its first fix.
 */
function mount(active: Theme): Harness {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 500);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.setViewportMode("fullscreen");
	applyChrome(tui, active);
	const transcript = new TranscriptContainer();
	tui.addChild(transcript);
	const pinned = new PinnedRow();
	pinned.addChild(new StaticRows(["composer"]));
	tui.addChild(pinned);
	tui.start();
	return { term, tui, transcript, settle: () => scheduler.drain(term) };
}

/** Rows of the painted viewport as plain text, with the gutter trimmed off. */
function text(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => Bun.stripANSI(line).trim());
}

/**
 * Content a row carries, ignoring the first content column: a card reserves it
 * for its left rail, which is painted down the card's blank padding rows too,
 * so a rail alone does not make a row occupied.
 */
function content(term: VirtualTerminal, row: number, padX: number): string {
	return Bun.stripANSI(term.getViewport()[row] ?? "")
		.slice(padX + 1)
		.trim();
}

/** Whether the row is painted in anything other than the window canvas. */
function isPainted(term: VirtualTerminal, row: number, canvas: string): boolean {
	return term.getViewportRowBackgrounds(row).some(bg => bg !== "default" && bg !== canvas);
}

describe("fullscreen viewport frame", () => {
	let active: Theme;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "tui.viewport": "fullscreen" } } as never);
		const dark = await getThemeByName("dark");
		expect(dark).toBeDefined();
		setThemeInstance(dark!);
		active = dark!;
	});

	it("keeps a user card's fill inside the gutter instead of running edge to edge", async () => {
		const { term, tui, transcript, settle } = mount(active);
		try {
			transcript.addChild(new UserMessageComponent("hello there"));
			tui.requestRender();
			await settle();

			const rows = text(term);
			const bodyRow = rows.findIndex(line => line.includes("hello there"));
			expect(bodyRow).toBeGreaterThanOrEqual(0);

			// The card paints a blank row above and below its body; all three sit
			// on one surface, and none of them may reach either window edge.
			for (const row of [bodyRow - 1, bodyRow, bodyRow + 1]) {
				const backgrounds = term.getViewportRowBackgrounds(row);
				expect(backgrounds).toHaveLength(WIDTH);
				const painted = new Set(backgrounds.slice(2, WIDTH - 2));
				expect(painted.size).toBe(1);
				const cardFill = [...painted][0]!;
				expect(cardFill).not.toBe("default");
				// The gutter belongs to the canvas, not to the card.
				expect(backgrounds[0]).not.toBe(cardFill);
				expect(backgrounds[1]).not.toBe(cardFill);
				expect(backgrounds[WIDTH - 1]).not.toBe(cardFill);
			}
		} finally {
			tui.stop();
		}
	});

	it("shows a blank leading row at rest and scrolls it away", async () => {
		const { term, tui, transcript, settle } = mount(active);
		try {
			transcript.addChild(new StaticRows(Array.from({ length: 40 }, (_v, i) => `line-${i}`)));
			tui.requestRender();
			await settle();

			// Pinned at the tail: the newest row is the last transcript row.
			expect(text(term).some(line => line === "line-39")).toBeTrue();

			tui.scrollTo(0);
			await settle();
			const atTop = text(term);
			expect(atTop[0]).toBe("");
			expect(atTop[1]).toBe("line-0");

			// One notch down and the gap is gone — it is content, not chrome.
			tui.scrollTo(1);
			await settle();
			expect(text(term)[0]).toBe("line-0");
		} finally {
			tui.stop();
		}
	});

	it("never leaves a card's painted padding row alone on screen while scrolling", async () => {
		const { term, tui, transcript, settle } = mount(active);
		// The window canvas; anything else on a row means a block painted it.
		const canvas = "#121212";
		try {
			for (let i = 0; i < 8; i++) transcript.addChild(new UserMessageComponent(`message ${i}`));
			tui.requestRender();
			await settle();

			const max = tui.maxScrollTop;
			expect(max).toBeGreaterThan(2);
			let paddingRowsSeen = 0;
			for (let offset = 0; offset <= max; offset++) {
				tui.scrollTo(offset);
				await settle();
				for (let row = 0; row < HEIGHT; row++) {
					if (!isPainted(term, row, canvas)) continue;
					if (content(term, row, 2) !== "") continue;
					paddingRowsSeen++;
					// A painted row with no content is a card's own inset. It is
					// only legitimate while the body it belongs to is on screen
					// next to it; alone it is a clipped remnant.
					const neighbourHasBody =
						(row > 0 && isPainted(term, row - 1, canvas) && content(term, row - 1, 2) !== "") ||
						(row + 1 < HEIGHT && isPainted(term, row + 1, canvas) && content(term, row + 1, 2) !== "");
					expect(
						neighbourHasBody,
						`row ${row} at scrollTop ${offset} is a painted blank with no card body beside it`,
					).toBeTrue();
				}
			}
			// Guard against the assertion silently never running.
			expect(paddingRowsSeen).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});
	it("keeps a clipped block's content row whose only glyph sits in the first column", async () => {
		const { term, tui, transcript, settle } = mount(active);
		try {
			// A closing brace alone on the last row is the shape that a naive
			// "ignore column 0" rule would mistake for a card's left rail.
			transcript.addChild(new StaticRows(["a0", "a1", "a2"]));
			transcript.addChild(new StaticRows([...Array.from({ length: 20 }, (_v, i) => `b${i}`), "}"]));
			transcript.addChild(new StaticRows(Array.from({ length: 30 }, (_v, i) => `c${i}`)));
			tui.requestRender();
			await settle();

			// Scroll until the brace is the topmost visible row. Its block is then
			// clipped at the top and the brace is its only visible content, which
			// is precisely the shape a blanket "column 0 is decoration" rule
			// blanks. Asserting on the top row is what makes this bite.
			let braceOnTopRow = 0;
			let braceSeen = 0;
			for (let offset = 0; offset <= tui.maxScrollTop; offset++) {
				tui.scrollTo(offset);
				await settle();
				const rows = text(term);
				if (rows.includes("}")) braceSeen++;
				if (rows[0] === "}") braceOnTopRow++;
			}
			expect(braceOnTopRow, "the brace never reached the top row; the scenario did not exercise the clip").toBe(1);
			expect(braceSeen).toBeGreaterThan(1);
		} finally {
			tui.stop();
		}
	});

	it("publishes hit zones only for blocks the window can show", async () => {
		const { tui, transcript, settle } = mount(active);
		try {
			for (let i = 0; i < 60; i++) {
				const tool = new ToolExecutionComponent("bash", { command: `echo ${i}` }, {}, undefined, tui);
				tool.updateResult({ content: [{ type: "text", text: `out ${i}` }], isError: false }, false);
				transcript.addChild(tool);
			}
			tui.requestRender();
			await settle();

			tui.scrollTo(Math.floor(tui.maxScrollTop / 2));
			await settle();

			// Bounded by the viewport, not by the transcript: 60 blocks would
			// otherwise publish 60 header zones on every frame of every scroll.
			expect(tui.hitZoneCount).toBeGreaterThan(0);
			expect(tui.hitZoneCount).toBeLessThanOrEqual(HEIGHT);
		} finally {
			tui.stop();
		}
	});

	it("keeps a block the window sits inside on screen while its blank run scrolls past", async () => {
		const { term, tui, transcript, settle } = mount(active);
		const rail = "\u258e";
		try {
			// One block taller than the viewport whose middle is a run of rows that
			// carry nothing but its rail - a pasted spaced file, a padded table.
			transcript.addChild(
				new StaticRows([`${rail} head`, ...Array.from({ length: 20 }, () => `${rail}   `), `${rail} tail`]),
			);
			tui.requestRender();
			await settle();

			const max = tui.maxScrollTop;
			expect(max).toBeGreaterThan(0);
			for (let offset = 0; offset <= max; offset++) {
				tui.scrollTo(offset);
				await settle();
				// The window is INSIDE the block: its visible rows are the block's
				// middle, not the remains of a clipped edge, so they must survive.
				// Suppressing them blanks the whole viewport for as long as the
				// blank run is on screen, then snaps the block back.
				const shown = term.getViewport().filter(line => Bun.stripANSI(line).includes(rail)).length;
				expect(shown, `viewport is empty at scrollTop ${offset}`).toBeGreaterThan(0);
			}
		} finally {
			tui.stop();
		}
	});
});
