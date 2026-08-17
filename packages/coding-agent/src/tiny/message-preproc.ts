/**
 * Converts raw user text into bounded, low-noise input for tiny models.
 *
 * Tiny models copy literal noise verbatim and lose the task when only the head
 * of a long message survives. The shared pipeline strips ANSI escapes, paired
 * XML/tool envelopes, full commit hashes, and fenced code blocks, then preserves
 * both ends with an explicit omission marker. Title generation, auto-thinking,
 * and the title benchmark MUST use this same policy.
 */

/** Maximum characters emitted by {@link preprocessTinyMessage}. */
export const MAX_TINY_MESSAGE_CHARS = 2000;

/**
 * Minimum length of code-stripped input below which we fall back to the
 * original message. Guards against messages that are (almost) entirely a code
 * block — stripping would otherwise leave the model nothing to title from.
 */
const MIN_STRIPPED_TITLE_CHARS = 12;
/** Matches a fenced code block (3+ backticks), including an unterminated trailing fence. */
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;
/** Matches SGR ANSI escape sequences (colors/styles) that leak in from pasted terminal output. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
/** Matches a paired XML/HTML-ish block, e.g. `<user>…</user>` or a tool envelope. */
const XML_BLOCK = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
/** Matches a hex run long enough to be a full commit SHA rather than an ordinary word. */
const LONG_HEX_RUN = /\b[0-9a-fA-F]{12,}\b/g;
/** Short-hash prefix length kept after truncating a long hex run. */
const SHORT_HASH_CHARS = 7;

/** Drop SGR ANSI escape sequences. */
export function stripAnsi(message: string): string {
	return message.replace(ANSI_ESCAPE, "");
}

/**
 * Remove paired XML/HTML-ish blocks (`<user>…</user>`, `<think>…</think>`,
 * tool envelopes). Self-closing and unpaired inline tags (`<Header/>`, a lone
 * `<div>`) are left in place — only fully paired blocks, whose contents would
 * otherwise dominate the title, are dropped.
 */
export function stripXmlBlocks(message: string): string {
	return message.replace(XML_BLOCK, " ");
}

/** Truncate full commit-hash-like hex runs (≥12 chars) to a short 7-char prefix. */
export function shortenHashes(message: string): string {
	return message.replace(LONG_HEX_RUN, match => match.slice(0, SHORT_HASH_CHARS));
}

/**
 * Middle-truncate cleaned text, preserving 2/3 of the available space from the
 * head and 1/3 from the tail. The omission marker counts toward the bound, and
 * the result is never longer than `limit`.
 *
 * `limit` exists for {@link formatTitleConversationContext}, which bounds each
 * sampled turn separately: applying one bound to the assembled envelope would
 * cut whichever turns happen to sit in the middle, which is exactly the
 * structure that envelope is built to convey. That caller derives its limits by
 * dividing a fixed budget, so small and zero limits are reachable and the
 * length guarantee is what makes the envelope's own bound provable.
 */
export function truncateTinyMessage(message: string, limit: number = MAX_TINY_MESSAGE_CHARS): string {
	if (message.length <= limit) return message;
	if (limit <= 0) return "";
	let omitted = message.length - limit;
	let marker = "";
	let headChars = 0;
	let tailChars = 0;
	// The omitted count changes the marker width; two passes converge because
	// only the decimal digit count can change.
	for (let pass = 0; pass < 2; pass++) {
		marker = `\n[… ${omitted} chars omitted …]\n`;
		const keptChars = Math.max(0, limit - marker.length);
		headChars = Math.ceil((keptChars * 2) / 3);
		tailChars = keptChars - headChars;
		omitted = message.length - headChars - tailChars;
	}
	marker = `\n[… ${omitted} chars omitted …]\n`;
	// No room for the marker plus anything either side of it: say less rather
	// than return a marker that is itself longer than the budget.
	if (marker.length >= limit) return message.slice(0, limit);
	// `slice(message.length - tailChars)`, not `slice(-tailChars)`: the latter is
	// `slice(-0)` === `slice(0)` when nothing is kept from the tail, which returns
	// the entire message and makes the "truncated" result longer than the input.
	return `${message.slice(0, headChars)}${marker}${message.slice(message.length - tailChars)}`;
}

/**
 * Strip fenced code blocks from a message before titling.
 *
 * Small title models latch onto literal text inside code blocks — e.g. a pasted
 * UI mockup containing "Welcome to Claude Code v2.1.158" yields that string as
 * the title instead of the surrounding intent. Removing fenced blocks leaves the
 * prose that actually describes the task. Inline code (single backticks) is kept
 * — it is short, high-signal context like `/login`.
 *
 * Falls back to the original message when stripping leaves too little to title
 * (a message that is essentially just a code block).
 */
export function stripCodeBlocks(message: string): string {
	const cleaned = message
		.replace(FENCED_CODE_BLOCK, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return cleaned.length >= MIN_STRIPPED_TITLE_CHARS ? cleaned : message;
}

/** Clean noise from message content without applying the length bound. */
export function cleanTinyMessage(message: string): string {
	return stripCodeBlocks(shortenHashes(stripXmlBlocks(stripAnsi(message))));
}

/** Apply the shared tiny-model cleanup and middle-truncation policy. */
export function preprocessTinyMessage(message: string): string {
	return truncateTinyMessage(cleanTinyMessage(message));
}

/** Envelope produced by {@link formatTitleConversationContext}. Anchored to both
 *  ends so ordinary user text merely containing a chat snippet never matches. */
const CHAT_CONTEXT_ENVELOPE = /^\s*<chat>[\s\S]*<\/chat>\s*$/;
/** Structural tags emitted by {@link formatTitleConversationContext}, including
 *  the self-closing `<elided/>` gap marker. */
const CHAT_SCAFFOLD_TAG = /<\/?(?:chat|current-title|user|assistant|think|elided)\/?>/g;

/** True when `message` is a preformatted replan context from
 *  {@link formatTitleConversationContext} — already cleaned per turn and
 *  bounded, so it must bypass {@link preprocessTinyMessage} (whose paired-tag
 *  stripping would consume the entire envelope). */
export function isPreformattedChatContext(message: string): boolean {
	return CHAT_CONTEXT_ENVELOPE.test(message);
}

/** Drop the `<chat>`/`<current-title>`/`<user>`/`<assistant>`/`<think>`/`<elided/>`
 *  scaffolding, keeping turn text. Used for token-level signal checks on
 *  preformatted contexts. */
export function stripChatScaffolding(message: string): string {
	return message.replace(CHAT_SCAFFOLD_TAG, " ");
}

/** Wrap a preprocessed user message for title generation. Preformatted replan
 *  contexts pass through untouched. */
export function formatTitleUserMessage(message: string): string {
	if (isPreformattedChatContext(message)) return message;
	return `<user>\n${preprocessTinyMessage(message)}\n</user>`;
}

/** One sampled conversation turn supplied to session theme titling. */
export interface TitleConversationTurn {
	role: "user" | "assistant";
	text?: string;
	thinking?: string;
}

/** Marks turns the sampler dropped, so the model does not read the head and the
 *  tail of a long conversation as adjacent. Self-closing: there is no content to
 *  wrap, and a paired tag would invite the model to invent some. */
const ELIDED_MARKER = "<elided/>";

/**
 * Longest session name embedded as `<current-title>`. Nothing else bounds it —
 * `SessionManager` only trims and strips control characters, and an imported or
 * model-authored title can be arbitrarily long — and the header is subtracted
 * from the budget the turns then share, so an unbounded one would push the
 * envelope past {@link MAX_TINY_MESSAGE_CHARS} and starve every turn at once.
 */
const CURRENT_TITLE_MAX_CHARS = 200;

/**
 * Share `available` characters across `bodies` by max-min fairness: every body
 * shorter than an equal share is kept whole and donates its slack to the ones
 * that are over. Returns the per-body character cap, summing to at most
 * `available` — which is what makes the envelope's length bound provable.
 *
 * The opening turn of a real session is frequently ten times the length of the
 * turns around it, which is precisely the turn the theme prompt leans on, so an
 * equal split would truncate the one turn that states the subject while short
 * assistant acknowledgements keep budget they cannot use.
 */
function allocateTurnBudgets(bodies: readonly string[], available: number): number[] {
	const caps = new Array<number>(bodies.length).fill(0);
	const order = bodies.map((body, index) => ({ index, length: body.length })).sort((a, b) => a.length - b.length);
	let remaining = available;
	let slots = bodies.length;
	for (const { index, length } of order) {
		// Shortest first, so each body either fits its equal share of what is left
		// or is capped at it; the leftover from those that fit raises the share for
		// everyone after them, and the running total can never exceed `available`.
		const cap = Math.min(length, Math.floor(remaining / slots));
		caps[index] = cap;
		remaining -= cap;
		slots--;
	}
	return caps;
}

/**
 * Format sampled conversation turns for session theme titling.
 *
 * `currentTitle` is emitted as the first child of `<chat>` rather than as a
 * sibling of it: {@link isPreformattedChatContext} anchors on the envelope
 * spanning the entire string, so anything outside `</chat>` would make the
 * context look like ordinary user text and send it through
 * {@link preprocessTinyMessage}, whose paired-tag stripping eats the envelope.
 *
 * `elidedAfter` indexes into `turns`; the marker is emitted once, immediately
 * before the first turn past that index that survives cleaning. Anchoring it to
 * the following turn rather than the preceding one keeps it out of the trailing
 * position, where it would read as "the conversation continues" instead of
 * "turns were skipped here".
 *
 * The length bound is applied per turn, not to the assembled envelope. Bounding
 * the envelope reduced this to a head-and-tail slice of a string that is
 * already a head-and-tail sample: on a real session the middle turns vanished,
 * `<elided/>` went with them, and what remained opened and closed mid-tag. The
 * head turns the sampler exists to preserve were the ones cut, because they are
 * the long ones. Budgeting per turn keeps every sampled turn, its role tag and
 * the gap marker, and spends the omission inside the turns that are actually
 * oversized.
 */
export function formatTitleConversationContext(
	turns: readonly TitleConversationTurn[],
	options?: { currentTitle?: string; elidedAfter?: number },
): string {
	const rendered: Array<{
		role: TitleConversationTurn["role"];
		text: string;
		thinking: string;
		elidedBefore: boolean;
	}> = [];
	const elidedAfter = options?.elidedAfter;
	let elisionEmitted = false;
	for (const [index, turn] of turns.entries()) {
		// Clean raw content before adding structural tags so paired-tag stripping
		// cannot consume the `<user>`/`<assistant>` scaffolding added below.
		const text = cleanTinyMessage(turn.text ?? "").trim();
		const thinking = turn.role === "assistant" ? cleanTinyMessage(turn.thinking ?? "").trim() : "";
		if (!text && !thinking) continue;
		const elidedBefore = !elisionEmitted && elidedAfter !== undefined && index > elidedAfter;
		if (elidedBefore) elisionEmitted = true;
		rendered.push({ role: turn.role, text, thinking, elidedBefore });
	}
	if (rendered.length === 0) return "";
	const currentTitle = options?.currentTitle?.trim();
	// The name already in use leads the envelope: the model is asked to keep it
	// unless the subject changed, and that judgement is cheapest when it reads the
	// name before the turns. Bounded like any other body: nothing constrains a
	// session name's length, and an unbounded header would push the envelope past
	// the budget it is subtracted from.
	const header = currentTitle
		? `<current-title>\n${truncateTinyMessage(currentTitle, CURRENT_TITLE_MAX_CHARS)}\n</current-title>\n\n`
		: "";
	// Text and thinking are budgeted as two separate bodies, with `assemble`
	// owning the `<think>` tags. Truncating the joined pair instead would cut the
	// opening `<think>` out of any assistant turn whose text exceeds the head
	// allowance while the closing tag survived in the tail — a stray `</think>`
	// on most oversized turns, which is the mid-tag damage this whole approach
	// exists to avoid.
	const assemble = (bodies: readonly string[]): string => {
		const parts: string[] = [];
		for (const [index, turn] of rendered.entries()) {
			if (turn.elidedBefore) parts.push(ELIDED_MARKER);
			const sections: string[] = [];
			if (turn.text) sections.push(bodies[index * 2] ?? "");
			if (turn.thinking) sections.push(`<think>\n${bodies[index * 2 + 1] ?? ""}\n</think>`);
			parts.push(`<${turn.role}>\n${sections.join("\n\n")}\n</${turn.role}>`);
		}
		return `<chat>\n${header}${parts.join("\n\n")}\n</chat>`;
	};
	// Two slots per turn, in `assemble`'s indexing order; an absent half is an
	// empty body, which costs nothing and keeps the indexing arithmetic trivial.
	const bodies = rendered.flatMap(turn => [turn.text, turn.thinking]);
	const scaffolding = assemble(bodies.map(() => "")).length;
	const caps = allocateTurnBudgets(bodies, Math.max(0, MAX_TINY_MESSAGE_CHARS - scaffolding));
	// `caps` is index-aligned with `bodies`, so the fallback is unreachable; 0 is
	// the safe reading of "no budget" rather than a number that could overrun.
	return assemble(bodies.map((body, index) => truncateTinyMessage(body, caps[index] ?? 0)));
}
