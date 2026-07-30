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
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { importRoomKey } from "../collab/crypto";
import type { AgentSnapshot, CollabFrame, CollabSessionState, CollabUiRequest } from "../collab/protocol";
import { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO, parseCollabLink } from "../collab/protocol";
import { CollabSocket } from "../collab/relay-client";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { SessionEntry } from "../session/session-entries";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { isTodoPhase } from "../tools/todo";
import {
	INTERNAL_RESUME_PROMPT,
	type PortalActivity,
	type PortalGuestEvents,
	type PortalSubagent,
	type PortalSubagents,
	type TodoPhase,
	type TranscriptItem,
} from "./types";

/** Transcript items retained per session; older cards fall off the front. */
const TRANSCRIPT_CAP = 200;

/** Characters of streamed thinking kept as the working line's subtitle. */
const THINKING_TAIL_CHARS = 180;

/**
 * Subagent rows sent to the phone, matching the TUI HUD's own visible limit
 * (`SUBAGENT_HUD_VISIBLE_LIMIT`). The counts in {@link PortalSubagents} stay
 * whole-roster, so the panel can say how many rows the cap hid.
 */
const SUBAGENT_ROW_CAP = 8;

/**
 * Minimum gap between subagent pushes.
 *
 * A throttle, not a trailing debounce: the executor coalesces progress at 150ms
 * PER AGENT, so a wide fan-out produces a continuous stream while it runs and a
 * reset-on-every-change debounce would never fire until the last agent finished.
 * This fires at most once per window instead, which is well past the rate a
 * human reads a count and a tool name off a phone.
 */
const SUBAGENT_PUSH_THROTTLE_MS = 250;

/** Characters of a live tool's argument summary kept on a subagent row. */
const SUBAGENT_ARG_CHARS = 60;

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

/**
 * Narrowed `AgentProgress` for one subagent: only the fields the phone renders,
 * validated at the wire boundary.
 *
 * Split from the projection on purpose. Ingest normalizes one payload's own
 * fields; {@link PortalGuest} resolves precedence ACROSS sources (roster,
 * lifecycle, progress), which no single payload can answer.
 */
interface SubagentProgressView {
	task?: string;
	description?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	tools?: number;
	tokens?: number;
	cost?: number;
	durationMs?: number;
}

interface SubagentLifecycleView {
	description?: string;
	/** `started` | `completed` | `failed` | `aborted`, unvalidated beyond being a word. */
	status?: string;
}

/**
 * The two wire-boundary normalizers below exist because eleven fields across two
 * payloads need identical treatment, and because the failure mode has to be
 * per-field: a host on a different build that renamed or retyped `currentTool`
 * must cost that one line of the row, not the whole row. A schema parse of the
 * payload would drop everything on one bad field, which is the wrong trade for a
 * display-only projection.
 */

/** Non-blank string, trimmed; anything else reads as absent. */
function wireText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/** Finite number; `NaN`, `Infinity` and non-numbers read as absent. */
function wireNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a `bus` frame's `task:subagent:progress` payload.
 *
 * The frame's `data` is typed `unknown` for a reason: it is JSON from a host that
 * may be a different build, and the payload the host really sends is wider than
 * the wire package declares. So every field is narrowed rather than asserted —
 * the same treatment todo phases get above — and a payload without a joinable id
 * is dropped instead of producing a row keyed on `undefined`.
 */
function subagentProgressFrom(data: unknown): { id: string; view: SubagentProgressView } | null {
	if (!isRecord(data) || !isRecord(data.progress)) return null;
	const progress = data.progress;
	// `progress.id` is the subagent's registry id — the same id `AgentSnapshot.id`
	// carries, which is what makes the join with the roster possible.
	const id = wireText(progress.id);
	if (!id) return null;
	return {
		id,
		view: {
			task: wireText(progress.task),
			description: wireText(progress.description),
			currentTool: wireText(progress.currentTool),
			currentToolArgs: wireText(progress.currentToolArgs)?.slice(0, SUBAGENT_ARG_CHARS),
			lastIntent: wireText(progress.lastIntent),
			tools: wireNumber(progress.toolCount),
			tokens: wireNumber(progress.tokens),
			cost: wireNumber(progress.cost),
			durationMs: wireNumber(progress.durationMs),
		},
	};
}

/** Read a `bus` frame's `task:subagent:lifecycle` payload. See {@link subagentProgressFrom}. */
function subagentLifecycleFrom(data: unknown): { id: string; view: SubagentLifecycleView } | null {
	if (!isRecord(data)) return null;
	const id = wireText(data.id);
	if (!id) return null;
	return { id, view: { description: wireText(data.description), status: wireText(data.status) } };
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
	/**
	 * Live subagents, mirroring the TUI's Subagents HUD and status-line badge.
	 * Recomputed on every roster or progress frame (the projection is bounded and
	 * cheap) so a `/api/sessions` card and a cold SSE open both read current truth;
	 * the PUSH to the phone is throttled separately, see
	 * {@link SUBAGENT_PUSH_THROTTLE_MS}.
	 */
	subagents: PortalSubagents = { running: 0, total: 0, rows: [] };

	readonly #events: PortalGuestEvents;
	readonly #displayName: string;
	#socket?: CollabSocket;
	/** base64url write token from a full link; absent on a read-only (view) link. */
	#writeToken?: string;
	/** Set by {@link close}: suppresses the close callback the portal just caused. */
	#closed = false;
	/**
	 * Set when this portal aborted a turn that persisted no aborted entry to
	 * derive from. Survives the welcome/snapshot rebuild for that reason; see
	 * {@link markInterrupted}.
	 */
	#optimisticInterrupt = false;
	/**
	 * True between a welcome and its final snapshot chunk, i.e. while entries being
	 * absorbed are replayed history rather than live news.
	 */
	#replayingSnapshot = false;
	/**
	 * Host agent-registry roster from the latest `agents` frame (and from the
	 * welcome, which carries one). Includes the main agent; the projection filters.
	 */
	#roster: AgentSnapshot[] = [];
	/**
	 * Per-subagent detail from the mirrored `task:subagent:*` bus channels, keyed
	 * by registry id. Separate from the roster because they arrive on independent
	 * frames with no ordering guarantee, and either can be the first to mention an
	 * id: a spawn's lifecycle event can beat the debounced roster broadcast, and a
	 * rehydrated parked agent appears in the roster having emitted nothing.
	 */
	#progress = new Map<string, SubagentProgressView>();
	#lifecycle = new Map<string, SubagentLifecycleView>();
	#subagentThrottle: Timer | undefined;
	/** Last projection actually pushed, for the change test in {@link #flushSubagents}. */
	#lastSubagentsJson = "";

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
		clearTimeout(this.#subagentThrottle);
		this.#subagentThrottle = undefined;
		this.#socket?.close();
	}

	prompt(text: string): void {
		this.#send({ t: "prompt", text });
	}

	/** Returns whether the abort actually went out; a read-only room drops it. */
	abort(): boolean {
		return this.#send({ t: "abort" });
	}

	/**
	 * Record that this portal aborted the turn, without waiting for the host to
	 * persist an aborted assistant entry.
	 *
	 * The transcript is the honest source for "was the last turn cut short", and
	 * it stays authoritative — but it is not complete: a turn stopped before its
	 * first token produces no assistant entry at all, so a phone that pressed stop
	 * in that window would get no resume button for an abort it performed itself.
	 *
	 * Kept in its own field rather than only in `activity` because a welcome resets
	 * activity wholesale and the snapshot that follows can only rebuild
	 * `interrupted` from a persisted aborted entry — which in this exact case does
	 * not exist, so a reconnect would silently drop the affordance. Cleared by the
	 * next `agent_start` and by any assistant entry that did not abort, so it
	 * cannot outlive the interruption it describes.
	 */
	markInterrupted(): void {
		this.#optimisticInterrupt = true;
		if (this.activity.interrupted) return;
		this.activity = { ...this.activity, interrupted: true };
		this.#events.onActivity?.(this.activity);
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
	#send(frame: CollabFrame): boolean {
		const socket = this.#socket;
		if (!socket || this.#closed) {
			logger.debug("mobile portal guest: dropping frame, not connected", { t: frame.t });
			return false;
		}
		if (!this.#writeToken) {
			logger.debug("mobile portal guest: dropping frame on a read-only room", { t: frame.t });
			return false;
		}
		socket.send(frame);
		return true;
	}

	#handleFrame(frame: CollabFrame): void {
		switch (frame.t) {
			case "welcome":
				this.#handleWelcome(frame.state, frame.agents);
				break;
			case "snapshot-chunk":
				for (const entry of frame.entries) this.#absorb(entry);
				// The final chunk completes the snapshot: everything a subscriber
				// renders is now current, and nothing else announces that.
				if (frame.final) {
					this.#replayingSnapshot = false;
					// The snapshot can only rebuild `interrupted` from a persisted
					// aborted entry, so an abort this portal made before the turn's
					// first token has to be re-applied here or a reconnect drops the
					// resume button for an interruption that really happened.
					if (this.#optimisticInterrupt && !this.activity.interrupted && !this.activity.working) {
						this.activity = { ...this.activity, interrupted: true };
					}
					this.#events.onResync?.();
				}
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
			case "agents":
				this.#roster = frame.agents;
				this.#refreshSubagents();
				break;
			case "bus":
				// Mirrored host EventBus traffic: the per-subagent detail the roster
				// cannot carry. The host mirrors only the lifecycle and progress
				// channels, but switch on the channel anyway so a host that starts
				// mirroring a third one cannot land its payload in the wrong map.
				if (frame.channel === TASK_SUBAGENT_PROGRESS_CHANNEL) {
					const parsed = subagentProgressFrom(frame.data);
					if (parsed) {
						this.#progress.set(parsed.id, parsed.view);
						this.#refreshSubagents();
					}
				} else if (frame.channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) {
					const parsed = subagentLifecycleFrom(frame.data);
					if (parsed) {
						this.#lifecycle.set(parsed.id, parsed.view);
						this.#refreshSubagents();
					}
				}
				break;
			case "error":
				// Targeted host reply: proto mismatch at hello, or a mutating frame
				// refused on a read-only link. Neither is actionable per-session.
				logger.debug("mobile portal guest: host error frame", { message: frame.message });
				break;
			// `transcript` is deliberately unhandled: it answers the TUI Agent Hub's
			// `fetch-transcript`, which this portal never sends. The phone shows what
			// each subagent is doing, not its full transcript — a per-agent transcript
			// view would need the incremental byte-offset protocol too.
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
	#handleWelcome(state: CollabSessionState, agents: AgentSnapshot[]): void {
		this.#replayingSnapshot = true;
		const staleUi = this.pendingUi;
		this.transcript = [];
		this.todos = [];
		// The roster and the bus detail describe the session being replaced, and
		// only the roster is re-sent. Clearing both is what stops a resumed session
		// from inheriting the previous one's subagent rows; the welcome's own roster
		// then seeds the panel before the snapshot train finishes.
		this.#progress.clear();
		this.#lifecycle.clear();
		this.#roster = agents;
		this.#refreshSubagents();
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
		// A prompt sent by a guest — the phone's own composer included — is stored
		// as a `custom_message` entry, not a plain user message: the host attributes
		// it so the TUI can name who steered. Handling only `message` entries is
		// why the phone showed no card for anything typed on the phone; the agent
		// appeared to answer a question that was never asked. This branch is also
		// where the resume marker is filtered in practice, because the play
		// button's prompt travels this same path.
		if (entry.type === "custom_message") {
			if (entry.customType !== COLLAB_PROMPT_MESSAGE_TYPE || !entry.display) return;
			const text = collectText(entry.content);
			if (!text || text === INTERNAL_RESUME_PROMPT) return;
			// Name the sender when it is not this portal: on a shared session the
			// difference between "I asked for this" and "someone else asked for
			// this" is the whole point of the card. `details` crossed the wire as
			// JSON, so the field is narrowed rather than asserted.
			const details: unknown = entry.details;
			const sender =
				details && typeof details === "object" && "from" in details && typeof details.from === "string"
					? details.from
					: "";
			this.#push(
				sender && sender !== this.#displayName ? { kind: "user", text, from: sender } : { kind: "user", text },
			);
			return;
		}
		if (entry.type !== "message") return;
		const message = entry.message;
		switch (message.role) {
			case "user": {
				const text = collectText(message.content);
				// A user message typed at the terminal is an ordinary card. Only the
				// portal's own resume prompt is dropped, matched in full rather than
				// by prefix: a prefix test would let any write-token holder steer the
				// agent with text the phone never renders, which is exactly the
				// blindness this projection exists to remove.
				if (text && text !== INTERNAL_RESUME_PROMPT) this.#push({ kind: "user", text });
				return;
			}
			case "assistant": {
				// The transcript projection doubles as the resume-button signal: the
				// last assistant message's stopReason says whether the turn finished
				// or was cut short. Snapshot replay sets this the same way live
				// entries do, so a portal that reconnects after an abort still shows
				// the session as interrupted.
				//
				// The push matters as much as the value: this flag arrives on an
				// `entry` frame, and the `event` frames that would otherwise notify
				// come from an independent tap on the host with no ordering guarantee
				// between them. Without emitting here, an aborted entry that lands
				// after `agent_end` — or any snapshot replay after a reconnect — left
				// the phone with no resume button until something unrelated changed.
				const interrupted = message.stopReason === "aborted";
				// A completed assistant turn is the authoritative answer to the
				// optimistic flag — but only a LIVE one. A welcome replays history that
				// predates the abort, so clearing on a replayed entry dropped the very
				// affordance the flag exists to carry across the reconnect (and left the
				// flag working only for sessions that had never completed a turn, which
				// is why a test built on an empty transcript passed).
				if (!interrupted && !this.#replayingSnapshot) this.#optimisticInterrupt = false;
				if (interrupted !== this.activity.interrupted) {
					this.activity = { ...this.activity, interrupted };
					this.#events.onActivity?.(this.activity);
				}
				for (const part of message.content) {
					if (part.type === "text" && part.text.trim()) this.#push({ kind: "assistant", text: part.text });
					else if (part.type === "thinking" && part.thinking.trim())
						this.#push({ kind: "thinking", text: part.thinking });
					else if (part.type === "toolCall")
						this.#push({ kind: "tool", id: part.id, name: part.name, args: part.arguments });
				}
				// The seam belongs in the transcript, not in live UI state: an abort is
				// a fact about this point in the conversation, so it has to sit where it
				// happened and survive re-renders and reconnects. A turn aborted before
				// its first token contributes no other card at all, which is what made
				// it read as the agent ignoring the prompt above it.
				if (interrupted && this.transcript.at(-1)?.kind !== "stopped") this.#push({ kind: "stopped" });
				return;
			}
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
				// A new turn answers any previous interruption, however it started —
				// typed prompt, the resume button, or a queued message flushing.
				this.#optimisticInterrupt = false;
				this.activity = { working: true, interrupted: false };
				break;
			case "agent_end":
				// Preserve `interrupted`: the abort's assistant entry lands before the
				// turn-end event, and replacing the whole object here would wipe the
				// very signal the resume button reads.
				this.activity = { ...this.activity, working: false };
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

	/**
	 * Rebuild {@link subagents} and schedule a push.
	 *
	 * The field is rebuilt eagerly — every roster and progress frame — because it is
	 * read synchronously by the session-list card and the cold SSE open, and a lag
	 * there would show a stale count on the surface the count exists for. Only the
	 * push is rate-limited.
	 */
	#refreshSubagents(): void {
		this.subagents = this.#projectSubagents();
		if (this.#closed || this.#subagentThrottle) return;
		// Same shape as the host's own broadcast throttles (`#scheduleAgentsBroadcast`):
		// the first change opens a window, the timer emits whatever the projection
		// says when the window closes.
		this.#subagentThrottle = setTimeout(() => {
			this.#subagentThrottle = undefined;
			if (this.#closed) return;
			const json = JSON.stringify(this.subagents);
			// Progress payloads carry churn the phone never renders (`recentOutput`,
			// `recentTools`), so most of them project to an identical panel. Comparing
			// the projection rather than the payload is what keeps a wide fan-out from
			// waking the phone's radio for nothing.
			if (json === this.#lastSubagentsJson) return;
			this.#lastSubagentsJson = json;
			this.#events.onSubagents?.(this.subagents);
		}, SUBAGENT_PUSH_THROTTLE_MS);
	}

	/**
	 * Join the roster with the bus detail into the panel's rows.
	 *
	 * Two filters, both learned from real rosters rather than reasoned about:
	 *
	 * Unlike the TUI HUD this does NOT filter to detached spawns. The HUD skips a
	 * synchronous `task` call because the parent's inline tool block already draws
	 * that call's progress live in the terminal; the phone's transcript renders a
	 * tool card with no progress at all, so filtering here would hide running work
	 * with nothing else showing it.
	 *
	 * It DOES drop a non-running agent nothing is known about. The registry keeps
	 * finished subagents as `idle` and then `parked` until release, and rehydrates
	 * on-disk ones when the Agent Hub opens, so a long session's roster accumulates
	 * names from fan-outs that ended hours ago. With no bus traffic for them — the
	 * usual case, since their lifecycle events predate this portal's attach — such a
	 * row is a name, a dim glyph and nothing else, pushing the live work off a phone
	 * screen. An agent that finished while the portal was watching keeps its row.
	 */
	#projectSubagents(): PortalSubagents {
		let running = 0;
		const subs: PortalSubagent[] = [];
		for (const snapshot of this.#roster) {
			if (snapshot.kind !== "sub") continue;
			// Deliberately the roster status, not the display status below: this is
			// verbatim the TUI status-line badge's predicate, and the two numbers
			// disagreeing would be worse than either being imperfect. Counted before
			// the filter so a running agent can never be counted and then dropped.
			const isRunning = snapshot.status === "running";
			if (isRunning) running++;
			const progress = this.#progress.get(snapshot.id);
			const lifecycle = this.#lifecycle.get(snapshot.id);
			if (!isRunning && !progress && !lifecycle) continue;
			const ended =
				lifecycle?.status === "completed" || lifecycle?.status === "failed" || lifecycle?.status === "aborted"
					? lifecycle.status
					: undefined;
			// The row's label, and the two candidates it is NOT.
			//
			// The TUI HUD's precedence is `description`, then a muted `progress.task`
			// preview. Neither fallback survives contact with a real `task` batch: the
			// batch names each spawn, and that name becomes the registry id AND the
			// description until the tiny-model label lands, which rendered `SpinnerCheck`
			// twice on one row; and `progress.task` is the spawn prompt WITH omp's
			// wrapper preamble, so it reads "Complete the assignment below, thoroughly…"
			// for every agent — a paragraph of boilerplate clamped to two lines.
			//
			// So the label is only ever a real human label, and the row is honest with no
			// label at all: `intent` below already answers what the agent is doing right
			// now, which is what the HUD's task preview was standing in for (the terminal
			// HUD has no live-intent line; this row does).
			const task = [lifecycle?.description, progress?.description].find(
				candidate => candidate && candidate !== snapshot.id,
			);
			subs.push({
				id: snapshot.id,
				agent: snapshot.displayName,
				// A finished subagent is `idle` in the registry, which reads as "sitting
				// there doing nothing" rather than "done". The lifecycle word is the
				// honest one whenever the task actually ended.
				status: ended ?? snapshot.status,
				parentId: snapshot.parentId,
				task,
				intent: progress?.currentTool
					? `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}`
					: progress?.lastIntent,
				tools: progress?.tools,
				tokens: progress?.tokens,
				cost: progress?.cost,
				durationMs: progress?.durationMs,
				startedAt: snapshot.createdAt,
			});
		}
		// Running first, then most recently active: on a phone the top of the list is
		// the only part reliably on screen, so it has to hold the live work.
		subs.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
		return { running, total: subs.length, rows: subs.slice(0, SUBAGENT_ROW_CAP) };
	}
}
