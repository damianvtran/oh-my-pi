import { type Component, Container, type HitZoneSink, Markdown } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { paintFirstColumn } from "../../tools/render-utils";
import { imageReferenceHyperlink, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";
import { BlockCard, BlockCopyTarget } from "./collapsible-block";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers.
//
// The zone must be *closed* within the same render. `133;B` sets a sticky
// cursor semantic of `.input` in Ghostty (and Ghostty-derived terminals such
// as cmux) that only a command-start marker clears; leaving it latched makes
// `cursorIsAtPrompt()` permanently true and tags every subsequently painted
// cell as `.input`. Combined with `cursor-click-to-move = true` (Ghostty's
// default) that turns every left-click inside the pane into a burst of
// synthesized arrow keys on omp's pty, slamming the editor caret to column 0
// (#8030, #6115).
//
// `133;C` is therefore emitted immediately followed by `133;D;0` at the end of
// the bubble. That clears the input state without reintroducing the grouping
// problem the marker was originally omitted to avoid: the command zone opens
// and finishes inside this component, so later assistant/tool output can never
// be grouped under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_COMMAND_START = "\x1b]133;C\x07";
const OSC133_COMMAND_DONE = "\x1b]133;D;0\x07";
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_COMMAND_START + OSC133_COMMAND_DONE;

/**
 * Draw the accent rail down a user card's first padding column.
 *
 * A user turn is marked by a one-column left bar rather than by a different
 * fill, which is what opencode does (`routes/session/index.tsx:1386`) and the
 * only rule it keeps anywhere in the transcript. The rail goes inside the
 * card's own padding, not outside it: outside, this block's text would sit one
 * column right of every tool card and the transcript would lose its single
 * left edge. `advisor.rail` is the glyph omp already uses for a left rail on a
 * transcript block, so a theme that overrides it gets both.
 */
function drawAccentRail(rows: readonly string[]): string[] {
	const rail = theme.fg("accent", theme.symbol("advisor.rail"));
	const painted = new Array<string>(rows.length);
	for (let i = 0; i < rows.length; i++) painted[i] = paintFirstColumn(rows[i]!, rail);
	return painted;
}

/**
 * Component that renders a user message.
 *
 * In the fullscreen viewport the turn sits on the same filled card as every
 * other transcript block, on `panelBg` rather than the theme's `userMessageBg`.
 * `userMessageBg` is the role that names this content, but it is not a surface:
 * measured across the 99 installed themes it lands anywhere from 0.55 luma
 * below the canvas (`porcelain`, a saturated blue slab) to 0.16 above it, and
 * on seven themes (`obsidian`, `titanium`, both `poimandres`, `dark-gruvbox`,
 * `light-tokyo-night`) it is byte-identical to the canvas, which would leave
 * the card with no boundary at all. `panelBg` is a derived ladder rung and is
 * a fixed step from the canvas on every theme. opencode paints its own user
 * block on `backgroundPanel` too (`routes/session/index.tsx:1402`), the same
 * fill as a tool card; what sets it apart there is a left accent bar, not a
 * different tint.
 *
 * The card is a surface, not a control: no hit zone, no hover fill, no expand
 * hint. Nothing about a user turn is hidden, so there is nothing to point at.
 */
export class UserMessageComponent extends Container {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	readonly #card = new BlockCard();
	// Markdown bakes its padding in at construction and exposes no setter, and
	// the two viewports need different padding: append keeps the bubble's own
	// one-column inset and paints its own background, fullscreen hands both to
	// the card. `/viewport` flips modes under a live transcript, so both forms
	// have to be reachable from one component. The one the current viewport
	// never asks for is never built.
	#carded: Markdown | undefined;
	readonly #text: string;
	readonly #color: (value: string) => string;
	/**
	 * Copy target over the whole card. A user message has nothing to expand, so
	 * this is the only zone it publishes and the only reason it publishes one.
	 * Keyed off instance identity, never transcript position, so the key stays
	 * stable as blocks above it come and go.
	 */
	static #instances = 0;
	readonly #copyTarget = new BlockCopyTarget(`user:${++UserMessageComponent.#instances}`, () => this.#text);
	/** Rows the last render produced, which the copy zone spans. */
	#renderedRows = 0;

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		// Paint the magic keywords ("ultrathink"/"orchestrate"/"workflowz") inside the rendered
		// bubble too — matching the live editor glow. The Markdown component routes code spans and
		// fenced blocks through its own code styling (never `color`), so those are already excluded;
		// `highlightMagicKeywords` additionally restores the bubble's own foreground after each
		// painted keyword so the gradient never bleeds into the rest of the line.
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const baseText = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		const imageLabel = (value: string) => theme.fg("accent", `\x1b[1m\x1b[4m${value}\x1b[24m\x1b[22m`);
		const color = (value: string) =>
			renderPlaceholders(value, {
				renderText: baseText,
				renderReference: (label, kind, index) =>
					kind === "image"
						? imageReferenceHyperlink(label, index, imageLinks, imageLabel)
						: theme.fg("accent", `\x1b[1m${label}\x1b[22m`),
			});
		this.#text = text;
		this.#color = color;
		const md = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor,
			color,
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	/**
	 * The message body alone, at the width the caller has already reserved for
	 * it. {@link CollapsedSyntheticMessageComponent} draws its own card around
	 * its summary row and this body, so it needs the rows uncarded.
	 */
	renderBody(width: number): readonly string[] {
		if (!this.#card.active) return super.render(width);
		if (!this.#carded) {
			// No `bgColor`: inside a card the Box owns the surface, and a second
			// background painted per row would tint the text spans differently
			// from the padding around them.
			this.#carded = new Markdown(this.#text, 0, 0, getMarkdownTheme(), { color: this.#color });
			this.#carded.setIgnoreTight(true);
		}
		return this.#carded.render(width);
	}

	override invalidate(): void {
		super.invalidate();
		this.#carded?.invalidate();
		this.#card.invalidate();
	}

	override render(width: number): readonly string[] {
		const lines = this.#card.active
			? this.#card.paint(this.renderBody(this.#card.contentWidth(width)), width, false)
			: super.render(width);
		// The copy zone spans whatever this render produced, so it is recorded
		// here rather than derived later: the memoized return below skips the
		// paint entirely and would otherwise leave the zone on a stale height.
		this.#renderedRows = lines.length;
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const wrapped = this.#card.active ? drawAccentRail(lines) : lines.slice();
		// Append mode only. There the transcript IS the terminal's scrollback, so
		// a prompt zone is real and buys jump-to-prompt. In the fullscreen
		// viewport it is a lie told once per visible card per frame: the rows are
		// a repainted window over content the terminal never receives, nothing is
		// navigable, and hosts that render prompt zones paint a band across the
		// card's first row for a prompt that does not exist.
		if (!this.#card.active) {
			wrapped[0] = OSC133_ZONE_START + wrapped[0];
			wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_CLOSE;
		}
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}

	override publishHitZones(sink: HitZoneSink): void {
		super.publishHitZones(sink);
		this.#copyTarget.publish(sink, 0, this.#renderedRows);
	}
}

/**
 * Collapsed placeholder for a synthetic (agent-attributed) user input in the
 * file/remote-backed transcript viewer — chiefly the advisor's `Session update`
 * replay dumps, which can each be hundreds of KiB of Markdown and, on cold open,
 * blocked the TUI for tens of seconds while every historical body was laid out
 * before the viewport clip (issue #6308).
 *
 * Collapsed by default: renders one dim summary row (label · size · line count ·
 * expand hint) and builds NO Markdown. The heavy {@link UserMessageComponent} is
 * constructed lazily only when expanded via `ctrl+o`, so blocks above the
 * viewport never pay layout cost until the reader asks to see them. The raw
 * observability data stays intact in `__advisor.jsonl`.
 */
export class CollapsedSyntheticMessageComponent implements Component {
	#expanded = false;
	#cache?: { width: number; carded: boolean; lines: readonly string[] };
	#body?: UserMessageComponent;
	readonly #summary: string;
	readonly #card = new BlockCard();

	constructor(
		private readonly text: string,
		private readonly imageLinks?: readonly (string | undefined)[],
	) {
		this.#summary = summarizeSyntheticInput(text);
	}

	/** ctrl+o toggle: reveal/hide the full Markdown body. */
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#body?.invalidate?.();
		this.#card.invalidate();
	}

	dispose(): void {
		this.#body?.dispose?.();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		// The viewport mode flips under a live transcript, and it changes the
		// rows without changing the width, so it belongs in the cache key.
		const carded = this.#card.active;
		if (this.#cache?.width === width && this.#cache.carded === carded) return this.#cache.lines;
		const inner = carded ? this.#card.contentWidth(width) : width;
		const body = this.#expanded ? this.#renderExpanded(inner, carded) : [this.#summaryRow(inner, carded)];
		// Collapsing is a keyboard affordance here (ctrl+o), advertised by the
		// summary row, so the card takes no hover fill and publishes no zone.
		// The rail marks the block's role, not its author: a synthetic input is
		// injected as a user turn, which is why it renders as one at all. The dim
		// body is what says it was not typed.
		const lines = carded ? drawAccentRail(this.#card.paint(body, width, false)) : body;
		this.#cache = { width, carded, lines };
		return lines;
	}

	#renderExpanded(width: number, carded: boolean): readonly string[] {
		if (!this.#body) this.#body = new UserMessageComponent(this.text, true, this.imageLinks);
		// Append mode keeps the body's own OSC 133 zone markers. Inside the card
		// the summary row is already the block's first row, so the body
		// contributes its rows and nothing else.
		return [this.#summaryRow(width, carded), ...(carded ? this.#body.renderBody(width) : this.#body.render(width))];
	}

	/**
	 * `carded` drops the one-column gutter the append bubble carries: inside the
	 * card that column comes from the card, and keeping both would step the
	 * summary row one place right of the body it summarizes.
	 */
	#summaryRow(width: number, carded: boolean): string {
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		const row = theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)));
		return carded ? row : ` ${row}`;
	}
}

/** Truncate a plain summary label to `maxWidth` display columns, appending `…`. */
function truncateSummary(text: string, maxWidth: number): string {
	if (Bun.stringWidth(text, { countAnsiEscapeCodes: false }) <= maxWidth) return text;
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = Bun.stringWidth(ch, { countAnsiEscapeCodes: false });
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/**
 * One-line summary for a collapsed synthetic input: `<label> · <size> · <n>
 * lines`. The label is the first Markdown heading's text (e.g. `Session
 * update`), falling back to `Synthetic input` when the body opens with none.
 */
function summarizeSyntheticInput(text: string): string {
	const size = formatBytes(Buffer.byteLength(text, "utf-8"));
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const dot = theme.sep.dot.trim();
	return `${syntheticInputLabel(text)} ${dot} ${size} ${dot} ${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

/** First Markdown heading text in `text`, else `Synthetic input`. */
function syntheticInputLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading ? heading[1]!.trim() || "Synthetic input" : "Synthetic input";
	}
	return "Synthetic input";
}
