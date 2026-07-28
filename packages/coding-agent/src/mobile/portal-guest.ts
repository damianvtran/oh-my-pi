/**
 * Headless collab guest: one per published room, projected for the phone.
 *
 * Unlike the TUI guest (`../collab/guest.ts`) this one keeps no replica session.
 * The portal only needs a flat, renderable projection of the room — transcript
 * cards, the todo panel, the working line — so entries are folded into
 * {@link TranscriptItem}s as they arrive and nothing else is retained.
 *
 * Everything below the projection is omp's own collab stack: `CollabSocket`
 * owns sealing, envelope packing, ordered delivery, reconnect backoff and
 * fatal-close classification, `parseCollabLink` owns the link grammar, and
 * `CollabFrame` is the authoritative frame union. The out-of-repo predecessor
 * hand-rolled all three; in-repo a second copy would drift from the host on the
 * first protocol change and fail in the field, not in CI.
 */

import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { importRoomKey } from "../collab/crypto";
import type { CollabFrame, CollabSessionState, CollabUiRequest } from "../collab/protocol";
import { COLLAB_PROTO, parseCollabLink } from "../collab/protocol";
import { CollabSocket } from "../collab/relay-client";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { SessionEntry } from "../session/session-entries";
import { isTodoPhase } from "../tools/todo";
import type { PortalActivity, PortalGuestEvents, TodoPhase, TranscriptItem } from "./types";

/** Transcript items retained per session; older cards fall off the front. */
const TRANSCRIPT_CAP = 200;

/** Characters of streamed thinking kept as the working line's subtitle. */
const THINKING_TAIL_CHARS = 180;

const DEFAULT_DISPLAY_NAME = "omp-mobile";

/** Last `max` characters, cut on a word boundary so the status line reads cleanly. */
function tailOf(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(flat.length - max);
	const space = cut.indexOf(" ");
	return `…${space > 0 ? cut.slice(space + 1) : cut}`;
}

function collectText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content.trim();
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map(part => part.text)
		.join("")
		.trim();
}

/**
 * The todo tool reports its phases in `details`. That value crossed the wire as
 * JSON, so it is shape-checked with the tool's own guard rather than trusted.
 */
function todoPhasesFrom(details: unknown): TodoPhase[] | null {
	if (!details || typeof details !== "object" || !("phases" in details)) return null;
	const phases = details.phases;
	if (!Array.isArray(phases)) return null;
	const valid = phases.filter(isTodoPhase);
	return valid.length === phases.length ? valid : null;
}

export class PortalGuest {
	/** Latest host footer snapshot: model, streaming flag, participants, context usage. */
	state?: CollabSessionState;
	/** Host ask currently on the phone's screen, if any. */
	pendingUi?: CollabUiRequest;
	/** Rolling transcript tail the phone renders; the full snapshot is not retained. */
	transcript: TranscriptItem[] = [];
	/** Latest todo phases seen on a `todo` tool result, mirroring the TUI panel. */
	todos: TodoPhase[] = [];
	/**
	 * What the agent is doing right now, mirroring the TUI's working line. omp
	 * derives that line from a tool call's `intent` (falling back to the tool
	 * name) and shows streamed thinking above it; both ride the same event frames
	 * a guest already receives.
	 */
	activity: PortalActivity = { working: false };

	readonly #events: PortalGuestEvents;
	readonly #displayName: string;
	#socket?: CollabSocket;
	/** base64url write token from a full link; absent on a read-only (view) link. */
	#writeToken?: string;
	/** Set by {@link close}: suppresses the close callback the portal just caused. */
	#closed = false;

	constructor(events: PortalGuestEvents, displayName = DEFAULT_DISPLAY_NAME) {
		this.#events = events;
		this.#displayName = displayName;
	}

	/**
	 * Live socket state. `CollabSocket` reconnects with backoff on a transient
	 * drop and the host re-welcomes on every reconnect, so a brief `false` here
	 * is not a dead room — the portal's rescan loop tolerates it and only drops a
	 * session when its published room record disappears.
	 */
	get connected(): boolean {
		return !this.#closed && this.#socket?.isOpen === true;
	}

	/**
	 * Join the room. Resolves as soon as the socket is dialing rather than on the
	 * first welcome: the portal lists a session the moment it discovers the room
	 * and fills the projection in on {@link PortalGuestEvents.onResync}, so one
	 * unreachable host must not stall the scan that found it.
	 */
	async connect(link: string): Promise<void> {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		this.#socket = socket;
		this.#closed = false;

		// Every (re)connect re-introduces us and the host answers with a fresh
		// welcome, which replaces the projection wholesale — see #handleWelcome.
		socket.onOpen = () =>
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: this.#displayName,
				writeToken: this.#writeToken,
				// Lets the host say the session became phone-reachable instead of
				// announcing a person joining a share.
				client: "mobile-portal",
			});
		socket.onFrame = frame => this.#handleFrame(frame);
		socket.onClose = (reason, willReconnect) => {
			if (this.#closed) return;
			if (willReconnect) {
				// Transient: the socket is already retrying and the host will
				// re-welcome. Announcing a close here would evict a live session.
				logger.debug("mobile portal guest: connection lost, reconnecting", { reason });
				return;
			}
			this.#events.onClose?.(reason);
		};
		socket.connect();
	}

	close(): void {
		this.#closed = true;
		this.#socket?.close();
	}

	prompt(text: string): void {
		this.#send({ t: "prompt", text });
	}

	abort(): void {
		this.#send({ t: "abort" });
	}

	answerUi(reqId: number, value: string | undefined): void {
		if (this.pendingUi?.reqId === reqId) this.pendingUi = undefined;
		this.#send({ t: "ui-response", reqId, value });
	}

	/**
	 * A read-only link carries no write token, so the host answers every mutating
	 * frame with a targeted `error` instead of acting on it. Dropping it here
	 * keeps the phone's read-only view working rather than throwing at a caller
	 * that cannot do anything useful with the failure.
	 */
	#send(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket || this.#closed) {
			logger.debug("mobile portal guest: dropping frame, not connected", { t: frame.t });
			return;
		}
		if (!this.#writeToken) {
			logger.debug("mobile portal guest: dropping frame on a read-only room", { t: frame.t });
			return;
		}
		socket.send(frame);
	}

	#handleFrame(frame: CollabFrame): void {
		switch (frame.t) {
			case "welcome":
				this.#handleWelcome(frame.state);
				break;
			case "snapshot-chunk":
				for (const entry of frame.entries) this.#absorb(entry);
				// The final chunk completes the snapshot: everything a subscriber
				// renders is now current, and nothing else announces that.
				if (frame.final) this.#events.onResync?.();
				break;
			case "entry":
				this.#absorb(frame.entry);
				this.#events.onEntry?.();
				break;
			case "state":
				this.state = frame.state;
				this.#events.onState?.(frame.state);
				break;
			case "event":
				if (this.#absorbActivity(frame.event)) this.#events.onActivity?.(this.activity);
				this.#events.onEvent?.({ type: frame.event.type });
				break;
			case "ui-request":
				this.pendingUi = frame.request;
				this.#events.onUiRequest?.(frame.request);
				break;
			case "ui-request-end":
				if (this.pendingUi?.reqId === frame.reqId) this.pendingUi = undefined;
				this.#events.onUiRequestEnd?.(frame.reqId);
				break;
			case "bye":
				this.#events.onClose?.(frame.reason);
				break;
			case "error":
				// Targeted host reply: proto mismatch at hello, or a mutating frame
				// refused on a read-only link. Neither is actionable per-session.
				logger.debug("mobile portal guest: host error frame", { message: frame.message });
				break;
		}
	}

	/**
	 * A welcome is the whole state, never a delta. The host sends one on join and
	 * again when it rebinds the room to a different session — a room started by
	 * `collab.autoStart` follows an in-session `/resume` — so the chunk train that
	 * follows describes a transcript that REPLACES this one. Keeping the old items
	 * would splice two sessions into a single view, and a stale ask would still be
	 * on screen for a dialog the host already discarded.
	 */
	#handleWelcome(state: CollabSessionState): void {
		const staleUi = this.pendingUi;
		this.transcript = [];
		this.todos = [];
		this.activity = { working: false };
		this.pendingUi = undefined;
		this.state = state;
		this.#events.onState?.(state);
		this.#events.onActivity?.(this.activity);
		if (staleUi) this.#events.onUiRequestEnd?.(staleUi.reqId);
	}

	/**
	 * Turn a session entry into the structured items the phone renders as
	 * TUI-style cards. Kept structured (rather than flattened to text) so tool
	 * calls, thinking, and todos can be drawn the way the terminal draws them.
	 */
	#absorb(entry: SessionEntry): void {
		if (entry.type !== "message") return;
		const message = entry.message;
		switch (message.role) {
			case "user": {
				const text = collectText(message.content);
				if (text) this.#push({ kind: "user", text });
				return;
			}
			case "assistant":
				for (const part of message.content) {
					if (part.type === "text" && part.text.trim()) this.#push({ kind: "assistant", text: part.text });
					else if (part.type === "thinking" && part.thinking.trim())
						this.#push({ kind: "thinking", text: part.thinking });
					else if (part.type === "toolCall")
						this.#push({ kind: "tool", id: part.id, name: part.name, args: part.arguments });
				}
				return;
			case "toolResult": {
				const text = collectText(message.content);
				// The todo tool owns the panel, not the transcript: its result is state.
				if (message.toolName === "todo") {
					const phases = todoPhasesFrom(message.details);
					if (phases) this.todos = phases;
				}
				// Attach to the pending call so the card renders as one unit.
				for (let i = this.transcript.length - 1; i >= 0; i--) {
					const item = this.transcript[i]!;
					if (item.kind === "tool" && item.id === message.toolCallId) {
						item.output = text;
						item.isError = message.isError === true;
						return;
					}
				}
				// No call to attach to: the snapshot tail started mid-turn, or the
				// call scrolled off the cap. Show the result on its own.
				if (text) {
					this.#push({
						kind: "tool",
						id: message.toolCallId,
						name: message.toolName || "tool",
						args: {},
						output: text,
						isError: message.isError === true,
					});
				}
				return;
			}
		}
	}

	/**
	 * Fold an agent event into {@link activity}. Returns whether anything the UI
	 * renders actually changed, so a busy stream does not push an SSE frame per
	 * token — `message_update` fires constantly while thinking streams.
	 */
	#absorbActivity(event: AgentSessionEvent): boolean {
		const before = JSON.stringify(this.activity);
		switch (event.type) {
			case "agent_start":
				this.activity = { working: true };
				break;
			case "agent_end":
				this.activity = { working: false };
				break;
			case "tool_execution_start": {
				// omp titles the working line with the call's `intent` and falls back
				// to the tool name when the model did not supply one.
				const intent = event.intent?.trim();
				this.activity = { ...this.activity, working: true, intent: intent || event.toolName };
				break;
			}
			case "message_update":
			case "message_end": {
				// Only a streaming assistant message carries thinking, and only its
				// tail is useful as a status line: keep it to the last sentence-ish
				// so the UI never has to truncate mid-word.
				const message = event.message;
				const thinking =
					message.role === "assistant"
						? message.content
								.filter(part => part.type === "thinking")
								.map(part => part.thinking)
								.join("")
								.trim()
						: "";
				this.activity = {
					...this.activity,
					thinking: thinking ? tailOf(thinking, THINKING_TAIL_CHARS) : undefined,
				};
				break;
			}
		}
		return JSON.stringify(this.activity) !== before;
	}

	#push(item: TranscriptItem): void {
		this.transcript.push(item);
		if (this.transcript.length > TRANSCRIPT_CAP) this.transcript.shift();
	}
}
