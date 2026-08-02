/**
 * Turns a stream of wheel notches into a row delta that feels like a trackpad.
 *
 * A mouse wheel emits one notch per detent and a fixed step reads fine. A
 * trackpad emits a burst: dense while the fingers move, then thinning out as
 * the OS plays momentum, then stopping. Against a fixed step that burst is a
 * staircase — every notch jumps the same distance no matter how fast the
 * gesture was — so a flick and a nudge feel identical and the transcript lurches
 * rather than glides.
 *
 * Three things are needed to make it read as one continuous gesture, and every
 * one of them is a defect if left out:
 *
 * 1. **Speed sets the step.** The multiplier rises with how tightly the notches
 *    are packed, so a flick covers ground and a nudge moves a line. As the OS
 *    momentum decays the notches spread out, the multiplier falls back to one,
 *    and the scroll coasts to a stop on its own.
 * 2. **Sub-row travel is carried, not dropped.** A multiplier produces
 *    fractional rows; truncating each notch independently would quantise the
 *    whole gesture back to the base step. The remainder rolls into the next
 *    notch.
 * 3. **A reversal starts over.** The carry is signed, so a leftover fraction
 *    from an upward flick will eat the first notch of the downward one that
 *    follows — or invert it outright. opencode inherits exactly this hazard
 *    from its renderer and only escapes it by never using a fractional
 *    multiplier; a real trackpad curve has to clear the carry instead.
 *
 * Terminals also double-report: Ghostty emits two or more reports per physical
 * notch a few milliseconds apart (ghostty-org/ghostty#7577). Those must not be
 * read as blinding speed, so anything arriving inside {@link MIN_TICK_MS} still
 * scrolls but does not raise the velocity estimate.
 */

/** Reports closer together than this are one physical notch, not two. */
const MIN_TICK_MS = 6;
/** Silence longer than this ends the gesture: the next notch starts cold. */
const IDLE_MS = 220;
/** At or below this interval the gesture is running as fast as it will count. */
const FAST_TICK_MS = 16;
/** At or above this interval the gesture is deliberate and takes the base step. */
const SLOW_TICK_MS = 80;
/** How hard velocity bends the step. */
const GAIN = 0.9;
/** Ceiling on the multiplier, so a fast flick still lands somewhere readable. */
const MAX_MULTIPLIER = 4;
/** Weight of the newest interval in the smoothed velocity. */
const SMOOTHING = 0.4;

export class WheelMomentum {
	#lastAt = 0;
	#direction: -1 | 1 | 0 = 0;
	/** Signed sub-row remainder carried into the next notch of this gesture. */
	#carry = 0;
	/** Smoothed 0..1 estimate of how fast the gesture is running. */
	#velocity = 0;

	/**
	 * Whole rows to scroll for one notch in `direction`, `base` rows at rest.
	 *
	 * Returns 0 when the notch only moved the gesture a fraction of a row (the
	 * fraction is not lost, it lands on a later notch) or when the report was a
	 * duplicate of one the terminal already sent for the same physical notch.
	 */
	rows(direction: -1 | 1, base: number, now: number = Date.now()): number {
		const elapsed = now - this.#lastAt;

		if (direction !== this.#direction) {
			// The reader turned around. Anything carried belongs to the gesture
			// that just ended and would fight this one.
			this.#carry = 0;
			this.#velocity = 0;
			this.#direction = direction;
		} else if (elapsed < MIN_TICK_MS) {
			// The same physical notch, reported twice by the terminal. Counting it
			// again would double every step a trackpad takes on that terminal.
			return 0;
		} else if (elapsed >= IDLE_MS) {
			this.#carry = 0;
			this.#velocity = 0;
		} else {
			// Deliberate scrolling reads as zero speed and keeps the base step;
			// only a genuinely tight burst bends the curve.
			const span = SLOW_TICK_MS - FAST_TICK_MS;
			const instant = Math.max(0, Math.min(1, (SLOW_TICK_MS - elapsed) / span));
			this.#velocity = this.#velocity * (1 - SMOOTHING) + instant * SMOOTHING;
		}
		this.#lastAt = now;

		const multiplier = Math.min(MAX_MULTIPLIER, 1 + GAIN * (Math.exp(this.#velocity) - 1));
		this.#carry += direction * base * multiplier;
		const whole = Math.trunc(this.#carry);
		this.#carry -= whole;
		return whole;
	}

	/** Forget the gesture. Any carried fraction is dropped rather than replayed. */
	reset(): void {
		this.#lastAt = 0;
		this.#direction = 0;
		this.#carry = 0;
		this.#velocity = 0;
	}
}
