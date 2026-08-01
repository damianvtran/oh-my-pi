/**
 * SessionFocusController - Weak retargeting primitive between the rendering/
 * input layer and the AgentSession it displays.
 *
 * Focusing re-points the transcript, streaming event subscription, status
 * line, and editor prompt/interrupt at a subagent's live AgentSession (from
 * AgentRegistry) without touching the main session underneath; unfocusing
 * re-attaches the main session and rebuilds the transcript from its
 * authoritative state.
 *
 * The view is a stack, not a pointer: drilling from a subagent into one of its
 * own children pushes, and popping returns to the exact session that was on
 * screen before rather than re-deriving an ancestor from the registry. That is
 * what makes depth greater than one navigable in both directions, since a
 * revived agent's `parentId` chain says where it sits in the tree but not how
 * the user got there.
 */

import { formatKeyHint } from "../../config/keybindings";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { setTerminalTitleState } from "../../utils/title-generator";
import type { InteractiveModeContext } from "../types";

/**
 * One level of the drill-down path. `session` is the live session captured when
 * the level was entered; levels seeded from an agent's ancestor chain carry
 * none until they are popped back to and revived.
 */
interface FocusFrame {
	readonly agentId: string;
	session: AgentSession | undefined;
}

/** Siblings of `agentId` under the same parent, in registration order. */
function siblingsOf(registry: AgentRegistry, agentId: string): AgentRef[] {
	const self = registry.get(agentId);
	if (!self) return [];
	return registry
		.list()
		.filter(ref => ref.parentId === self.parentId && ref.kind !== "advisor" && ref.status !== "aborted")
		.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export class SessionFocusController {
	static #active: SessionFocusController | undefined;

	/**
	 * The controller driving the visible session, or undefined outside
	 * interactive mode. Transcript blocks are produced by pure render functions
	 * with no route to the mode context, so the click path on a rendered agent
	 * row resolves the controller here — the same shape the roster already uses
	 * for {@link AgentRegistry.global}.
	 */
	static active(): SessionFocusController | undefined {
		return SessionFocusController.#active;
	}

	/** Root-to-current drill path. Empty when the main session is on screen. */
	#stack: FocusFrame[] = [];
	#registryUnsubscribe: (() => void) | undefined;

	constructor(
		private ctx: InteractiveModeContext,
		private registry: AgentRegistry = AgentRegistry.global(),
		private lifecycle: () => AgentLifecycleManager = () => AgentLifecycleManager.global(),
	) {
		SessionFocusController.#active = this;
	}

	get focusedAgentId(): string | undefined {
		return this.#stack.at(-1)?.agentId;
	}

	/** Focused live session, undefined when unfocused. */
	get target(): AgentSession | undefined {
		return this.#stack.at(-1)?.session;
	}

	/** How many levels deep the view is. 0 is the main session. */
	get depth(): number {
		return this.#stack.length;
	}

	/** Agent ids from the outermost level to the one on screen. */
	get focusPath(): readonly string[] {
		return this.#stack.map(frame => frame.agentId);
	}

	/**
	 * Whether clicking `id` would open something. Parked agents qualify: the
	 * revival happens inside {@link AgentLifecycleManager.ensureLive}. Advisors
	 * are read-only transcripts with no revivable session, and a collab guest
	 * has no local sessions at all.
	 */
	canFocus(id: string): boolean {
		if (this.ctx.collabGuest) return false;
		const ref = this.registry.get(id);
		return ref !== undefined && ref.kind !== "advisor" && ref.status !== "aborted";
	}

	/** Focus the main view on an agent's live session. Throws an Error with a user-displayable message. */
	async focusAgent(id: string): Promise<void> {
		if (this.ctx.collabGuest) throw new Error("Viewing agents is unavailable in a collab session.");
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const existing = this.#stack.findIndex(frame => frame.agentId === id);
		const session = await this.lifecycle().ensureLive(id);
		if (id === this.focusedAgentId && session === this.target) return;
		if (existing >= 0) {
			// Re-entering a level already on the path is a pop back to it, not a
			// second copy: the drill path must stay acyclic or the pop hotkey
			// would walk the same agents forever.
			this.#stack.length = existing + 1;
			this.#stack[existing]!.session = session;
		} else {
			this.#stack.push(...this.#seedAncestors(id), { agentId: id, session });
		}
		this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
		await this.#attach(session);
		this.ctx.showStatus(`Viewing agent ${id} — ${this.#upHint()} goes up a level, Esc returns to main`);
	}

	/** Pop one level, back to the previous view or the main session. No-op when unfocused. */
	async focusParent(): Promise<void> {
		if (this.#stack.length === 0) return;
		// Popping the LAST frame is unfocusing, so delegate before mutating the
		// stack: unfocus() guards on a non-empty stack, and popping first made it
		// a no-op that left the viewer attached to the subagent with no way back.
		if (this.#stack.length === 1) return this.unfocus();
		this.#stack.pop();
		const next = this.#stack.at(-1)!;
		next.session ??= await this.lifecycle().ensureLive(next.agentId);
		await this.#attach(next.session);
		this.ctx.showStatus(
			this.#stack.length > 1
				? `Viewing agent ${next.agentId} — ${this.#upHint()} goes up a level`
				: `Viewing agent ${next.agentId}`,
		);
	}

	/**
	 * Key label for the pop action, so the hint matches whatever the user bound.
	 *
	 * Optional-chained because this runs inside `focusAgent`: a status hint is
	 * cosmetic, and letting a missing keybindings manager throw would abort the
	 * navigation itself. Embedders and headless hosts do not always wire one.
	 */
	#upHint(): string {
		const key = this.ctx.keybindings?.getKeys("app.session.parent")?.[0];
		return key ? formatKeyHint(key) : "the parent shortcut";
	}

	/**
	 * Move to the next (`+1`) or previous (`-1`) agent sharing the current
	 * agent's parent, wrapping at both ends. No-op when unfocused or alone.
	 */
	async focusSibling(direction: 1 | -1): Promise<void> {
		const current = this.focusedAgentId;
		if (!current) return;
		const siblings = siblingsOf(this.registry, current);
		if (siblings.length < 2) {
			this.ctx.showStatus("No sibling agents");
			return;
		}
		const index = siblings.findIndex(ref => ref.id === current);
		if (index < 0) return;
		const next = siblings[(index + direction + siblings.length) % siblings.length]!;
		return this.focusAgent(next.id);
	}

	/** Siblings of the current agent, for the footer's position readout. Empty when unfocused. */
	siblings(): readonly AgentRef[] {
		const current = this.focusedAgentId;
		return current ? siblingsOf(this.registry, current) : [];
	}

	/** Return to the main session. No-op when unfocused. */
	async unfocus(): Promise<void> {
		if (this.#stack.length === 0) return;
		this.#stack = [];
		await this.#attach(this.ctx.session);
		this.ctx.showStatus("Returned to main session");
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		if (SessionFocusController.#active === this) SessionFocusController.#active = undefined;
	}

	/**
	 * Frames for `id`'s ancestors below the main session, so a jump straight to a
	 * deep agent (the Agent Hub roster lists the whole tree flat) still pops back
	 * up one level at a time. Only the entry point is derived from `parentId`;
	 * every later push and pop uses the stack itself.
	 */
	#seedAncestors(id: string): FocusFrame[] {
		if (this.#stack.length > 0) return [];
		const chain: FocusFrame[] = [];
		const seen = new Set<string>([id]);
		let parentId = this.registry.get(id)?.parentId;
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			const ref = this.registry.get(parentId);
			if (!ref) break;
			seen.add(parentId);
			chain.unshift({ agentId: parentId, session: ref.session ?? undefined });
			parentId = ref.parentId;
		}
		return chain;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !dead) return;
		void this.unfocus().then(() => {
			this.ctx.showStatus(`Agent ${event.ref.id} is ${gone ? "gone" : event.ref.status}; returned to main session`);
		});
	}

	/** Retarget core, both directions: swap subscription, transcript, and status line onto `target`. */
	async #attach(target: AgentSession): Promise<void> {
		this.ctx.unsubscribe?.();
		this.ctx.clearTransientSessionUi();
		this.ctx.eventController.resetTranscriptAnchors();
		// Orphan-delta guard: when attaching mid-turn the message_start for the
		// in-flight assistant message predates the attach. message_update carries
		// the full accumulating message, so synthesize the missing start before
		// the first orphaned update; every other handler is tolerant of unknown
		// anchors (guarded by streamingComponent/pendingTools lookups).
		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async event => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				await this.ctx.eventController.handleEvent({ type: "message_start", message: event.message });
			}
			await this.ctx.eventController.handleEvent(event);
		});
		this.ctx.statusLine.setSession(target, this.#focusedAgentId);
		// Clearing native scrollback only makes sense where the terminal owns it.
		// The fullscreen viewport paints its own frame, so the erase buys nothing
		// and costs a full transcript re-emit on every level of the drill path.
		await this.ctx.renderInitialMessages({ clearTerminalHistory: this.ctx.ui.viewportMode !== "fullscreen" });
		// Sync the run-state title to the attached target: a streaming target has no
		// agent_start incoming, so arm the loader/working title manually; an idle
		// target would otherwise inherit the previous session's stuck spinner, so
		// reset it to idle (agent_end teardown already ran via clearTransientSessionUi).
		if (target.isStreaming) await this.ctx.eventController.handleEvent({ type: "agent_start" });
		else setTerminalTitleState("idle");
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}
}
