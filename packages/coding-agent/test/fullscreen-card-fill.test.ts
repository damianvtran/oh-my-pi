import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BlockCard } from "@oh-my-pi/pi-coding-agent/modes/components/collapsible-block";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderOutputBlock } from "@oh-my-pi/pi-coding-agent/tui/output-block";

/**
 * A card paints one surface, including the blank rows it adds above and below
 * its content. A block that also paints a state tint covers only the rows it
 * emits, so the card's padding keeps the panel colour while the body goes a
 * different shade and the block reads as a darker box nested inside a lighter
 * one. Settled blocks never showed it because their tint happens to sit on the
 * panel rung; streaming and in-progress ones did, on every tool.
 */

const DEFAULT = "default";

/** Every distinct background colour painted in `line`, in the order first seen. */
function backgrounds(line: string): string[] {
	const seen: string[] = [];
	let bg = DEFAULT;
	let i = 0;
	const note = () => {
		if (!seen.includes(bg)) seen.push(bg);
	};
	while (i < line.length) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			let j = i + 2;
			while (j < line.length && !/[A-Za-z]/.test(line[j]!)) j++;
			if (line[j] === "m") {
				const parts = line
					.slice(i + 2, j)
					.split(";")
					.map(p => (p === "" ? 0 : Number(p)));
				for (let k = 0; k < parts.length; k++) {
					const code = parts[k]!;
					if (code === 0 || code === 49) bg = DEFAULT;
					// 38/48/58 share the 2/5 argument shapes; consuming them is what
					// stops a foreground triple's last component reading as a colour.
					else if (code === 38 || code === 48 || code === 58) {
						const mode = parts[k + 1];
						let value = DEFAULT;
						if (mode === 5) {
							value = `idx${parts[k + 2]}`;
							k += 2;
						} else if (mode === 2) {
							value = `rgb(${parts[k + 2]},${parts[k + 3]},${parts[k + 4]})`;
							k += 4;
						}
						if (code === 48) bg = value;
					}
				}
			}
			i = j + 1;
			continue;
		}
		if (line[i] === "\x1b") {
			let j = i + 1;
			while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
			i = line[j] === "\x07" ? j + 1 : j + 2;
			continue;
		}
		note();
		i++;
	}
	return seen;
}

const STATES = ["running", "pending", "success", "error", "warning"] as const;

describe("fullscreen card fill", () => {
	let active: Theme;
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "tui.viewport": "fullscreen" } } as never);
		const dark = await getThemeByName("dark");
		expect(dark).toBeDefined();
		setThemeInstance(dark!);
		active = dark!;
	});

	for (const state of STATES) {
		it(`paints a ${state} block and its card padding with one background`, () => {
			const rows = renderOutputBlock(
				{ header: "Bash", state, sections: [{ lines: ["one", "two"] }], width: 60 },
				active,
			);
			const painted = new BlockCard().paint(rows, 60, false);
			const fills = new Set(painted.flatMap(backgrounds).filter(bg => bg !== DEFAULT));
			expect([...fills]).toHaveLength(1);
		});
	}

	it("still tints the block in append mode, where there is no card to own the surface", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "tui.viewport": "append" } } as never);
		const rows = renderOutputBlock(
			{ header: "Bash", state: "running", sections: [{ lines: ["one"] }], width: 60 },
			active,
		);
		const fills = new Set(rows.flatMap(backgrounds).filter(bg => bg !== DEFAULT));
		expect(fills.size).toBeGreaterThan(0);
	});
});
