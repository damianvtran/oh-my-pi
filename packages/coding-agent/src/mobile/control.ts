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
import { isDarwin, submitSessionHostJob } from "./launchctl";
import { mobileRuntimeDir, SESSION_JOB_LABEL_PREFIX } from "./paths";
import { launchEnvironment, resolveOmpLaunchArgv } from "./service";
import { readMobileState } from "./state";
import type { PortalControl, PortalDirectorySuggestions } from "./types";

/**
 * caffeinate wraps the nanny the same way it wraps both services (see
 * service.ts): a phone-spawned session is by definition unattended, so the
 * machine must not doze off mid-task. It is not redundant with the portal's own
 * caffeinate: `omp mobile stop` (or an update between the two jobs) ends the
 * portal's assertion while a phone-started session is still working, and the
 * whole point of the sibling-job design is that the session does not depend on
 * the portal being up. macOS-only, matching the services.
 */
const CAFFEINATE = "/usr/bin/caffeinate";

/**
 * `env(1)`, used to carry the profile selection into a submitted launchd job:
 * `launchctl submit` takes a command, not an environment.
 */
const ENV_BIN = "/usr/bin/env";

/**
 * How long `{home, recent}` is reused before rescanning the session store.
 *
 * `listAllSessions` stats every session file and re-reads the head and tail of
 * any that changed, which is a lot of work for the one field this needs. The
 * answer only changes when a session starts, so a few seconds of staleness is
 * invisible on a phone while removing the scan from every tap of "+ new".
 */
const SUGGESTION_TTL_MS = 5_000;
let suggestionCache: { at: number; value: PortalDirectorySuggestions } | undefined;

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
 * Home plus recent session directories for the new-session picker.
 *
 * Existence is checked *before* the cap, not after: scratch directories under
 * `/tmp`, deleted worktrees and removed checkouts are exactly the most recently
 * used ones, so filtering afterwards let dead entries eat every slot and could
 * hand the phone an empty list while live directories sat just past the cut.
 */
export async function listDirectorySuggestions(limit = 8): Promise<PortalDirectorySuggestions> {
	const home = os.homedir();
	const sessions = await listAllSessions().catch(() => []);
	const seen = new Set<string>([home]);
	const recent: string[] = [];
	for (const session of sessions) {
		if (!session.cwd || seen.has(session.cwd)) continue;
		seen.add(session.cwd);
		const isDir = await fs.stat(session.cwd).then(
			s => s.isDirectory(),
			() => false,
		);
		if (!isDir) continue;
		recent.push(session.cwd);
		if (recent.length >= limit) break;
	}
	return { home, recent };
}

/** Cached view of {@link listDirectorySuggestions} for the portal's route. */
async function cachedDirectorySuggestions(): Promise<PortalDirectorySuggestions> {
	const now = Date.now();
	if (suggestionCache && now - suggestionCache.at < SUGGESTION_TTL_MS) return suggestionCache.value;
	const value = await listDirectorySuggestions();
	suggestionCache = { at: now, value };
	return value;
}

/**
 * argv that runs the nanny for one spawned session: `omp mobile host --cwd
 * <dir>`. The empty-argv guard lives here so both spawn paths get it: a
 * truncated install record passes `readMobileState`'s shape check as `[]`, which
 * would otherwise make the literal string "mobile" the executable.
 */
export function buildHostArgv(launchArgv: string[], cwd: string): string[] {
	if (launchArgv.length === 0) throw new Error("mobile: cannot resolve the omp launch argv");
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
 *
 * A submitted job inherits nothing from the submitting process, so the profile
 * selection has to be carried over by hand: `PI_CONFIG_DIR` decides which config
 * root the session resolves, and therefore which link directory it publishes to.
 * Without it a `PI_CONFIG_DIR=… omp mobile serve` portal would start sessions
 * that publish where its own watcher is not looking, and the phone would wait
 * forever for a session that is running fine.
 */
export async function spawnSessionHost(launchArgv: string[], cwd: string, log: (msg: string) => void): Promise<void> {
	const hostArgv = buildHostArgv(launchArgv, cwd);
	if (isDarwin()) {
		const label = `${SESSION_JOB_LABEL_PREFIX}${process.pid}.${Date.now().toString(36)}.${crypto.randomUUID().slice(0, 8)}`;
		const configDir = process.env.PI_CONFIG_DIR;
		const command = configDir
			? [ENV_BIN, `PI_CONFIG_DIR=${configDir}`, CAFFEINATE, "-dims", ...hostArgv]
			: [CAFFEINATE, "-dims", ...hostArgv];
		const result = await submitSessionHostJob(label, command, mobileRuntimeDir());
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
 * Environment for the omp the nanny runs.
 *
 * On macOS the nanny is created by launchd and inherits almost nothing — a
 * phone-started session was observed running with
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so its `bash` tool calls could not see
 * bun, homebrew or `~/.local/bin`: healthy in the room, broken at the first real
 * command. There `launchEnvironment` (the same set the service plists spell out)
 * has to win.
 *
 * Everywhere else the nanny is forked from a portal someone started in a login
 * shell, and that environment is better than anything reconstructed here — nvm,
 * pyenv, cargo and asdf all live in it. There the inherited values win and
 * `launchEnvironment` only fills what is missing.
 */
function sessionEnvironment(): Record<string, string> {
	const inherited = process.env as Record<string, string>;
	const launch = launchEnvironment(os.homedir());
	return isDarwin() ? { ...inherited, ...launch } : { ...launch, ...inherited };
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
			await spawnSessionHost(launchArgv, dir, log);
			// The resolved path goes back to the phone so its remembered list holds
			// what the server actually used: `~/x` and `/Users/me/x` are one entry,
			// and the picker can preselect it.
			return dir;
		},
		listDirectories: () => cachedDirectorySuggestions(),
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
 * The child's environment comes from {@link sessionEnvironment}, which is not a
 * plain inherit: see there for why macOS needs an explicit PATH and other
 * platforms must not have theirs replaced.
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
		result = await pty.startArgv({
			application,
			args,
			cwd: dir,
			cols: PTY_COLS,
			rows: PTY_ROWS,
			env: sessionEnvironment(),
		});
	} catch (err) {
		await note(`spawn failed cwd=${dir}: ${err instanceof Error ? err.message : String(err)}`);
		logger.warn("mobile session host failed to start", { cwd: dir, error: String(err) });
		return 1;
	}
	const code = result.exitCode ?? (result.cancelled ? 130 : 0);
	await note(`exit cwd=${dir} code=${code}`);
	return code;
}
