/**
 * Scheduled wakeups — the live half: when to fire, and firing exactly once.
 *
 * The scheduler owns the session's active schedules and a single armed timer.
 * It never talks to the model or the transcript itself; the session hands it a
 * `deliver` callback (which injects the self-prompt) and a `persist` callback
 * (which writes the list to the transcript so `/resume` re-arms it).
 *
 * Two properties are load-bearing:
 *
 * - **The timer never holds the process open.** It is `unref`'d, so a pending
 *   wake cannot keep a finished `omp -p` run alive. A wake is a promise to the
 *   *session*, not to the machine: if the session exits, the wake is gone, and
 *   the persisted record simply re-arms if that session is resumed.
 * - **Long horizons re-check instead of sleeping through.** A wake a week out
 *   arms a one-minute tick rather than a 604,800,000 ms timeout, so laptop
 *   sleep, clock adjustments, and timezone changes are absorbed by re-reading
 *   the wall clock rather than by trusting a timer that was set days ago.
 *
 * `pump()` is deliberately separable from arming: tests drive it with an
 * injected clock and never touch real timers (`ts-no-test-timers`).
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	advanceWakeSchedule,
	type DueWake,
	plannedWakeTotal,
	type WakeRetireReason,
	type WakeSchedule,
} from "./schedule";

/**
 * Longest a single armed timer may cover. Bounded so that a distant wake keeps
 * re-deriving its delay from the wall clock (see the sleep/clock note above)
 * and so no timer approaches the 2^31-1 ms ceiling.
 */
const MAX_ARM_MS = 60_000;

/** Smallest armed delay. Avoids a zero-delay timer re-entering `pump` in a tight loop. */
const MIN_ARM_MS = 25;

/**
 * How long after adopting persisted schedules the first delivery is held back.
 *
 * Resuming a session whose wake came due while it was closed must still fire —
 * but not during startup: the session is constructed before the TUI subscribes
 * to its events, so a wake delivered immediately would be persisted and
 * replayed from history instead of appearing live in the conversation the user
 * is watching. Two seconds is long enough for any mode to finish attaching and
 * short enough that an overdue wake still reads as immediate.
 */
const LOAD_GRACE_MS = 2_000;

export interface WakeSchedulerOptions {
	/** Injected clock. Tests supply a fake; production uses `Date.now`. */
	now?: () => number;
	/** Inject one due self-prompt into the session. Must not throw. */
	deliver: (wake: DueWake) => void;
	/** Persist the current list so a resumed session re-arms it. */
	persist: (schedules: WakeSchedule[]) => void;
	/** Ambient notice hook for a schedule leaving the list on its own. */
	onRetire?: (schedule: WakeSchedule, reason: WakeRetireReason) => void;
	/**
	 * Injected timer primitives. Tests substitute a manual driver so the arm /
	 * re-arm behaviour is asserted without real timers (`ts-no-test-timers`) —
	 * an empty pump re-arming for a future wake is exactly the behaviour a
	 * pump-driven suite cannot see.
	 */
	setTimer?: (callback: () => void, delayMs: number) => Timer;
	clearTimer?: (timer: Timer) => void;
}

export class WakeScheduler {
	readonly #now: () => number;
	readonly #deliver: (wake: DueWake) => void;
	readonly #persist: (schedules: WakeSchedule[]) => void;
	readonly #onRetire?: (schedule: WakeSchedule, reason: WakeRetireReason) => void;
	readonly #setTimer: (callback: () => void, delayMs: number) => Timer;
	readonly #clearTimerFn: (timer: Timer) => void;
	#schedules: WakeSchedule[] = [];
	#timer: Timer | undefined;
	#disposed = false;
	/** Earliest a delivery may be armed for; raised by {@link load}. */
	#armFloorAt = 0;

	constructor(options: WakeSchedulerOptions) {
		this.#now = options.now ?? Date.now;
		this.#deliver = options.deliver;
		this.#persist = options.persist;
		this.#onRetire = options.onRetire;
		this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.#clearTimerFn = options.clearTimer ?? (timer => clearTimeout(timer));
	}

	get schedules(): readonly WakeSchedule[] {
		return this.#schedules;
	}

	/**
	 * Adopt schedules read back from a transcript. No persist: this *is* the
	 * persisted state, and re-writing it on every session load would append a
	 * duplicate entry per resume.
	 */
	load(schedules: readonly WakeSchedule[]): void {
		this.#schedules = [...schedules];
		// A wake that came due while this session was closed fires shortly after
		// the load rather than inside it — see LOAD_GRACE_MS.
		this.#armFloorAt = this.#now() + LOAD_GRACE_MS;
		this.#arm();
	}

	/** Replace the list after a caller-driven change (create, cancel), and persist it. */
	update(schedules: readonly WakeSchedule[]): void {
		this.#schedules = [...schedules];
		this.#persist(this.#schedules);
		this.#arm();
	}

	/**
	 * Deliver every schedule due at `nowMs` and return the next due time.
	 *
	 * Overdue schedules fire once, not once per missed interval — see
	 * `advanceWakeSchedule`. A delivery that throws still advances the schedule:
	 * leaving it due would turn one broken wake into a hot loop.
	 */
	pump(nowMs: number = this.#now()): number | undefined {
		if (this.#disposed) return undefined;
		const due = this.#schedules.filter(schedule => schedule.nextDueAt <= nowMs);
		if (due.length === 0) {
			// An intermediate re-check tick (MAX_ARM_MS) lands here: nothing is due
			// yet, but the future wake still needs a timer, or the scheduler goes
			// silent until the next load/update. Arming is cheap and idempotent.
			this.#arm();
			return this.#nextDueAt();
		}

		const kept: WakeSchedule[] = this.#schedules.filter(schedule => schedule.nextDueAt > nowMs);
		const retired: Array<{ schedule: WakeSchedule; reason: WakeRetireReason }> = [];
		for (const schedule of due) {
			const outcome = advanceWakeSchedule(schedule, nowMs);
			const occurrence = schedule.firedCount + 1;
			const plannedTotal = plannedWakeTotal(schedule);
			const wake: DueWake = { schedule, occurrence, final: "retired" in outcome };
			if (plannedTotal !== undefined) wake.plannedTotal = plannedTotal;
			try {
				this.#deliver(wake);
			} catch (error) {
				logger.warn("wake delivery failed", { id: schedule.id, error: String(error) });
			}
			if ("next" in outcome) kept.push(outcome.next);
			else retired.push({ schedule, reason: outcome.retired });
		}

		// Keep the list in creation order so `list` output and ids stay stable
		// across fires rather than reordering by whatever happened to be due.
		kept.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		this.#schedules = kept;
		this.#persist(this.#schedules);
		for (const { schedule, reason } of retired) this.#onRetire?.(schedule, reason);
		this.#arm();
		return this.#nextDueAt();
	}

	/** Drop the timer. The persisted record survives; a resumed session re-arms. */
	dispose(): void {
		this.#disposed = true;
		this.#clearTimer();
		this.#schedules = [];
	}

	#nextDueAt(): number | undefined {
		let earliest: number | undefined;
		for (const schedule of this.#schedules) {
			if (earliest === undefined || schedule.nextDueAt < earliest) earliest = schedule.nextDueAt;
		}
		return earliest;
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		this.#clearTimerFn(this.#timer);
		this.#timer = undefined;
	}

	#arm(): void {
		this.#clearTimer();
		if (this.#disposed) return;
		const next = this.#nextDueAt();
		if (next === undefined) return;
		const now = this.#now();
		// The floor keeps a startup-time overdue wake from firing before the UI
		// is listening; MAX_ARM_MS keeps a distant one re-checking the clock.
		const target = Math.max(next, this.#armFloorAt);
		const delay = Math.min(MAX_ARM_MS, Math.max(MIN_ARM_MS, target - now));
		const timer = this.#setTimer(() => {
			this.#timer = undefined;
			// Re-derive due-ness from the clock: this tick may be the real
			// deadline, an intermediate re-check, or a late wake after sleep.
			this.pump();
		}, delay);
		// Never keep the event loop alive for a wake (see the header note).
		timer.unref?.();
		this.#timer = timer;
	}
}
