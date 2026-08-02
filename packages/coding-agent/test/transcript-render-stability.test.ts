/**
 * Settled transcript blocks must be free to re-render.
 *
 * The fullscreen viewport composes every root child on every frame, and every
 * memo below that point — `BlockCard`'s `Box`, the header painter, the parent
 * `Container` — keys on array identity. A block that hands back a freshly
 * allocated array for unchanged content therefore defeats the whole chain and
 * makes each frame cost O(transcript). A settled collapsed tool card did
 * exactly that: it rebuilt its one-line summary string, in a new array, per
 * frame. At ~1500 finished calls that was ~12 ms of the frame budget, which
 * the adaptive render backpressure then doubled — visible as coarse scrolling.
 *
 * The contract asserted here is reference stability, because that is the thing
 * every consumer actually depends on.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 100;

function settledTool(): ToolExecutionComponent {
	const tui = new TUI(new VirtualTerminal(WIDTH, 20));
	const component = new ToolExecutionComponent("bash", { command: "echo hello" }, {}, undefined, tui);
	component.updateResult(
		{ content: [{ type: "text", text: "line one\nline two\nline three" }], isError: false },
		false,
	);
	return component;
}

describe("transcript render stability", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "tui.viewport": "fullscreen" } } as never);
		await initTheme();
	});

	it("returns the identical rows for a settled collapsed tool card", () => {
		const component = settledTool();
		const first = component.render(WIDTH);
		expect(first.length).toBe(3); // card padding, summary row, card padding
		expect(component.render(WIDTH)).toBe(first);
		expect(component.render(WIDTH)).toBe(first);
	});

	it("re-derives the rows when the width changes", () => {
		const component = settledTool();
		const wide = component.render(WIDTH);
		const narrow = component.render(WIDTH - 20);
		expect(narrow).not.toBe(wide);
		expect(component.render(WIDTH - 20)).toBe(narrow);
	});

	it("re-derives the rows when the card is expanded", () => {
		const component = settledTool();
		const collapsed = component.render(WIDTH);
		component.setExpanded(true);
		const expanded = component.render(WIDTH);
		expect(expanded).not.toBe(collapsed);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
	});

	it("re-derives the rows when the result changes", () => {
		const component = settledTool();
		const before = component.render(WIDTH);
		component.updateResult(
			{ content: [{ type: "text", text: "different\noutput\nentirely" }], isError: true },
			false,
		);
		expect(component.render(WIDTH)).not.toBe(before);
	});
});
