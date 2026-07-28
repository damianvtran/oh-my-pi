/**
 * Installed-state record for the mobile stack.
 *
 * The ports and the launch argv are chosen at install time, and every later
 * command needs them: `status` must probe the ports actually installed rather
 * than the defaults, `update` rewrites the plists from them, and the startup
 * healer needs to know which endpoints to poll. Keeping them in one 0600 file
 * under `<config-root>/run/mobile/` means none of that has to re-derive state or
 * parse a plist back.
 *
 * `enabled` is the off switch. Without it the healer would resurrect services
 * the user deliberately stopped on the very next `omp` launch, which is
 * infuriating and impossible to debug from the outside.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { mobileRuntimeDir, mobileStateFile } from "./paths";
import type { MobileState } from "./types";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function isMobileState(value: unknown): value is MobileState {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.enabled === "boolean" &&
		typeof record.relayPort === "number" &&
		typeof record.portalPort === "number" &&
		typeof record.username === "string" &&
		Array.isArray(record.launchArgv) &&
		record.launchArgv.every(entry => typeof entry === "string")
	);
}

/**
 * Read the install record, or undefined when the stack was never installed for
 * this profile. A corrupt file is treated as absent and logged: the recovery is
 * `omp mobile install`, not a crash on a management command.
 */
export async function readMobileState(configRoot?: string): Promise<MobileState | undefined> {
	const file = mobileStateFile(configRoot);
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		if (!isMobileState(parsed)) {
			logger.warn("mobile: ignoring malformed install state", { file });
			return undefined;
		}
		return parsed;
	} catch (err) {
		if (!isEnoent(err)) logger.warn("mobile: failed to read install state", { file, error: String(err) });
		return undefined;
	}
}

/**
 * Write the install record. Staged and renamed so a concurrent reader never sees
 * a half-written file, and the directory is created 0700 with an explicit chmod
 * because creation modes are masked by the umask and a directory left by an
 * earlier run keeps whatever permissions it already had.
 */
export async function writeMobileState(state: MobileState, configRoot?: string): Promise<void> {
	const dir = mobileRuntimeDir(configRoot);
	const file = mobileStateFile(configRoot);
	const staged = `${file}.tmp`;
	await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
	await fs.chmod(dir, DIR_MODE);
	await fs.rm(staged, { force: true });
	await fs.writeFile(staged, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: FILE_MODE });
	await fs.chmod(staged, FILE_MODE);
	await fs.rename(staged, file);
}

/** Flip the healer's off switch, leaving the rest of the record intact. */
export async function setMobileEnabled(enabled: boolean, configRoot?: string): Promise<MobileState | undefined> {
	const current = await readMobileState(configRoot);
	if (!current) return undefined;
	const next: MobileState = { ...current, enabled, updatedAt: new Date().toISOString() };
	await writeMobileState(next, configRoot);
	return next;
}

/** Remove the install record (uninstall). Missing is success. */
export async function clearMobileState(configRoot?: string): Promise<void> {
	await fs.rm(mobileStateFile(configRoot), { force: true });
	await fs.rm(path.join(mobileRuntimeDir(configRoot), "state.json.tmp"), { force: true });
}
