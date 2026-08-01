/**
 * One-row footer shown while the view is drilled into a subagent.
 *
 * It answers "where am I and how do I get out": the agent label, its position
 * among its siblings, and three chips that run the same actions as the
 * `app.session.parent` / `app.session.sibling.*` keys, each showing the key
 * actually bound to it. Deliberately one row with no border and no panel — the
 * drill-down is a mode, not a workspace, and permanent chrome would cost a
 * transcript line on every frame.
 *
 * State is pulled per frame rather than pushed, so no caller has to remember to
 * resync it after a focus change or a sibling spawning mid-turn. It renders
 * nothing at all on the main session, and its chips are pointer affordances
 * only: append mode publishes no zones and loses nothing but the clicks.
 */
import type { Component, HitZoneProvider, HitZoneSink, MouseZoneTarget } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { formatKeyHint, type KeyId } from "../../config/keybindings";
import { theme } from "../theme/theme";

/** What a chip does when clicked, matching the keybinding it mirrors. */
export type SubagentNavAction = "parent" | "sibling.prev" | "sibling.next";

/** The viewed agent's identity, or `agentId: undefined` for the main session. */
export interface SubagentFooterState {
	readonly agentId: string | undefined;
	/** Human label for the agent; the id is a reasonable fallback. */
	readonly label: string;
	/** 1-based position among siblings. */
	readonly position: number;
	readonly siblingCount: number;
}

export interface SubagentFooterDeps {
	state(): SubagentFooterState;
	navigate(action: SubagentNavAction): void;
	/** Configured keys for an action, so the hint shows what the user bound. */
	keysFor(action: SubagentNavAction): KeyId[];
}

const CHIPS: readonly { action: SubagentNavAction; label: string }[] = [
	{ action: "parent", label: "Parent" },
	{ action: "sibling.prev", label: "Prev" },
	{ action: "sibling.next", label: "Next" },
];

/** Separator between chips, and the lead-in before the first one. */
const CHIP_GAP = "  ";

export class SubagentFooter implements Component, HitZoneProvider {
	#hovered: SubagentNavAction | undefined;
	/** Chip column spans of the last render, for {@link publishHitZones}. */
	#spans: { action: SubagentNavAction; start: number; end: number }[] = [];
	readonly #targets: ReadonlyMap<SubagentNavAction, MouseZoneTarget>;

	constructor(private deps: SubagentFooterDeps) {
		this.#targets = new Map(
			CHIPS.map(chip => [
				chip.action,
				{
					zoneKey: `subagent-footer:${chip.action}`,
					onZoneClick: () => {
						this.deps.navigate(chip.action);
						return true;
					},
					onZoneHover: (hovered: boolean) => {
						// Moving between chips delivers the leave after the enter, so
						// only drop a hover this chip still owns.
						if (!hovered && this.#hovered !== chip.action) return false;
						const next = hovered ? chip.action : undefined;
						if (this.#hovered === next) return false;
						this.#hovered = next;
						return true;
					},
				} satisfies MouseZoneTarget,
			]),
		);
	}

	render(width: number): readonly string[] {
		this.#spans = [];
		const { agentId, label, position, siblingCount } = this.deps.state();
		if (!agentId) {
			this.#hovered = undefined;
			return [];
		}

		const chips = CHIPS.map(chip => {
			const hint = this.deps.keysFor(chip.action)[0];
			const hintLabel = hint ? formatKeyHint(hint) : undefined;
			return {
				action: chip.action,
				painted: hintLabel
					? `${theme.fg("text", chip.label)} ${theme.interactiveHint(hintLabel)}`
					: theme.fg("text", chip.label),
				width: visibleWidth(hintLabel ? `${chip.label} ${hintLabel}` : chip.label),
			};
		});

		let identity = `${theme.styledSymbol("tool.task", "accent")} ${theme.fg("accent", theme.bold(label))}`;
		if (siblingCount > 1) identity += ` ${theme.fg("muted", `(${position} of ${siblingCount})`)}`;

		// A chip painted at the wrong column would take clicks meant for its
		// neighbour, so a viewport too narrow for both halves drops the identity
		// text outright rather than truncating anything into the chip strip.
		const chipWidth = chips.reduce((total, chip) => total + chip.width + CHIP_GAP.length, 0);
		const keepIdentity = visibleWidth(identity) + chipWidth <= width;
		let row = keepIdentity ? identity : "";
		let column = keepIdentity ? visibleWidth(identity) : 0;
		for (const chip of chips) {
			column += CHIP_GAP.length;
			this.#spans.push({ action: chip.action, start: column, end: column + chip.width });
			row += `${CHIP_GAP}${this.#hovered === chip.action ? theme.hoverBg(chip.painted) : chip.painted}`;
			column += chip.width;
		}
		return [row];
	}

	publishHitZones(sink: HitZoneSink): void {
		for (const span of this.#spans) {
			const target = this.#targets.get(span.action);
			if (target) sink.zone(target, 0, 1, span.start, span.end);
		}
	}
}
