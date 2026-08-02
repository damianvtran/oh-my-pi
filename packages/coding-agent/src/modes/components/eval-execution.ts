/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import { Container, type HitZoneSink, type Loader, Text, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { highlightCode, theme } from "../../modes/theme/theme";
import type { TruncationMeta } from "../../tools/output-meta";
import { BlockCard, CollapsibleBlockHeader, HeaderRowPainter } from "./collapsible-block";
import {
	buildExecutionFrame,
	buildStatusFooter,
	createCollapsedPreview,
	type ExecutionColorKey,
	type ExecutionStatus,
	executionContentPaddingX,
	resolveExecutionStatus,
} from "./execution-shared";

const PREVIEW_LINES = 20;
const MAX_DISPLAY_LINE_CHARS = 4000;

// Stable per-instance counter so a block's hit zone keeps its identity while
// the transcript above it changes.
let evalExecutionInstanceSeq = 0;

export type EvalExecutionLanguage = "python" | "js";

export class EvalExecutionComponent extends Container {
	#outputLines: string[] = [];
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	#contentContainer: Container;
	#headerText: Text;
	#headerRow = 0;
	/** Rows the last render produced, which the card's click target spans. */
	#cardRows = 0;
	// The engine repaints after a consumed click, so the toggle only has to
	// rebuild this block's display.
	readonly #header = new CollapsibleBlockHeader(`eval:${++evalExecutionInstanceSeq}`, () =>
		this.setExpanded(!this.#expanded),
	);
	readonly #headerPainter = new HeaderRowPainter();
	readonly #card = new BlockCard();

	#highlightLang(): "python" | "javascript" {
		return this.language === "js" ? "javascript" : "python";
	}

	#formatHeader(colorKey: ExecutionColorKey): Text {
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), executionContentPaddingX(), 0);
	}

	constructor(
		private readonly code: string,
		ui: TUI,
		private readonly excludeFromContext = false,
		private readonly language: EvalExecutionLanguage = "python",
	) {
		super();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		this.#headerText = this.#formatHeader(colorKey);
		this.#contentContainer.addChild(this.#headerText);
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the cell completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#card.invalidate();
		this.#updateDisplay();
	}

	override render(width: number): readonly string[] {
		const innerWidth = this.#card.contentWidth(width);
		const lines = super.render(innerWidth);
		// The header is the code, which sits immediately below the frame's top
		// rule (nothing at all in fullscreen, where the card's own top pad takes
		// its place). Both are children rendered at this same width, so their
		// memoized line counts give the header's row without re-rendering.
		this.#headerRow = this.#card.topRows + (this.children[0]?.render(innerWidth).length ?? 0);
		const rows = this.#card.paint(lines, width, this.#header.hovered);
		this.#cardRows = rows.length;
		return this.#headerPainter.paint(rows, this.#headerRow, this.#header, this.#expanded, this.#card.active);
	}

	/**
	 * One zone over the whole card, in both states. Anything smaller is fussy
	 * to hit: the fill is what the pointer sees, so the fill is the target. A
	 * press that moves never reaches `onZoneClick` (the engine turns it into a
	 * selection), so the output stays drag-selectable underneath.
	 */
	override publishHitZones(sink: HitZoneSink): void {
		// Children publish rows local to the container; the card's top pad sits
		// above all of them.
		sink.withOffset(this.#card.topRows, () => super.publishHitZones(sink));
		this.#header.publish(sink, 0, this.#cardRows);
	}

	appendOutput(chunk: string): void {
		// Chunk is pre-sanitized by OutputSink.push() — no need to sanitize again.
		const newLines = chunk.split("\n").map(line => this.#clampDisplayLine(line));
		if (this.#outputLines.length > 0 && newLines.length > 0) {
			this.#outputLines[this.#outputLines.length - 1] = this.#clampDisplayLine(
				`${this.#outputLines[this.#outputLines.length - 1]}${newLines[0]}`,
			);
			this.#outputLines.push(...newLines.slice(1));
		} else {
			this.#outputLines.push(...newLines);
		}

		this.#updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta },
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#truncation = options?.truncation;
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}

		this.#loader.stop();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;
		const paddingX = executionContentPaddingX();
		this.#loader.setPadding(paddingX, 0);
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		// Only the collapsed preview hides lines; when expanded the footer must
		// not keep advertising hidden lines / ctrl+o.
		const hiddenLineCount = this.#expanded ? 0 : availableLines.length - previewLogicalLines.length;
		this.#header.noteOverflow(hiddenLineCount > 0);

		this.#contentContainer.clear();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		this.#headerText = this.#formatHeader(colorKey);
		this.#contentContainer.addChild(this.#headerText);

		if (availableLines.length > 0) {
			if (this.#expanded) {
				const displayText = availableLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, paddingX, 0));
			} else {
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, PREVIEW_LINES, paddingX));
			}
		}

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
				paddingX,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#clampDisplayLine(line: string): string {
		if (line.length <= MAX_DISPLAY_LINE_CHARS) {
			return line;
		}
		const omitted = line.length - MAX_DISPLAY_LINE_CHARS;
		return `${line.slice(0, MAX_DISPLAY_LINE_CHARS)}… [${omitted} chars omitted]`;
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputLines = clean ? clean.split("\n").map(line => this.#clampDisplayLine(line)) : [];
	}

	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	getCode(): string {
		return this.code;
	}
}
