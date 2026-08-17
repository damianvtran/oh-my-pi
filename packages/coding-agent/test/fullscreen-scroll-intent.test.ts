/**
 * Follow-the-tail is INTENT, and these pin the two ways it used to be decided
 * by arithmetic instead.
 *
 * `maxScrollTop` measures the frame on screen. Between renders the transcript
 * moves — a streaming card grows, a settled one collapses to its summary — so
 * clamping a gesture against that number answers a question about the wrong
 * frame. When the transcript had grown, a one-notch nudge downward was clamped
 * to a bottom that no longer existed, which latched follow mode and made the
 * next frame yank the reader to the real tail. The reader never asked to
 * follow anything.
 *
 * The engine's own re-pin has the mirror problem: it moves the offset, and
 * anything that re-derives intent from an offset the engine just moved can
 * silently drop a reader out of follow mode. Both guards are ported from
 * opencode's renderer (`_isApplyingStickyScroll`, and the `maxScroll > 1`
 * floor in `syncManualScrollState`).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 60;
const HEIGHT = 16;

/** A block whose height changes under the reader, standing in for a live card. */
class Streaming extends Container {
	#rows: readonly string[];
	constructor(rows: readonly string[]) {
		super();
		this.#rows = rows;
	}
	setRows(rows: readonly string[]): void {
		this.#rows = rows;
		this.invalidate();
	}
	override render(): readonly string[] {
		return this.#rows;
	}
}

interface Harness {
	tui: TUI;
	streaming: Streaming;
	settle: () => Promise<void>;
}

function mount(active: Theme, blocks = 10): Harness {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 4000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.setViewportMode("fullscreen");
	tui.setViewportChrome({
		padX: 2,
		padTop: 0,
		padBottom: 1,
		fill: (line, width) => active.surfaceBg(line, width),
		overlayFill: (line, width) => active.overlayBg(line, width),
	});
	const transcript = new TranscriptContainer();
	tui.addChild(transcript);
	tui.addChild(new Container());
	tui.start();
	for (let i = 0; i < blocks; i++) transcript.addChild(new UserMessageComponent(`message ${i}`));
	const streaming = new Streaming(["  streaming line 0"]);
	transcript.addChild(streaming);
	return { tui, streaming, settle: () => scheduler.drain(term) };
}

describe("fullscreen scroll intent", () => {
	let active: Theme;

	beforeEach(async () => {
		await resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "tui.viewport": "fullscreen" } as never });
		active = (await getThemeByName("dark"))!;
		setThemeInstance(active);
	});

	it("does not start following the tail because the transcript grew before the frame", async () => {
		const { tui, streaming, settle } = mount(active);
		try {
			tui.requestRender();
			await settle();

			// The reader leaves the tail, but stops within one notch of it: close
			// enough that the next nudge would overshoot the bound this frame has.
			tui.scrollTo(tui.maxScrollTop - 2);
			await settle();
			expect(tui.isStickyBottom).toBeFalse();
			const parked = tui.scrollTop;

			// A streaming card grows by twenty rows with no render in between, so
			// `maxScrollTop` still describes the frame on screen.
			streaming.setRows(Array.from({ length: 20 }, (_v, i) => `  streaming line ${i}`));

			// One notch down. Against the stale bound this overshoots and lands on
			// "the bottom", which used to latch follow mode and make the next frame
			// yank the reader to a tail twenty rows further on. Against the real
			// transcript it is nowhere near the bottom.
			tui.scrollBy(3);
			await settle();

			expect(tui.scrollTop).toBe(parked + 3);
			expect(tui.isStickyBottom).toBeFalse();
		} finally {
			tui.stop();
		}
	});

	it("keeps following the tail across the engine's own re-pin", async () => {
		const { tui, streaming, settle } = mount(active);
		try {
			tui.requestRender();
			await settle();
			expect(tui.isStickyBottom).toBeTrue();

			// Streaming growth moves the offset every frame. That movement is the
			// engine's, and must not read back as the reader scrolling away.
			for (let i = 2; i < 8; i++) {
				streaming.setRows(Array.from({ length: i * 3 }, (_v, r) => `  streaming line ${r}`));
				tui.requestRender();
				await settle();
				expect(tui.isStickyBottom).toBeTrue();
				expect(tui.scrollTop).toBe(tui.maxScrollTop);
			}
		} finally {
			tui.stop();
		}
	});

	it("treats a transcript that barely overflows as always following", async () => {
		// One row of overflow has no meaningful "scrolled away" state: deriving
		// intent from it flickers follow mode between frames.
		const { tui, settle } = mount(active, 3);
		try {
			tui.requestRender();
			await settle();
			if (tui.maxScrollTop > 1) return;
			tui.scrollTo(0);
			await settle();
			expect(tui.isStickyBottom).toBeTrue();
		} finally {
			tui.stop();
		}
	});

	it("still leaves the tail when the reader scrolls up, and returns when they scroll back", async () => {
		const { tui, settle } = mount(active);
		try {
			tui.requestRender();
			await settle();
			expect(tui.isStickyBottom).toBeTrue();

			tui.scrollBy(-3);
			await settle();
			expect(tui.isStickyBottom).toBeFalse();

			tui.scrollBy(3);
			await settle();
			expect(tui.scrollTop).toBe(tui.maxScrollTop);
			expect(tui.isStickyBottom).toBeTrue();
		} finally {
			tui.stop();
		}
	});
});
