/**
 * Composer selection used to borrow `elementBg` — the raised rung of the
 * surface ladder — as its wash, but the composer already paints the panel rung,
 * so the two sat one ladder step apart: 1.126:1 on `dark`, 1.048:1 on
 * `alabaster` and `birch`. Text selection is the one selection signal with no
 * accent foreground and no prefix glyph to reinforce it, so the background is
 * the whole signal, and that is invisible.
 *
 * These tests pin the observable contract of the replacement (`theme.selectionBg`
 * plus `EditorTheme.selectionWash`): a distinct surface, a measured contrast
 * floor against the panel it is read on, and a wash the Editor actually emits —
 * including in append mode, where the list's `selectedRow` deliberately paints
 * nothing.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { defaultThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/defaults";
import {
	getEditorTheme,
	getThemeByName,
	initTheme,
	setTheme,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Editor } from "@oh-my-pi/pi-tui";
import { relativeLuminance } from "@oh-my-pi/pi-utils";

/**
 * Contrast floor the derivation promises against the panel rung.
 *
 * 1.5:1 is where editors that already solved this land — VS Code ships
 * `#ADD6FF` on white (1.44:1) and `#264F78` on `#1E1E1E` (2.06:1) — and it is
 * what `SELECTION_MIN_CONTRAST` targets. Asserted just under the target rather
 * than at it, because the derivation takes the *smallest* step that reads and
 * so lands a hair above on themes it has to push, and well above on themes
 * whose accent already separates the two surfaces.
 */
const CONTRAST_FLOOR = 1.49;

/** Recover the hex behind a `\x1b[48;2;r;g;bm` background open. */
function bgOpenToHex(open: string): string {
	const m = /48;2;(\d+);(\d+);(\d+)m/.exec(open);
	if (!m) throw new Error(`not a truecolor background open: ${JSON.stringify(open)}`);
	const channel = (raw: string) => Number(raw).toString(16).padStart(2, "0");
	return `#${channel(m[1]!)}${channel(m[2]!)}${channel(m[3]!)}`;
}

/** WCAG 2.x contrast ratio between two hex colors. */
function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	if (la === undefined || lb === undefined) throw new Error(`unparseable color pair: ${a} / ${b}`);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Contrast between a theme's composer panel and the wash painted on top of it. */
function selectionContrast(t: { panelBgAnsi: string; selectionBgAnsi: string }): number {
	return contrastRatio(bgOpenToHex(t.panelBgAnsi), bgOpenToHex(t.selectionBgAnsi));
}

/**
 * Drag across the composer's first row and return the frame plus what the drag
 * actually selected. The column is a *zone* column, which the editor offsets by
 * its own left inset, so the selected text is read back rather than assumed.
 */
function dragSelect(editor: Editor, width: number, toCol: number): { frame: string; selected: string } {
	editor.render(width);
	const raw = {
		button: 0,
		col: 0,
		row: 0,
		release: false,
		wheel: null,
		wheelX: null,
		motion: false,
		shift: false,
		alt: false,
		ctrl: false,
		leftClick: true,
	} as const;
	editor.onZoneDrag("start", { raw, localRow: 0, localCol: 0, clickCount: 1 });
	editor.onZoneDrag("move", { raw, localRow: 0, localCol: toCol, clickCount: 1 });
	return { frame: editor.render(width).join("\n"), selected: editor.getSelectedText() };
}

async function initSettings(viewport: "fullscreen" | "append"): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "tui.viewport": viewport } });
	await initTheme();
}

describe("composer selection wash", () => {
	beforeEach(async () => {
		await initSettings("fullscreen");
	});

	// dark is the default; alabaster is the light theme whose neutral accent gives
	// the derivation the least to work with, so it is the honest light-side case.
	it.each(["dark", "alabaster"])("separates the selection from both neighbouring rungs (%s)", async name => {
		const t = await getThemeByName(name);
		expect(t).toBeDefined();
		expect(t!.selectionBgAnsi).not.toBe("");
		// Not the panel it sits on, and not the raised rung it used to borrow.
		expect(t!.selectionBgAnsi).not.toBe(t!.panelBgAnsi);
		expect(t!.selectionBgAnsi).not.toBe(t!.elementBgAnsi);
	});

	it.each([
		// [theme, contrast the old elementBg wash measured against the panel]
		["dark", 1.126],
		["alabaster", 1.048],
		["birch", 1.048],
	])("clears the contrast floor against the panel (%s)", async (name, before) => {
		const t = await getThemeByName(name);
		const panel = bgOpenToHex(t!.panelBgAnsi);
		expect(contrastRatio(panel, bgOpenToHex(t!.elementBgAnsi))).toBeCloseTo(before as number, 2);
		expect(selectionContrast(t!)).toBeGreaterThan(CONTRAST_FLOOR);
	});

	it("resolves on every bundled theme without throwing", async () => {
		let checked = 0;
		for (const name of ["dark", "light", ...Object.keys(defaultThemes)]) {
			// light-prism and onyx already fail schema validation on this branch, and
			// getThemeByName reports that as undefined; not this derivation's problem.
			const t = await getThemeByName(name);
			if (!t) continue;
			expect(t.selectionBg("ab", 4)).toContain("ab");
			expect(selectionContrast(t)).toBeGreaterThan(CONTRAST_FLOOR);
			checked++;
		}
		expect(checked).toBeGreaterThan(90);
	});

	it("paints the selected span with the wash, not the raised rung", async () => {
		await setTheme("dark");
		const editor = new Editor(getEditorTheme());
		editor.setText("hello world");

		const { frame, selected } = dragSelect(editor, 40, 8);
		expect(selected).not.toBe("");
		expect(frame).toContain(`${theme.selectionBgAnsi}${selected}\x1b[49m`);
		expect(frame).not.toContain(`${theme.elementBgAnsi}${selected}`);
	});

	it("still paints the selection in append mode", async () => {
		// selectList.selectedRow gates itself on the fullscreen viewport, so before
		// selectionWash a drag in append mode washed nothing at all.
		await initSettings("append");
		await setTheme("dark");
		expect(getEditorTheme().selectList.selectedRow?.("hello")).toBe("hello");

		const editor = new Editor(getEditorTheme());
		editor.setText("hello world");
		const { frame, selected } = dragSelect(editor, 40, 8);
		expect(selected).not.toBe("");
		expect(frame).toContain(`${theme.selectionBgAnsi}${selected}\x1b[49m`);
	});
});

describe("floating overlay surface", () => {
	beforeEach(async () => {
		await initSettings("fullscreen");
	});

	it.each(["dark", "light", "alabaster", "birch"])(
		"separates a floating panel from both the transcript and its own selection (%s)",
		async name => {
			const t = (await getThemeByName(name))!;
			const overlay = bgOpenToHex(t.overlayBgAnsi);
			// A modal in fullscreen draws no rule, so the fill is the only edge it
			// has against the cards behind it.
			expect(overlay).not.toBe(bgOpenToHex(t.panelBgAnsi));
			// And `elementBg` is where a select list paints its own selected row,
			// so an overlay filled with it swallows its own selection.
			expect(overlay).not.toBe(bgOpenToHex(t.elementBgAnsi));
		},
	);

	it("keeps a select list's selected row visible against the overlay it sits on", async () => {
		await setTheme("dark");
		const selected = getEditorTheme().selectList.selectedRow?.("row");
		expect(selected).toContain(theme.elementBgAnsi);
		expect(selected).not.toContain(theme.overlayBgAnsi);
	});

	it("resolves on every bundled theme without collapsing onto a lower rung", async () => {
		let checked = 0;
		for (const name of ["dark", "light", ...Object.keys(defaultThemes)]) {
			const t = await getThemeByName(name);
			// A theme that paints no surface at all derives no ladder; it opts out
			// of the fill entirely rather than getting a guessed one.
			if (!t || t.overlayBgAnsi === "") continue;
			expect(t.overlayBg("ab", 4)).toContain("ab");
			expect(bgOpenToHex(t.overlayBgAnsi)).not.toBe(bgOpenToHex(t.elementBgAnsi));
			checked++;
		}
		expect(checked).toBeGreaterThan(90);
	});

	it("clears the wash's contrast floor against the overlay it is painted on", async () => {
		let checked = 0;
		for (const name of ["dark", "light", ...Object.keys(defaultThemes)]) {
			const t = await getThemeByName(name);
			if (!t || t.overlayBgAnsi === "") continue;
			const overlay = bgOpenToHex(t.overlayBgAnsi);
			// The floor the panel-anchored wash guarantees is measured against the
			// panel. Two rungs up it buys nothing: on 95 of the 98 bundled themes
			// that wash lands on the overlay under 1.5:1, and under 1.2:1 on 16.
			expect(contrastRatio(overlay, bgOpenToHex(t.selectionOverlayBgAnsi))).toBeGreaterThan(CONTRAST_FLOOR);
			checked++;
		}
		expect(checked).toBeGreaterThan(90);
	});

	it("hands an overlay-hosted editor the overlay wash and the composer the panel one", async () => {
		await setTheme("dark");
		const onPanel = getEditorTheme().selectionWash?.("sel");
		const onOverlay = getEditorTheme("overlay").selectionWash?.("sel");
		expect(onPanel).toContain(theme.selectionBgAnsi);
		expect(onOverlay).toContain(theme.selectionOverlayBgAnsi);
		expect(onOverlay).not.toBe(onPanel);
	});
});
