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
 *   access, not your session, so this runs unawaited and swallows everything.
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
	if (await waitForHealthy(spec.healthUrl, HEAL_WAIT_MS)) return;
	const result = await kickstartService(spec.label);
	if (!result.ok) logger.debug("mobile: kickstart during heal failed", { label: spec.label, stderr: result.stderr });
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
