import type { TextContent } from "@oh-my-pi/pi-ai";
import { Container, type HitZoneSink, Markdown, Text } from "@oh-my-pi/pi-tui";
import type { CollabPromptDetails } from "../../collab/protocol";
import type { CustomMessage } from "../../session/messages";
import { getMarkdownTheme, theme } from "../theme/theme";
import { BlockCard, BlockCopyTarget } from "./collapsible-block";

/**
 * Renders a collab guest prompt on every participant's transcript: a
 * user-message-styled bubble prefixed with the author's name.
 *
 * In the fullscreen viewport the card owns the block's surface, so the body is
 * painted unstyled and inset by the card — the same treatment
 * `UserMessageComponent` gets. A block that paints its own
 * `userMessageBg` there double-paints: `Markdown` fills each row out to the
 * full content width, which overruns the card's inset and puts a band of a
 * second colour where every neighbouring block shows the shared panel fill.
 */
let collabPromptInstanceSeq = 0;

export class CollabPromptMessageComponent extends Container {
	readonly #card = new BlockCard();
	readonly #copyTarget = new BlockCopyTarget(`collab-prompt:${++collabPromptInstanceSeq}`, () => this.#copySource());
	readonly #authorName: string;
	readonly #author: string;
	readonly #text: string;
	// `Text` and `Markdown` bake their padding in at construction and expose no
	// setter, and the two viewports need different padding: append keeps the
	// bubble's own inset and paints its own background, fullscreen hands both
	// to the card. `/viewport` flips modes under a live transcript, so both
	// forms have to be reachable from one component; the one the current
	// viewport never asks for is never built.
	#carded: Container | undefined;
	#renderedRows = 0;

	constructor(message: CustomMessage<CollabPromptDetails>) {
		super();
		const from = message.details?.from?.trim() || "guest";
		this.#authorName = from;
		this.#author = theme.fg("accent", `\x1b[1m«${from}»\x1b[22m ›`);
		const authorText = new Text(this.#author, 1, 0);
		authorText.setIgnoreTight(true);
		this.addChild(authorText);
		this.#text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");
		const md = new Markdown(this.#text, 1, 1, getMarkdownTheme(), {
			bgColor: (value: string) => theme.bg("userMessageBg", value),
			color: (value: string) => theme.fg("userMessageText", value),
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	/** Attribution row plus body, uncarded, at the width the card leaves. */
	#renderBody(width: number): readonly string[] {
		if (!this.#carded) {
			// No `bgColor` and no padding: inside a card the Box owns both, and a
			// second background painted per row would tint the text spans
			// differently from the padding around them.
			const carded = new Container();
			carded.addChild(new Text(this.#author, 0, 0));
			carded.addChild(
				new Markdown(this.#text, 0, 0, getMarkdownTheme(), {
					color: (value: string) => theme.fg("userMessageText", value),
				}),
			);
			carded.setIgnoreTight(true);
			this.#carded = carded;
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
			? this.#card.paint(this.#renderBody(this.#card.contentWidth(width)), width, false)
			: super.render(width);
		this.#renderedRows = lines.length;
		return lines;
	}

	override publishHitZones(sink: HitZoneSink): void {
		this.#card.publishSelectionInset(sink, this.#renderedRows);
		this.#card.publishContentGeometry(sink, () => super.publishHitZones(sink));
		this.#copyTarget.publish(sink, 0, this.#renderedRows);
	}

	/** Stable attribution plus the guest's original, unwrapped prompt text. */
	#copySource(): string {
		return `From ${this.#authorName}:\n\n${this.#text}`;
	}
}
