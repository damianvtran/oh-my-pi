/**
 * Scheduled wakeups — the pure half: shape, parsing, and recurrence math.
 *
 * Why this exists: an agent asked to "check the deploy at midnight" or "watch
 * this job hourly for a week" has no way to be running then. A wake is a
 * self-prompt the session delivers to itself later, so the work resumes in the
 * same conversation with the same context instead of a fresh session that has
 * to rediscover everything.
 *
 * A wake lives and dies with its session: it is persisted in the session
 * transcript (so `/resume` re-arms it) and delivered by the session's own
 * scheduler. Nothing here can wake a session that is not running — see
 * `docs/tools/wake.md` for why that boundary is deliberate rather than a gap.
 *
 * Everything in this file is clock-injected and side-effect free so the
 * recurrence rules can be tested without timers (see `ts-no-test-timers`).
 */
import { formatDuration, isRecord } from "@oh-my-pi/pi-utils";

/** A pending self-prompt. `everyMs` absent ⇒ one-shot. */
export interface WakeSchedule {
	/** Stable per-session handle (`w1`, `w2`, …) the agent cancels by. */
	id: string;
	/** Prompt text delivered to the session when this fires. */
	message: string;
	/** Epoch ms of the next delivery. */
	nextDueAt: number;
	/** Recurrence interval. Absent for a one-shot. */
	everyMs?: number;
	/** Hard stop: retire rather than fire past this epoch ms. */
	untilAt?: number;
	/** Retire after this many total deliveries. */
	limit?: number;
	/** Deliveries so far — carried in the wake text so the agent can pace itself. */
	firedCount: number;
	/** Epoch ms the schedule was created, for `list` ordering and display. */
	createdAt: number;
}

/** A delivery the scheduler wants the session to inject. */
export interface DueWake {
	schedule: WakeSchedule;
	/** 1-based delivery number, i.e. `firedCount + 1` at fire time. */
	occurrence: number;
	/** Total deliveries this schedule will make, when knowable up front. */
	plannedTotal?: number;
	/** Whether this delivery is the schedule's last. */
	final: boolean;
}

/** Why a schedule left the active list. */
export type WakeRetireReason = "limit" | "until" | "one-shot" | "cancelled";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Floor on `every`. A wake starts a full agent turn, so a sub-minute cadence
 * spends tokens faster than the turns can finish and starves the user's own
 * prompts behind the queue. One minute is already aggressive for real watches.
 */
export const MIN_WAKE_INTERVAL_MS = MIN;

/**
 * Ceiling on live schedules per session. Enough for several concurrent watches;
 * low enough that a confused agent cannot bury the session in self-prompts.
 */
export const MAX_WAKE_SCHEDULES = 16;

/** Cap on the delivered prompt. A wake is an instruction, not a payload. */
export const MAX_WAKE_MESSAGE_CHARS = 2_000;

/**
 * Grace window for a requested `at` that has already passed. Clock skew and the
 * seconds spent composing the call should not turn "at 09:00" into an error the
 * moment 09:00 has just gone by; anything older is a real mistake worth
 * reporting rather than silently firing at once.
 */
const PAST_AT_GRACE_MS = 5 * SEC;

const DURATION_UNITS: Record<string, number> = { s: SEC, m: MIN, h: HOUR, d: DAY, w: WEEK };

/**
 * Parse a duration like `45s`, `30m`, `2h`, `7d`, `1w`. A bare number is
 * rejected on purpose: `every: 60` reads as both seconds and milliseconds
 * depending on who wrote it, and guessing wrong is a runaway wake loop.
 */
export function parseWakeDuration(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(text.trim());
	if (!match) return undefined;
	const unit = DURATION_UNITS[match[2]!.toLowerCase()];
	if (unit === undefined) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.round(value * unit);
}

/**
 * Resolve a wake time. Three forms, in the order they are tried:
 *
 * - `+<duration>` — relative to now (`+90m`).
 * - `HH:MM` — the next occurrence of that local wall-clock time, today if it is
 *   still ahead, otherwise tomorrow. This is how `at: "00:00"` means midnight
 *   without anyone naming a date or a timezone.
 * - ISO-8601 — anything `Date.parse` accepts. A form carrying no offset
 *   (`2026-07-29T09:00`) is local time per the ECMAScript grammar; a trailing
 *   `Z` or `±HH:MM` pins it absolutely.
 */
export function parseWakeAt(text: string, nowMs: number): number | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;

	if (trimmed.startsWith("+")) {
		const delta = parseWakeDuration(trimmed.slice(1));
		return delta === undefined ? undefined : nowMs + delta;
	}

	const clock = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
	if (clock) {
		const hours = Number(clock[1]);
		const minutes = Number(clock[2]);
		if (hours > 23 || minutes > 59) return undefined;
		const candidate = new Date(nowMs);
		candidate.setHours(hours, minutes, 0, 0);
		// Same wall-clock time today has passed ⇒ the caller means tomorrow.
		// setDate() (not +24h) so a DST boundary keeps the requested clock time.
		if (candidate.getTime() <= nowMs) candidate.setDate(candidate.getDate() + 1);
		return candidate.getTime();
	}

	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Next unused `w<N>` handle for a session. */
export function nextWakeId(existing: readonly WakeSchedule[]): string {
	let max = 0;
	for (const schedule of existing) {
		const match = /^w(\d+)$/.exec(schedule.id);
		if (!match) continue;
		max = Math.max(max, Number(match[1]));
	}
	return `w${max + 1}`;
}

/**
 * Total deliveries a schedule will make, when that is knowable when it is
 * created: a one-shot fires once, a `limit` says so outright, and `every` +
 * `until` is arithmetic. An open-ended recurring wake returns `undefined` —
 * it runs until the goal is met and the agent cancels it.
 */
export function plannedWakeTotal(schedule: WakeSchedule): number | undefined {
	if (schedule.everyMs === undefined) return 1;
	if (schedule.limit !== undefined) return schedule.limit;
	if (schedule.untilAt === undefined) return undefined;
	const remaining = schedule.untilAt - schedule.nextDueAt;
	if (remaining < 0) return schedule.firedCount;
	return schedule.firedCount + Math.floor(remaining / schedule.everyMs) + 1;
}

/**
 * Advance a schedule past a delivery, or retire it.
 *
 * Missed occurrences are skipped rather than replayed: a laptop asleep for six
 * hours owes one hourly check, not six. This mirrors the pre-existing
 * shell-scheduler behaviour and keeps a resumed session from spending a burst
 * of turns catching up on stale samples.
 */
export function advanceWakeSchedule(
	schedule: WakeSchedule,
	nowMs: number,
): { next: WakeSchedule } | { retired: WakeRetireReason } {
	const firedCount = schedule.firedCount + 1;
	if (schedule.everyMs === undefined) return { retired: "one-shot" };
	if (schedule.limit !== undefined && firedCount >= schedule.limit) return { retired: "limit" };

	let nextDueAt = schedule.nextDueAt + schedule.everyMs;
	while (nextDueAt <= nowMs) nextDueAt += schedule.everyMs;
	if (schedule.untilAt !== undefined && nextDueAt > schedule.untilAt) return { retired: "until" };

	return { next: { ...schedule, nextDueAt, firedCount } };
}

/** Runtime guard for schedules rehydrated from a session transcript. */
export function isWakeSchedule(value: unknown): value is WakeSchedule {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || value.id.length === 0) return false;
	if (typeof value.message !== "string" || value.message.length === 0) return false;
	if (typeof value.nextDueAt !== "number" || !Number.isFinite(value.nextDueAt)) return false;
	if (typeof value.firedCount !== "number" || !Number.isFinite(value.firedCount)) return false;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
	for (const key of ["everyMs", "untilAt", "limit"] as const) {
		const field = value[key];
		if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field))) return false;
	}
	return true;
}

/** Local `HH:MM`, plus the date when the wake is not today. */
export function formatWakeClock(atMs: number, nowMs: number): string {
	const at = new Date(atMs);
	const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	const now = new Date(nowMs);
	const sameDay =
		at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
	if (sameDay) return clock;
	const month = at.toLocaleString("en-US", { month: "short" });
	return `${month} ${at.getDate()} ${clock}`;
}

/**
 * One-line human form: when it next fires, how often, and how it ends.
 * Shared by the tool result, the `/wake` listing, and the TUI renderer so all
 * three describe a schedule identically.
 */
export function describeWakeSchedule(schedule: WakeSchedule, nowMs: number): string {
	const parts: string[] = [];
	const delay = schedule.nextDueAt - nowMs;
	parts.push(delay > 0 ? `in ${formatDuration(delay)} (${formatWakeClock(schedule.nextDueAt, nowMs)})` : "now");
	if (schedule.everyMs !== undefined) parts.push(`every ${formatDuration(schedule.everyMs)}`);
	if (schedule.untilAt !== undefined) parts.push(`until ${formatWakeClock(schedule.untilAt, nowMs)}`);
	const planned = plannedWakeTotal(schedule);
	if (schedule.everyMs !== undefined && planned !== undefined) {
		parts.push(`${schedule.firedCount}/${planned} fired`);
	} else if (schedule.firedCount > 0) {
		parts.push(`${schedule.firedCount} fired`);
	}
	return parts.join(" · ");
}

/** Fields a create request carries, already string-parsed by the tool schema. */
export interface WakeCreateRequest {
	message: string;
	at?: string;
	every?: string;
	until?: string;
	limit?: number;
}

/**
 * Validate a create request into a schedule, or explain the rejection.
 *
 * Returning the error text (rather than throwing) keeps the tool's failure path
 * identical to its success path: the agent gets a sentence it can act on.
 */
export function buildWakeSchedule(
	request: WakeCreateRequest,
	existing: readonly WakeSchedule[],
	nowMs: number,
): { schedule: WakeSchedule } | { error: string } {
	const message = request.message.trim();
	if (message.length === 0) return { error: "`message` is required: it is the prompt the wake delivers." };
	if (message.length > MAX_WAKE_MESSAGE_CHARS) {
		return { error: `\`message\` is ${message.length} chars; cap is ${MAX_WAKE_MESSAGE_CHARS}.` };
	}
	if (existing.length >= MAX_WAKE_SCHEDULES) {
		return { error: `${MAX_WAKE_SCHEDULES} wakes already scheduled — cancel one before adding another.` };
	}
	if (request.at === undefined && request.every === undefined) {
		return { error: "Give `at` (one-shot) or `every` (recurring), or both to start a cadence at a set time." };
	}

	let everyMs: number | undefined;
	if (request.every !== undefined) {
		everyMs = parseWakeDuration(request.every);
		if (everyMs === undefined) {
			return { error: `Could not read \`every: "${request.every}"\` — use a duration like 30m, 4h, 1d.` };
		}
		if (everyMs < MIN_WAKE_INTERVAL_MS) {
			return { error: `\`every\` must be at least ${formatDuration(MIN_WAKE_INTERVAL_MS)}; got ${request.every}.` };
		}
	}

	let nextDueAt: number;
	if (request.at !== undefined) {
		const parsed = parseWakeAt(request.at, nowMs);
		if (parsed === undefined) {
			return { error: `Could not read \`at: "${request.at}"\` — use +30m, HH:MM, or an ISO-8601 timestamp.` };
		}
		nextDueAt = parsed;
		if (nextDueAt < nowMs - PAST_AT_GRACE_MS) {
			if (everyMs === undefined) {
				return { error: `\`at: "${request.at}"\` is in the past (${formatDuration(nowMs - nextDueAt)} ago).` };
			}
			// A cadence anchored to a past time is a legitimate way to phase a
			// watch ("hourly on the hour"): roll forward to the next live slot.
			while (nextDueAt <= nowMs) nextDueAt += everyMs;
		}
	} else {
		// `every` alone: the first check happens one interval from now, so the
		// agent's own turn covers "right now" and the wake covers "later".
		nextDueAt = nowMs + everyMs!;
	}

	let untilAt: number | undefined;
	if (request.until !== undefined) {
		untilAt = parseWakeAt(request.until, nowMs);
		if (untilAt === undefined) {
			return { error: `Could not read \`until: "${request.until}"\` — use +7d, HH:MM, or an ISO-8601 timestamp.` };
		}
		if (untilAt <= nowMs) return { error: `\`until: "${request.until}"\` is not in the future.` };
		if (untilAt < nextDueAt) {
			return {
				error: `\`until\` (${formatWakeClock(untilAt, nowMs)}) is before the first wake — nothing would fire.`,
			};
		}
	}

	if (request.limit !== undefined) {
		if (!Number.isInteger(request.limit) || request.limit < 1) {
			return { error: `\`limit\` must be a positive integer; got ${request.limit}.` };
		}
		if (everyMs === undefined && request.limit > 1) {
			return { error: "`limit` above 1 needs `every` — a one-shot fires once by definition." };
		}
	}

	const schedule: WakeSchedule = {
		id: nextWakeId(existing),
		message,
		nextDueAt,
		firedCount: 0,
		createdAt: nowMs,
	};
	if (everyMs !== undefined) schedule.everyMs = everyMs;
	if (untilAt !== undefined) schedule.untilAt = untilAt;
	if (request.limit !== undefined) schedule.limit = request.limit;
	return { schedule };
}
