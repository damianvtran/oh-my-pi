import type { TextContent } from "@oh-my-pi/pi-ai";
import { Container, Markdown, Text } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { CustomMessage } from "../../session/messages";
import type { WakePromptDetails } from "../../wake/store";
import { getMarkdownTheme, theme } from "../theme/theme";

/**
 * Opening line of `formatWakeDeliveryText`. Matched on shape rather than on the
 * exact fact list so a change to the envelope's contents does not silently stop
 * the strip below from firing.
 */
const WAKE_ENVELOPE_HEADER = /^⏰ Scheduled wake \S+ \(/;

/**
 * The delivered text with the envelope line dropped.
 *
 * The badge already states the id, the progress and the cadence, so repeating
 * the envelope would spend two lines of every single delivery restating the
 * header above it. The strip is gated on the full shape — envelope line, blank
 * line, non-empty remainder — because this text is the only copy of the agent's
 * own prompt: a near-miss has to render verbatim rather than be eaten.
 */
export function stripWakeEnvelope(text: string): string {
	const headerEnd = text.indexOf("\n");
	if (headerEnd === -1) return text;
	if (!WAKE_ENVELOPE_HEADER.test(text.slice(0, headerEnd))) return text;
	const afterHeader = text.slice(headerEnd + 1);
	if (!afterHeader.startsWith("\n")) return text;
	const body = afterHeader.slice(1);
	return body.trim() ? body : text;
}

/**
 * Dim half of the badge: which delivery this is and what follows it. Mirrors
 * the fact order of `formatWakeDeliveryText` so the card and the text the model
 * received cannot disagree. Older transcripts predate `details`, hence the bare
 * "scheduled" fallback.
 */
export function formatWakeBadgeFacts(details: WakePromptDetails | undefined): string {
	if (!details) return "scheduled";
	if (details.everyMs === undefined) return "one-shot";
	const progress =
		details.plannedTotal === undefined
			? `delivery ${details.occurrence}`
			: `${details.occurrence}/${details.plannedTotal}`;
	return `${progress} · ${details.final ? "final" : `every ${formatDuration(details.everyMs)}`}`;
}

/**
 * Renders a fired scheduled wakeup on the transcript: a badge marking the
 * prompt as a timer arrival, over the agent's own message in user-message
 * colours — the wake is injected with `attribution: "user"`, so it has to read
 * as a prompt in the conversation, not as tool output.
 */
export class WakeMessageComponent extends Container {
	constructor(message: CustomMessage<WakePromptDetails>) {
		super();
		const details = message.details;
		const id = details?.id?.trim();
		const label = theme.fg("accent", theme.bold(`⏰ wake${id ? ` ${id}` : ""}`));
		const badgeText = new Text(`${label} ${theme.fg("dim", formatWakeBadgeFacts(details))}`, 1, 0);
		badgeText.setIgnoreTight(true);
		this.addChild(badgeText);
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");
		const md = new Markdown(stripWakeEnvelope(text), 1, 1, getMarkdownTheme(), {
			bgColor: (value: string) => theme.bg("userMessageBg", value),
			color: (value: string) => theme.fg("userMessageText", value),
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}
}
