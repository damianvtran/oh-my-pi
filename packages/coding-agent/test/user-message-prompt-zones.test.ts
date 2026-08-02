/**
 * OSC 133 prompt zones belong to append mode only.
 *
 * There the transcript IS the terminal's scrollback: a prompt zone is real, and
 * it is what gives the host jump-to-prompt over a finished session. In the
 * fullscreen viewport the same markers are a lie repeated once per visible card
 * per frame — the rows are a repainted window over content the terminal never
 * receives, so nothing is navigable — and a host that renders prompt zones
 * paints a band across the first row of every user card for a prompt that does
 * not exist. omp's own bytes are uniform across the card, which is why the band
 * only ever appeared in a real terminal and never in a replayed capture.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const OSC133 = /\x1b\]133;/;

async function initViewport(viewport: "append" | "fullscreen"): Promise<void> {
	await resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "tui.viewport": viewport } as never });
	setThemeInstance((await getThemeByName("dark-tokyo-night"))!);
}

describe("user message prompt zones", () => {
	beforeEach(async () => {
		await resetSettingsForTest();
	});

	it("emits no prompt zone in the fullscreen viewport", async () => {
		await initViewport("fullscreen");
		const rows = new UserMessageComponent("hello there").render(70);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some(row => OSC133.test(row))).toBeFalse();
	});

	it("still brackets the turn with a prompt zone in append mode", async () => {
		await initViewport("append");
		const rows = new UserMessageComponent("hello there").render(70);
		expect(rows[0]).toContain("\x1b]133;A\x07");
		expect(rows[rows.length - 1]).toContain("\x1b]133;B\x07");
	});

	it("paints every row of a fullscreen card on the same surface", async () => {
		await initViewport("fullscreen");
		const rows = new UserMessageComponent("hello there").render(70);
		// The band a prompt-zone-aware host drew was never omp's: the card itself
		// is one surface top to bottom, so any difference on screen came from the
		// marker, not from the paint.
		const surfaces = rows.map(row => /\x1b\[(48;2;[0-9;]+)m/.exec(row)?.[1]);
		expect(new Set(surfaces).size).toBe(1);
		expect(surfaces[0]).toBeDefined();
	});
});
