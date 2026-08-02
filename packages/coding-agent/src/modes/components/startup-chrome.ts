/**
 * The startup chrome run: the welcome box, the changelog card, and the spacers
 * that separate them from the transcript.
 *
 * Grouped into one container purely so it can be taken off screen as a unit
 * while the main view is drilled into a subagent. That banner describes how
 * THIS session started — the version, the model, recent sessions to resume —
 * and none of it is true of the agent whose transcript is now underneath it.
 * Sitting directly above a subagent's first prompt it reads as that agent's own
 * header, which is both wrong and the first thing you have to scroll past to
 * reach the assignment you opened the agent to read.
 *
 * Hidden rather than unmounted: popping back to the main session restores the
 * view the user left, and rebuilding a welcome box (with its recent-session
 * list and LSP probe) to do that would be both slower and a different banner.
 */
import { Container } from "@oh-my-pi/pi-tui";

const NO_ROWS: readonly string[] = [];

export class StartupChrome extends Container {
	#hidden = false;

	/** Returns true when the visibility actually changed, so callers can skip a repaint. */
	setHidden(hidden: boolean): boolean {
		if (this.#hidden === hidden) return false;
		this.#hidden = hidden;
		this.invalidate();
		return true;
	}

	override render(width: number): readonly string[] {
		if (this.#hidden) return NO_ROWS;
		return super.render(width);
	}
}
