/**
 * The two halves of making a trackpad swipe read as one gesture.
 *
 * SGR puts the wheel axis in the low bits — 64/65 vertical, 66/67 horizontal —
 * and a `button & 1` test cannot tell 65 (down) from 67 (right). A two-finger
 * swipe is never purely vertical, so the terminal interleaves horizontal
 * notches through the whole gesture; decoded as vertical they invert the scroll
 * direction mid-swipe, which is the oscillation this fixes.
 *
 * The momentum curve then has to hold a signed sub-row carry across notches
 * without letting it survive a reversal, or the tail of one flick eats the head
 * of the next.
 */
import { describe, expect, it } from "bun:test";
import { parseSgrMouse } from "../src/mouse";
import { WheelMomentum } from "../src/wheel-momentum";

const report = (button: number) => parseSgrMouse(`\x1b[<${button};40;10M`);

describe("wheel axis decoding", () => {
	it("reads vertical notches as vertical", () => {
		expect(report(64)?.wheel).toBe(-1);
		expect(report(65)?.wheel).toBe(1);
		expect(report(64)?.wheelX).toBeNull();
		expect(report(65)?.wheelX).toBeNull();
	});

	it("does not read a horizontal notch as vertical", () => {
		// 66/67 used to decode as up/down, so finger drift during a downward
		// swipe scrolled the transcript back up between real notches.
		expect(report(66)?.wheel).toBeNull();
		expect(report(67)?.wheel).toBeNull();
		expect(report(66)?.wheelX).toBe(-1);
		expect(report(67)?.wheelX).toBe(1);
	});

	it("leaves a horizontal notch inert rather than reclassifying it", () => {
		// It must not fall through into the click or hover paths either.
		for (const button of [66, 67]) {
			const event = report(button)!;
			expect(event.motion).toBeFalse();
			expect(event.leftClick).toBeFalse();
		}
	});
});

describe("wheel momentum", () => {
	it("moves the base step for an unhurried notch", () => {
		const m = new WheelMomentum();
		expect(m.rows(1, 3, 1000)).toBe(3);
		expect(m.rows(1, 3, 2000)).toBe(3);
	});

	it("covers more ground as the notches tighten, then settles back", () => {
		const m = new WheelMomentum();
		let now = 0;
		let fast = 0;
		for (let i = 0; i < 12; i++) {
			now += 10;
			fast += m.rows(1, 3, now);
		}
		const slow = new WheelMomentum();
		let slowNow = 0;
		let coasted = 0;
		for (let i = 0; i < 12; i++) {
			slowNow += 120;
			coasted += slow.rows(1, 3, slowNow);
		}
		expect(fast).toBeGreaterThan(coasted);
		// The curve is bounded: a flick stays readable rather than teleporting.
		expect(fast).toBeLessThanOrEqual(12 * 3 * 4);
		// Coasting notches are the base step, which is what the falloff lands on.
		expect(coasted).toBe(36);
	});

	it("never returns a row in the direction opposite the notch", () => {
		const m = new WheelMomentum();
		let now = 0;
		for (let i = 0; i < 40; i++) {
			now += 8;
			const direction = i % 7 === 6 ? -1 : 1;
			const rows = m.rows(direction, 3, now);
			if (rows !== 0) expect(Math.sign(rows)).toBe(direction);
		}
	});

	it("starts cold when the reader turns around mid-flick", () => {
		// Speed belongs to the gesture that just ended. Carrying it over makes the
		// first notch back the other way an accelerated leap, and carrying the
		// signed remainder over can cancel that notch outright — both of which
		// read as the transcript fighting the finger at the moment of reversal.
		const m = new WheelMomentum();
		let now = 0;
		for (let i = 0; i < 9; i++) {
			now += 20;
			expect(m.rows(1, 3, now)).toBeGreaterThan(0);
		}
		now += 20;
		expect(m.rows(-1, 3, now)).toBe(-3);
	});

	it("carries the fraction instead of dropping it", () => {
		// Twenty base-step notches must travel twenty steps, whatever the
		// multiplier did in between — truncating per notch would lose the tail.
		const m = new WheelMomentum();
		let travelled = 0;
		let now = 0;
		for (let i = 0; i < 20; i++) {
			now += 300;
			travelled += m.rows(1, 3, now);
		}
		expect(travelled).toBe(60);
	});

	it("starts a new gesture cold after the reader pauses", () => {
		const m = new WheelMomentum();
		let now = 0;
		for (let i = 0; i < 10; i++) {
			now += 8;
			m.rows(1, 3, now);
		}
		// Long silence: the next notch is a fresh nudge, not the tail of a flick.
		expect(m.rows(1, 3, now + 5000)).toBe(3);
	});

	it("collapses a terminal's duplicate reports into one physical notch", () => {
		// Ghostty emits two or more reports per physical notch a few ms apart
		// (ghostty-org/ghostty#7577). Treating each as a notch doubles every step
		// a trackpad takes on that terminal, which is the chunkiness underneath
		// the jitter.
		const doubled = new WheelMomentum();
		let now = 0;
		let total = 0;
		for (let i = 0; i < 10; i++) {
			now += 300;
			total += doubled.rows(1, 3, now);
			now += 3;
			total += doubled.rows(1, 3, now);
		}
		expect(total).toBe(30);
	});
});
