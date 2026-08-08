/**
 * A block of pre-rendered rows where some rows stand for a live subagent, and
 * those rows are drillable.
 *
 * Two surfaces outside the transcript list running agents — the anchored
 * "Subagents" HUD above the composer, and the `hub` job tree a blocking wait
 * prints — and both were dead text. The task tool's inline agent rows have been
 * clickable since the drill-down landed, so the same gesture failing on the two
 * views that give the *holistic* picture of outstanding work is the wrong way
 * round: those are exactly where you look when you want to jump into an agent.
 *
 * This is deliberately a thin wrapper over already-styled lines rather than a
 * row model. Both callers build their rows through `renderTreeList` with their
 * own connectors, truncation and per-status colouring; re-expressing that as
 * structured data to get a click target would mean two renderers to keep in
 * step. Instead the caller says "line N belongs to agent X" and this owns the
 * hover wash, the zones and the focus call.
 *
 * @see task/render.ts `TaskAgentBlock` — the same contract for inline task
 * blocks, whose `zoneKey` namespace (`task-agent:`) is deliberately distinct so
 * a HUD row and a transcript row for one agent are separate hover targets.
 */
import type { Component, HitZoneProvider, HitZoneSink, MouseZoneTarget } from "@oh-my-pi/pi-tui";
import { padToWidth } from "../../tui/utils";
import { SessionFocusController } from "../controllers/session-focus-controller";
import { theme } from "../theme/theme";

/** Marks `line` (0-based, into the rows handed to {@link AgentRowList.setRows}) as agent `agentId`'s row. */
export interface AgentRowAnchor {
	readonly line: number;
	readonly agentId: string;
}

export class AgentRowList implements Component, HitZoneProvider {
	#rows: readonly string[] = [];
	#anchors: readonly AgentRowAnchor[] = [];
	#hoveredAgentId: string | undefined;
	/** Keyed so hover survives the re-render a hover itself triggers. */
	readonly #zones = new Map<string, MouseZoneTarget>();
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	/**
	 * @param keyspace Distinguishes this list's zones from every other list's,
	 *   so two surfaces showing the same agent do not collide on `zoneKey`.
	 * @param paddingX Columns of inset, matching the `Text` block each caller
	 *   previously used so the rows do not move when they become clickable.
	 */
	constructor(
		private readonly keyspace: string,
		private readonly paddingX = 1,
	) {}

	setRows(rows: readonly string[], anchors: readonly AgentRowAnchor[]): void {
		this.#rows = rows;
		this.#anchors = anchors;
		// Drop a hover pointing at an agent this content no longer lists,
		// otherwise the wash would stick to whatever row inherits that index.
		if (this.#hoveredAgentId && !anchors.some(a => a.agentId === this.#hoveredAgentId)) {
			this.#hoveredAgentId = undefined;
		}
		this.invalidate();
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === width) return this.#cachedLines;
		const pad = " ".repeat(this.paddingX);
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const hoveredLines = new Set<number>();
		if (this.#hoveredAgentId !== undefined) {
			for (const anchor of this.#anchors) {
				if (anchor.agentId === this.#hoveredAgentId) hoveredLines.add(anchor.line);
			}
		}
		const out = this.#rows.map((row, i) =>
			// The wash spans the whole interior because the zone does: a
			// highlight stopping at the end of the text would not match its
			// own click target.
			hoveredLines.has(i) ? pad + theme.hoverBg(padToWidth(row, contentWidth)) : pad + row,
		);
		this.#cachedLines = out;
		this.#cachedWidth = width;
		return out;
	}

	publishHitZones(sink: HitZoneSink): void {
		for (const anchor of this.#anchors) {
			if (!AgentRowList.#canFocus(anchor.agentId)) continue;
			sink.zone(this.#zoneTarget(anchor.agentId), anchor.line, 1);
		}
	}

	/** Only agents the focus controller can actually enter get a target: a row
	 *  that highlights and then does nothing on click is worse than dead text. */
	static #canFocus(agentId: string): boolean {
		return SessionFocusController.active()?.canFocus(agentId) === true;
	}

	#zoneTarget(agentId: string): MouseZoneTarget {
		const existing = this.#zones.get(agentId);
		if (existing) return existing;
		const target: MouseZoneTarget = {
			zoneKey: `${this.keyspace}:${agentId}`,
			pointerShape: "pointer",
			onZoneClick: () => {
				const focus = SessionFocusController.active();
				if (!focus?.canFocus(agentId)) return false;
				void focus.focusAgent(agentId);
				return true;
			},
			onZoneHover: hovered => {
				const next = hovered ? agentId : undefined;
				// A move between two rows delivers the leave after the enter, so
				// only drop a hover this row still owns.
				if (!hovered && this.#hoveredAgentId !== agentId) return false;
				if (this.#hoveredAgentId === next) return false;
				this.#hoveredAgentId = next;
				this.invalidate();
				return true;
			},
		};
		this.#zones.set(agentId, target);
		return target;
	}
}
