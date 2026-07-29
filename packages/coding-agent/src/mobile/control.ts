/**
 * Spawning new omp sessions from the phone.
 *
 * The portal can steer any session that publishes a room, but until now a
 * session could only come into existence at a real terminal. This module is
 * the other half: the portal asks for a session in a directory, and a nanny
 * process (`omp mobile host --cwd <dir>`) runs one under a PTY so the phone
 * can start work when no terminal is open at all.
 *
 * Why a nanny process instead of the portal holding the PTY: the portal is
 * KeepAlive-restarted by launchd (updates, crashes, `omp mobile restart`), and
 * a PTY master that disappears takes its slave's session with it (SIGHUP), so
 * every phone-spawned session would die with the next portal restart. On macOS
 * the nanny is its own transient launchd job — a sibling of the portal, not its
 * descendant — and it holds the PTY for exactly one child. Portal and sessions
 * therefore have independent lifetimes, at the cost of one tiny process per
 * spawned session.
 *
 * Why a PTY at all: an interactive omp is a TUI and expects a terminal (raw
 * mode, isatty checks). Under the PTY it is an ordinary interactive session —
 * `collab.autoStart` hosts its room, it publishes its record, and the portal
 * discovers it through the same watcher as any terminal-launched session. No
 * special headless mode, no second startup path to keep honest.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { listAllSessions } from "../session/session-listing";
import { FileSessionStorage } from "../session/session-storage";
import { isDarwin, submitSessionHostJob } from "./launchctl";
import { mobileRuntimeDir } from "./paths";
import { resolveOmpLaunchArgv } from "./service";
import { readMobileState } from "./state";
import type { PortalControl } from "./types";

/**
 * caffeinate wraps the nanny the same way it wraps both services (see
 * service.ts): a phone-spawned session is by definition unattended, so the
 * machine must not doze off mid-task. macOS-only, matching the services.
 */
const CAFFEINATE = "/usr/bin/caffeinate";

/**
 * PTY size for a spawned session. Nobody ever looks at this terminal — output
 * is discarded — but the TUI lays itself out against it, and a degenerate
 * 0x0 or 80x24 makes some renders take error paths a real terminal never hits.
 */
const PTY_COLS = 120;
const PTY_ROWS = 32;

/**
 * Normalize a directory typed on the phone into an absolute path that exists
 * and is a directory, or throw with a message safe to show on the phone.
 *
 * Relative input is rejected rather than resolved: the portal runs under
 * launchd with an unpredictable working directory, so resolving against it
 * would spawn sessions in places the user never meant. `~` is expanded because
 * that is how people actually write paths on a phone keyboard.
 */
export async function validateSessionCwd(input: string): Promise<string> {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("directory is required");
	const expanded =
		trimmed === "~" ? os.homedir() : trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	if (!path.isAbsolute(expanded)) throw new Error("directory must be an absolute path (~/ is fine)");
	// Canonical: no trailing slashes (except the root itself), so a spawned
	// session's cwd renders exactly the way a terminal-launched one does.
	const normalized = path.normalize(expanded).replace(/(?<!^)\/+$/, "");
	const stat = await fs.stat(normalized).catch(() => undefined);
	if (!stat) throw new Error(`directory does not exist: ${normalized}`);
	if (!stat.isDirectory()) throw new Error(`not a directory: ${normalized}`);
	return normalized;
}

/**
 * Recent session directories for the new-session form's suggestions, most
 * recent first, capped, with entries whose directory has since been deleted
 * dropped. `$HOME` is always present: starting a session at the home directory
 * is the sensible default when nothing recent fits.
 */
export async function listRecentDirectories(limit = 8): Promise<string[]> {
	const sessions = await listAllSessions(new FileSessionStorage()).catch(() => []);
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const session of sessions) {
		if (!session.cwd || seen.has(session.cwd)) continue;
		seen.add(session.cwd);
		candidates.push(session.cwd);
		if (candidates.length >= limit) break;
	}
	const existing: string[] = [];
	for (const dir of candidates) {
		if (
			await fs.stat(dir).then(
				s => s.isDirectory(),
				() => false,
			)
		)
			existing.push(dir);
	}
	const home = os.homedir();
	if (!existing.includes(home)) existing.push(home);
	return existing;
}

/** argv that runs the nanny for one spawned session: `omp mobile host --cwd <dir>`. */
export function buildHostArgv(launchArgv: string[], cwd: string): string[] {
	return [...launchArgv, "mobile", "host", "--cwd", cwd];
}

/**
 * Start one nanny beyond the portal's process lifetime.
 *
 * On macOS, `launchctl submit` is the load-bearing boundary: launchd creates a
 * sibling job, so restarting the portal job cannot include the nanny in its
 * teardown. The submitted job removes its own launchd label when the nanny
 * exits. Other platforms have no launchd service lifecycle to escape, so a
 * detached POSIX process with ignored stdio is the portable fallback.
 */
export async function spawnSessionHost(launchArgv: string[], cwd: string, log: (msg: string) => void): Promise<void> {
	const hostArgv = buildHostArgv(launchArgv, cwd);
	if (isDarwin()) {
		const label = `sh.omp.mobile-session.${process.pid}.${Date.now().toString(36)}.${crypto.randomUUID().slice(0, 8)}`;
		const result = await submitSessionHostJob(label, [CAFFEINATE, "-dims", ...hostArgv]);
		if (!result.ok) {
			log(`session host submit failed label=${label} cwd=${cwd} code=${result.exitCode} ${result.stderr}`);
			throw new Error("could not start session host");
		}
		log(`session host submitted label=${label} cwd=${cwd}`);
		return;
	}

	const proc = Bun.spawn(hostArgv, { stdio: ["ignore", "ignore", "ignore"], detached: true });
	proc.unref();
	void proc.exited.then(code => log(`session host exited pid=${proc.pid} cwd=${cwd} code=${code}`));
	log(`session host spawned pid=${proc.pid} cwd=${cwd}`);
}

/**
 * The portal's real control surface. The launch argv is read per spawn rather
 * than cached: `omp mobile update` rewrites the install record, and a portal
 * that outlives the update (it restarts, but a foreground `serve` in a
 * terminal might not) should still spawn with the argv the install blessed.
 */
export function defaultPortalControl(log: (msg: string) => void): PortalControl {
	return {
		async startSession(cwd) {
			const dir = await validateSessionCwd(cwd);
			const launchArgv = (await readMobileState())?.launchArgv ?? resolveOmpLaunchArgv();
			return spawnSessionHost(launchArgv, dir, log);
		},
		listDirectories: () => listRecentDirectories(),
	};
}

/**
 * Nanny body (`omp mobile host --cwd <dir>`): run one interactive omp under a
 * PTY and wait for it. Returns the child's exit code for the CLI to propagate.
 *
 * The child's output is discarded — the room is the observable surface, and a
 * transcript nobody reads has no business growing a file. Lifecycle lines (one
 * at start, one at exit) go to `run/mobile/host.log` so "I tapped new session
 * and nothing appeared" is debuggable after the fact; two short lines per
 * spawned session cannot grow meaningfully.
 *
 * The child inherits this process's environment, which is the portal's launchd
 * environment. That is deliberate rather than a gap: it is the same
 * PATH/HOME/profile context the install record was written from, so a
 * profile-scoped install spawns sessions that publish to the link directory
 * this profile's portal actually watches.
 */
export async function runSessionHost(cwd: string): Promise<number> {
	const dir = await validateSessionCwd(cwd);
	const launchArgv = (await readMobileState())?.launchArgv ?? resolveOmpLaunchArgv();
	const [application, ...args] = launchArgv;
	if (!application) throw new Error("mobile: cannot resolve the omp launch argv");
	const logFile = path.join(mobileRuntimeDir(), "host.log");
	const note = async (msg: string) => {
		const line = `${new Date().toISOString()} ${msg}\n`;
		await fs.mkdir(mobileRuntimeDir(), { recursive: true }).catch(() => {});
		await fs.appendFile(logFile, line).catch(() => {});
	};
	const pty = new PtySession();
	await note(`spawn cwd=${dir}`);
	let result: PtyRunResult;
	try {
		result = await pty.startArgv({ application, args, cwd: dir, cols: PTY_COLS, rows: PTY_ROWS });
	} catch (err) {
		await note(`spawn failed cwd=${dir}: ${err instanceof Error ? err.message : String(err)}`);
		logger.warn("mobile session host failed to start", { cwd: dir, error: String(err) });
		return 1;
	}
	const code = result.exitCode ?? (result.cancelled ? 130 : 0);
	await note(`exit cwd=${dir} code=${code}`);
	return code;
}
