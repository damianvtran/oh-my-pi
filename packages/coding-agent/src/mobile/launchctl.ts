/**
 * `launchctl` and `security` wrappers for the mobile stack.
 *
 * Both are macOS-only and both are spawned rather than called through an API
 * because macOS exposes no other supported entry point: there is no launchd IPC
 * for user agents and no Keychain binding in this runtime. Every call therefore
 * goes through `ptree.exec` with a timeout and captured stderr, tolerates a
 * non-zero exit (a missing job is a state, not a crash), and never puts a secret
 * in argv — argv is world-readable through `ps`.
 */

import * as os from "node:os";
import { logger, ptree } from "@oh-my-pi/pi-utils";
import { KEYCHAIN_SERVICE } from "./paths";

const LAUNCHCTL = "/bin/launchctl";
const SECURITY = "/usr/bin/security";
/** launchctl is fast when it works; a hang means a wedged domain, not slow work. */
const LAUNCHCTL_TIMEOUT_MS = 15_000;
const SECURITY_TIMEOUT_MS = 10_000;

export interface CommandOutcome {
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

export function isDarwin(): boolean {
	return process.platform === "darwin";
}

/** `gui/<uid>` — the per-user launchd domain that owns LaunchAgents. */
export function guiDomain(): string {
	return `gui/${process.getuid?.() ?? os.userInfo().uid}`;
}

async function run(command: string[], timeoutMs: number, stdin?: string): Promise<CommandOutcome> {
	const result = await ptree.exec(command, {
		signal: ptree.combineSignals(timeoutMs),
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
		...(stdin === undefined ? {} : { stdin }),
	});
	return {
		ok: result.exitCode === 0,
		// `exitCode` is null when the child was killed by a signal (our own timeout
		// abort, in practice). -1 keeps the field a number for callers that only
		// compare it against launchd's documented codes.
		exitCode: result.exitCode ?? -1,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	};
}

/**
 * launchd exit codes we branch on. `bootstrap` on an already-loaded job reports
 * `EEXIST`; `bootout` on a job that is not loaded reports `ESRCH`, which is the
 * desired end state rather than a failure.
 */
export const LAUNCHD_EEXIST = 5;
export const LAUNCHD_ESRCH = 3;

/**
 * Load a plist into the user domain, retrying while launchd still reports the
 * old job.
 *
 * `bootout` returns as soon as launchd has *accepted* the unload, not when the
 * job is gone, so a reload that boots out and immediately bootstraps loses the
 * race and fails with `EEXIST` — leaving the service down, which is how this was
 * found. Waiting for the label to disappear (and retrying anyway) makes a reload
 * deterministic.
 */
export async function bootstrapService(plistPath: string, label?: string): Promise<CommandOutcome> {
	let last = await run([LAUNCHCTL, "bootstrap", guiDomain(), plistPath], LAUNCHCTL_TIMEOUT_MS);
	if (last.ok || last.exitCode !== LAUNCHD_EEXIST || !label) return last;
	for (let attempt = 0; attempt < 20 && last.exitCode === LAUNCHD_EEXIST; attempt++) {
		await new Promise<void>(resolve => setTimeout(resolve, 100));
		if ((await serviceState(label)) !== undefined) continue;
		last = await run([LAUNCHCTL, "bootstrap", guiDomain(), plistPath], LAUNCHCTL_TIMEOUT_MS);
	}
	return last;
}

/**
 * Unload a job and wait for launchd to forget it, so a following `bootstrap`
 * cannot race the teardown. An unloaded job reports `ESRCH`, treated as success.
 */
export async function bootoutService(label: string): Promise<CommandOutcome> {
	const result = await run([LAUNCHCTL, "bootout", `${guiDomain()}/${label}`], LAUNCHCTL_TIMEOUT_MS);
	for (let attempt = 0; attempt < 30; attempt++) {
		if ((await serviceState(label)) === undefined) break;
		await new Promise<void>(resolve => setTimeout(resolve, 100));
	}
	return result;
}

/** Restart a loaded job in place (`-k` kills the running instance first). */
export function kickstartService(label: string): Promise<CommandOutcome> {
	return run([LAUNCHCTL, "kickstart", "-k", `${guiDomain()}/${label}`], LAUNCHCTL_TIMEOUT_MS);
}

/**
 * launchd's own state word for a job (`running`, `waiting`, `not running`, …),
 * or undefined when the job is not loaded at all. Parsed out of `launchctl
 * print`, which has no machine-readable mode — the one line we need is stable
 * across macOS releases, so a regex on it beats parsing the whole dump.
 */
export async function serviceState(label: string): Promise<string | undefined> {
	const result = await run([LAUNCHCTL, "print", `${guiDomain()}/${label}`], LAUNCHCTL_TIMEOUT_MS);
	if (!result.ok) return undefined;
	const match = /^\s*state\s*=\s*(.+)$/m.exec(result.stdout);
	return match?.[1]?.trim() ?? "loaded";
}

/**
 * Read the portal password from the login Keychain.
 *
 * The value arrives on stdout, never in argv. A missing item is not an error:
 * `install` creates one, and `serve` turns the absence into an actionable
 * message instead of starting an unauthenticated portal.
 */
export async function readKeychainPassword(account: string = os.userInfo().username): Promise<string | undefined> {
	const result = await run(
		[SECURITY, "find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
		SECURITY_TIMEOUT_MS,
	);
	if (!result.ok) return undefined;
	const password = result.stdout;
	return password.length > 0 ? password : undefined;
}

/**
 * Store (or replace) the portal password.
 *
 * `security add-generic-password -w <value>` would put the secret in argv, where
 * any process on the machine can read it out of `ps` for the lifetime of the
 * call. `security -i` instead reads a command line from stdin, so the argv is
 * just `security -i` and the secret only ever exists on a pipe. The value is
 * quoted for that mini-shell: it is generated base64 here, but a
 * user-supplied one must not be able to inject a second command.
 */
export async function writeKeychainPassword(
	password: string,
	account: string = os.userInfo().username,
): Promise<CommandOutcome> {
	const quoted = `"${password.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	const command = `add-generic-password -a ${JSON.stringify(account)} -s ${JSON.stringify(KEYCHAIN_SERVICE)} -w ${quoted} -U\n`;
	const result = await run([SECURITY, "-i"], SECURITY_TIMEOUT_MS, command);
	if (!result.ok) logger.warn("mobile: failed to store portal password", { exitCode: result.exitCode });
	return result;
}

/** Remove the stored portal password. A missing item counts as removed. */
export async function deleteKeychainPassword(account: string = os.userInfo().username): Promise<CommandOutcome> {
	return run([SECURITY, "delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], SECURITY_TIMEOUT_MS);
}

/**
 * Generate a portal password: 36 random bytes, base64. Long enough that the
 * form login is not worth attacking even without rate limiting, and printable so
 * a password manager on the phone can hold it.
 */
export function generatePortalPassword(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(36))).toString("base64");
}
