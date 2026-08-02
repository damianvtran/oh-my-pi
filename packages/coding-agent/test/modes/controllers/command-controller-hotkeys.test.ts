import { afterEach, describe, expect, it } from "bun:test";
import { setKeyHintPlatform } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-coding-agent/modes/utils/hotkeys-markdown";

describe("buildHotkeysMarkdown", () => {
	afterEach(() => setKeyHintPlatform(undefined));

	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "Alt+Shift+L",
			"app.clipboard.copyPrompt": "Ctrl+Shift+P",
			"app.plan.toggle": "Alt+Shift+P",
			"app.tools.expand": "Ctrl+O",
			"app.tools.toggleVisibility": "Ctrl+Shift+O",
			"app.display.reset": "Alt+L",
			"app.interrupt": "Esc",
			"app.clear": "Ctrl+C",
			"app.exit": "Ctrl+D",
			"app.suspend": "Ctrl+Z",
			"app.thinking.cycle": "Shift+Tab",
			"app.model.cycleForward": "Ctrl+P",
			"app.model.cycleBackward": "Shift+Ctrl+P",
			"app.model.selectTemporary": "Ctrl+Shift+L",
			"app.model.select": "Alt+M",
			"app.history.search": "Ctrl+R",
			"app.thinking.toggle": "Ctrl+T",
			"app.editor.external": "Ctrl+G",
			"app.retry": "Alt+R",
			"app.clipboard.pasteImage": "Ctrl+V",
			"app.stt.toggle": "Alt+H",
			"app.live.toggle": "Ctrl+L",
			"tui.editor.selectAll": "Alt+A",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `Ctrl+Shift+P` | Copy whole prompt |");
		expect(markdown).toContain("| `Ctrl+Shift+L` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
		expect(markdown).toContain("| `Alt+L` | Reset terminal display |");
		expect(markdown).toContain("| `Ctrl+L` | Start/stop live voice mode (/live) |");
		expect(markdown).toContain("| `Alt+R` | Retry last failed assistant turn |");
		expect(markdown).toContain("| `Alt+A` | Select all — then Backspace or type to replace the draft |");
		expect(markdown).toContain("**Mouse / Fullscreen viewport**");
		expect(markdown).toContain("| `Wheel` / trackpad | Scroll the transcript |");
		expect(markdown).toContain("| `Alt+click` a message or card | Copy that block's complete source");
		expect(markdown).toContain("| Double-click prose | Copy the whole message");
		expect(markdown).toContain(
			"| `/viewport append` | Restore terminal scrollback, native selection, copy, and find |",
		);
		expect(markdown).toContain("| `Alt+Shift+P` | Toggle plan mode |");
		expect(markdown).toContain("| `Ctrl+Shift+O` | Toggle tool activity visibility |");
		expect(markdown).toContain("| `#<number>` | GitHub issue/PR reference");
		expect(markdown).toContain("| `#` / `#<text>` | Prompt actions");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Alt+M";
					}
					if (action === "app.display.reset") {
						return "Alt+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Disabled` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
	});

	it("renders macOS static navigation rows on darwin", () => {
		setKeyHintPlatform("darwin");
		const markdown = buildHotkeysMarkdown({ keybindings: { getDisplayString: () => "Disabled" } });

		expect(markdown).toContain("| `Option+Left/Right` | Move by word |");
		// No `Ctrl+A` on this row: this fork moved that chord off
		// `tui.editor.cursorLineStart` onto `tui.editor.selectAll`, so `Home` is the
		// only line-start key. Upstream still ships ctrl+a on cursorLineStart, which
		// is why the inherited assertion named it.
		expect(markdown).toContain("| `Home` / `Cmd+Left` | Start of line |");
		expect(markdown).toContain("| `Ctrl+W` / `Option+Backspace` | Delete word backwards |");
		expect(markdown).toContain("| `Shift+Enter` / `Option+Enter` | New line |");
	});

	it("drops Option/Cmd static navigation labels off darwin", () => {
		setKeyHintPlatform("linux");
		const markdown = buildHotkeysMarkdown({ keybindings: { getDisplayString: () => "Disabled" } });

		expect(markdown).toContain("| `Alt+Left/Right` | Move by word |");
		expect(markdown).toContain("| `Home` | Start of line |");
		expect(markdown).toContain("| `Ctrl+W` / `Alt+Backspace` | Delete word backwards |");
		expect(markdown).not.toContain("Option+");
		expect(markdown).not.toContain("Cmd+");
	});
});
