/**
 * Scheduled wakeups — persistence and the delivered-message contract.
 *
 * Schedules live in the session transcript as a `custom` entry rather than in a
 * side file, for the same reason todo phases do: the transcript is what
 * `/resume`, `--resume`, fork and tree navigation already restore, so a wake
 * follows the conversation it belongs to with no second source of truth to keep
 * in sync. The entry does not enter LLM context (`CustomEntry` is ignored by
 * `buildSessionContext`) — only the wake message itself does, when it fires.
 */
import { formatDuration, isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import { type DueWake, isWakeSchedule, type WakeSchedule } from "./schedule";

/** `CustomEntry.customType` holding the session's active schedule list. */
export const WAKE_SCHEDULES_CUSTOM_TYPE = "wake_schedules";

/** `CustomMessage.customType` of a delivered wake, for TUI dispatch. */
export const WAKE_PROMPT_MESSAGE_TYPE = "wake-prompt";

/** Structured metadata carried by a delivered wake, for rendering. */
export interface WakePromptDetails {
	/** Schedule handle, so the rendered card and the agent name the same wake. */
	id: string;
	/** 1-based delivery number. */
	occurrence: number;
	/** Total planned deliveries, when the schedule has a knowable end. */
	plannedTotal?: number;
	/** Recurrence interval in ms, when recurring. */
	everyMs?: number;
	/** Whether this was the schedule's final delivery. */
	final?: boolean;
	/** Internal: compact label for the queued-message chip (stripped on persist). */
	__queueChipText?: string;
}

/**
 * Latest persisted schedule list on this branch, or `[]`.
 *
 * Scans backward and stops at the first hit: each change appends a full
 * snapshot, so the newest entry is authoritative and older ones are history.
 * Malformed rows are dropped individually — a hand-edited or partially written
 * transcript should cost the schedules it broke, not the whole list.
 */
export function getLatestWakeSchedulesFromEntries(entries: readonly SessionEntry[]): WakeSchedule[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== WAKE_SCHEDULES_CUSTOM_TYPE) continue;
		if (!isRecord(entry.data) || !Array.isArray(entry.data.schedules)) return [];
		return entry.data.schedules.filter(isWakeSchedule);
	}
	return [];
}

/**
 * The text a fired wake delivers: one envelope line, then the agent's own
 * message verbatim.
 *
 * The envelope exists so the model can tell a scheduled arrival from something
 * the user just typed, and so a recurring wake always carries the handle needed
 * to end it — an agent that has to guess its own wake id cannot honour "stop
 * when the goal is met". It stays one line because it is repeated on every
 * single delivery.
 */
export function formatWakeDeliveryText(wake: DueWake): string {
	const { schedule, occurrence, plannedTotal, final } = wake;
	const facts: string[] = [];
	if (schedule.everyMs === undefined) {
		facts.push("one-shot");
	} else {
		facts.push(plannedTotal === undefined ? `delivery ${occurrence}` : `${occurrence}/${plannedTotal}`);
		facts.push(final ? "final delivery" : `every ${formatDuration(schedule.everyMs)}`);
	}
	const header = `⏰ Scheduled wake ${schedule.id} (${facts.join(", ")})`;
	// A finished schedule is already gone from the list, so offering `cancel`
	// would send the agent after a handle that no longer resolves.
	const hint =
		schedule.everyMs !== undefined && !final
			? ` — cancel with \`wake({op:"cancel",id:"${schedule.id}"})\` once its goal is met.`
			: ".";
	return `${header}${hint}\n\n${schedule.message}`;
}

/** Compact label for the queued-message chip when a wake lands mid-turn. */
export function formatWakeChipText(wake: DueWake): string {
	return `⏰ wake ${wake.schedule.id}`;
}
