/**
 * Names and locations owned by the mobile stack.
 *
 * State lives at `<config-root>/run/mobile/`, the same `run/` namespace as the
 * project brokers (`launch/paths.ts`) and the collab link records
 * (`collab/link-file.ts`), so it follows `PI_CONFIG_DIR` and `--profile` and one
 * profile never manages another profile's services.
 *
 * launchd is not profile-aware, so the job labels are not either: one machine
 * runs one relay and one portal. A second profile that wants its own pair has to
 * pass different ports and would collide on the labels — that is deliberate, and
 * `omp mobile status` reports the ports actually installed rather than assuming
 * the defaults.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";
import type { MobileServiceName } from "./types";

/** Reverse-DNS launchd labels under omp's own domain. */
export const RELAY_LABEL = "sh.omp.mobile-relay";
export const PORTAL_LABEL = "sh.omp.mobile-portal";

export const SERVICE_LABELS: Record<MobileServiceName, string> = {
	relay: RELAY_LABEL,
	portal: PORTAL_LABEL,
};

/**
 * Label prefix for the transient launchd jobs that host phone-started sessions.
 *
 * Shared rather than inlined at the submit site because the labels have to be
 * findable later: the job removes its own label on exit, but a SIGKILL skips
 * that, and a stale label lingers in the user domain until something sweeps it.
 */
export const SESSION_JOB_LABEL_PREFIX = "sh.omp.mobile-session.";

/**
 * Keychain generic-password service holding the portal password, keyed by the
 * local account. Named without a version or profile suffix on purpose: rotating
 * the password must not silently strand a phone on a stale credential.
 */
export const KEYCHAIN_SERVICE = "omp-mobile";

/** Portal login username. Fixed unless `omp mobile install --username` overrides it. */
export const DEFAULT_PORTAL_USERNAME = "omp";

export const DEFAULT_PORTAL_PORT = 4097;
export const DEFAULT_RELAY_PORT = 7466;

/** `<config-root>/run/mobile` — profile-scoped install state. */
export function mobileRuntimeDir(configRoot: string = getConfigRootDir()): string {
	return path.join(configRoot, "run", "mobile");
}

/** `<config-root>/run/mobile/state.json` — see {@link MobileState}. */
export function mobileStateFile(configRoot?: string): string {
	return path.join(mobileRuntimeDir(configRoot), "state.json");
}

export function launchAgentsDir(homeDir: string = os.homedir()): string {
	return path.join(homeDir, "Library", "LaunchAgents");
}

export function launchAgentPlistPath(label: string, homeDir?: string): string {
	return path.join(launchAgentsDir(homeDir), `${label}.plist`);
}

/**
 * launchd writes a job's output to files it opens itself, so the paths are part
 * of the installed contract rather than something the service chooses.
 */
export function serviceLogPaths(label: string, homeDir: string = os.homedir()): { stdout: string; stderr: string } {
	const dir = path.join(homeDir, "Library", "Logs");
	return { stdout: path.join(dir, `${label}.out.log`), stderr: path.join(dir, `${label}.err.log`) };
}

/** Relay port carried by a `collab.relayUrl`, or undefined when it is not a loopback ws URL. */
export function relayPortFromUrl(relayUrl: string): number | undefined {
	if (!relayUrl) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(relayUrl);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return undefined;
	if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "::1") {
		return undefined;
	}
	if (parsed.port) return Number(parsed.port);
	return parsed.protocol === "wss:" ? 443 : 80;
}
