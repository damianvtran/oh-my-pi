/**
 * Startup safety net for the mobile stack.
 *
 * launchd covers the normal cases with `RunAtLoad` + `KeepAlive`. What it does
 * not cover is a crash still inside `ThrottleInterval`, a manual `bootout`, or
 * the first `omp` launched after the plists were installed. Those leave a
 * session hosting a room nothing aggregates, which from the phone looks exactly
 * like the feature being broken.
 *
 * So every interactive launch cheaply checks that both services answer and heals
 * the ones that do not. Three properties matter:
 *
 * - **It never blocks the agent.** A relay that will not start costs phone
 *   access, not your session, so nothing on the way to the prompt awaits this.
 *   `collab.autoStart` hosting *does* await it — off the critical path, in a
 *   detached chain — because a host that cannot reach the relay never retries,
 *   so starting one before the heal finishes is how a login-time session ends up
 *   permanently unreachable from the phone.
 * - **It is idempotent under a thundering herd.** Eight terminals starting at
 *   once must not restart each other's services: a job that is merely still
 *   starting is left alone, and only a job that is loaded-but-dead is kicked.
 * - **It respects `omp mobile stop`.** The install state's `enabled` flag is the
 *   user's off switch; without honouring it, a stopped stack would come back on
 *   the next launch and there would be no way to keep it down.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { waitForHealthy } from "./health";
import { bootstrapService, isDarwin, kickstartService, serviceState } from "./launchctl";
import { buildLaunchPlan } from "./service";
import { readMobileState } from "./state";
import type { MobileServiceSpec } from "./types";

/**
 * Grace for a service that is already coming up. Deliberately shorter than the
 * install-time budget: this runs while a user waits at a prompt, and a slow start
 * heals itself on the next launch anyway.
 */
const HEAL_WAIT_MS = 4_000;

/**
 * Grace for a job launchd already reports as `running`. Much longer than
 * {@link HEAL_WAIT_MS} because the process exists and is binding — at login the
 * whole stack pages in cold behind everything else macOS is starting, and the
 * relay has been seen taking the better part of twenty seconds to listen.
 * Kickstarting it in that window would restart a service that was about to work,
 * once per terminal in the login storm.
 */
const STARTING_WAIT_MS = 25_000;

/**
 * Bring one service to a state where it answers.
 *
 * Every exit path either proves the service healthy or has exhausted what this
 * process can do about it, because callers now *sequence* on it: hosting waits
 * for this to resolve, so resolving early on a service that is still starting
 * would hand the caller the same race the wait exists to close.
 */
async function healService(spec: MobileServiceSpec): Promise<void> {
	if (await waitForHealthy(spec.healthUrl, 0)) return;
	const state = await serviceState(spec.label);
	if (state === undefined) {
		// Not loaded at all — the plist exists (install wrote it) but this login
		// session never bootstrapped it.
		const result = await bootstrapService(spec.plistPath, spec.label);
		if (!result.ok) {
			logger.debug("mobile: bootstrap during heal failed", { label: spec.label, stderr: result.stderr });
			return;
		}
		await waitForHealthy(spec.healthUrl, HEAL_WAIT_MS);
		return;
	}
	// Loaded but silent. Give it the grace window first: a concurrent launch may
	// have just started it, and kickstarting a starting job is what turned eight
	// simultaneous launches into a restart storm in the pre-repo version of this.
	if (await waitForHealthy(spec.healthUrl, state === "running" ? STARTING_WAIT_MS : HEAL_WAIT_MS)) return;
	const result = await kickstartService(spec.label);
	if (!result.ok) {
		logger.debug("mobile: kickstart during heal failed", { label: spec.label, stderr: result.stderr });
		return;
	}
	// launchd returns as soon as it has accepted the restart, so without this the
	// heal resolves before the service is listening and anything sequenced behind
	// it races the very start it just asked for.
	await waitForHealthy(spec.healthUrl, HEAL_WAIT_MS);
}

/**
 * Bring both services back if they are installed, enabled and not answering.
 *
 * Returns without doing anything when the stack was never installed, was
 * deliberately stopped, or the platform has no LaunchAgents — all normal states,
 * none of them worth a warning on someone's terminal.
 */
export async function ensureMobileServices(): Promise<void> {
	if (!isDarwin()) return;
	const state = await readMobileState();
	if (!state?.enabled) return;
	const plan = buildLaunchPlan({
		relayPort: state.relayPort,
		portalPort: state.portalPort,
		launchArgv: state.launchArgv,
	});
	// Relay first: the portal is useless without it, and healing them in parallel
	// would have the portal probing a relay that is still binding.
	await healService(plan.relay);
	await healService(plan.portal);
}
