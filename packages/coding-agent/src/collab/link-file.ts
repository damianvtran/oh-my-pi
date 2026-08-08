/**
 * Per-process publication of the active collab room link.
 *
 * Why this exists: `/collab` prints its link to the TUI, which is the only
 * place the room key ever appears. Local automation that wants to attach to a
 * live session (a supervisor, a notifier, a mobile control plane) therefore has
 * to scrape the terminal. This module gives those tools a supported discovery
 * surface instead: while a session is hosting, its room lives in
 * `<config-root>/run/collab/<pid>.json`, and it is removed when hosting stops.
 *
 * The directory sits under the same `run/` namespace as the project brokers
 * (`launch/paths.ts`), so it follows `PI_CONFIG_DIR` and `--profile` and one
 * profile never sees another profile's rooms. It is deliberately NOT folded
 * into `launch/presence.ts`, which looks similar: presence records are keyed by
 * project directory and exist to answer "is a broker still wanted", are written
 * one-per-client with a uuid, and are swept by the broker. A collab room is
 * one-per-process, global to the profile, replaced in place, atomically visible
 * (a consumer must never read a half-written link), and swept by whoever
 * publishes next. Sharing the ~6 lines of mkdir/chmod/postmortem the two have in
 * common would couple two lifecycles that agree on nothing else.
 *
 * SECURITY: in `full` mode the record contains the write link, which embeds the
 * 32-byte room key and the 16-byte write token — a reader can read the session
 * and prompt the agent. In `view` mode only the read-only links are published.
 * The directory is `0700` and each record `0600`, so the trust boundary is the
 * directory: records are not authenticated, and any process running as this
 * user can read or forge one. Publication is opt-in via `collab.publishLink`.
 *
 * Staleness: records are removed on graceful teardown and on the signal paths
 * `postmortem` awaits, but an abrupt exit (`SIGKILL`, a bare `process.exit`,
 * power loss) leaves one behind. Consumers MUST treat `pid` as a liveness
 * *heuristic* — check the process is alive, and still tolerate a failed connect,
 * because a recycled pid can make a stale record look live.
 * {@link publishCollabLink} sweeps records whose owner is gone as a side effect,
 * so the directory does not grow without bound while sessions keep starting.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger, procmgr } from "@oh-my-pi/pi-utils";

/** Contents of `<config-root>/run/collab/<pid>.json`. */
export interface CollabLinkRecord {
	/** Owning omp process. Liveness heuristic — see the staleness note above. */
	pid: number;
	/** Host working directory, for display and for picking a session. */
	cwd: string;
	/**
	 * Session the room is currently bound to. A room started by
	 * `collab.autoStart` follows the process: it rebinds and republishes this
	 * field when the user resumes, clears, forks or branches, so a consumer must
	 * re-read the record rather than caching the first value it saw. A
	 * hand-shared `/collab` room instead stops when the session switches.
	 */
	sessionId: string;
	/** ISO timestamp of when hosting started. */
	startedAt: string;
	/** Relay the room lives on (`collab.relayUrl` or the `/collab` argument). */
	relayUrl: string;
	/** Full link: room key + write token. Grants prompt/interrupt/agent control. Absent for a room shared in `view` mode. */
	link?: string;
	/** Browser deep link for {@link link}. Absent in `view` mode. */
	webLink?: string;
	/** View-only link: room key only, no write token. */
	viewLink: string;
	/** Browser deep link for {@link viewLink}. */
	webViewLink: string;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** `<config-root>/run/collab` — profile-scoped, so rooms never leak across profiles. */
export function collabLinkDir(): string {
	return path.join(getConfigRootDir(), "run", "collab");
}

/**
 * Remove records whose owning process is gone, plus any staged write abandoned
 * by a crash — a stage file holds the same secret as the record it was becoming,
 * so it must never outlive its session. Best effort: a file that disappears
 * underneath us (a concurrent sweep from another omp) is not an error, which is
 * why every unlink is forced.
 */
async function sweepStaleCollabLinks(): Promise<void> {
	const dir = collabLinkDir();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	for (const name of names) {
		// Liveness gates BOTH extensions. A live peer's `.tmp` is an in-flight
		// staged write: unlinking it makes its `rename` fail and that session
		// silently never publishes. Only a dead owner's leftovers are reclaimed.
		const pid = Number.parseInt(name, 10);
		if (Number.isNaN(pid) || procmgr.isPidRunning(pid)) continue;
		await fs.rm(path.join(dir, name), { force: true });
	}
}

/**
 * Publish this process's room record, replacing any previous one.
 *
 * The write is staged and renamed so a reader never observes a half-written
 * record. `node:fs` rather than `Bun.write` for the staged write only, because
 * the secret must be created exclusively (`wx`): the staged path is predictable,
 * and writing into a pre-existing file would inherit its permissions — or follow
 * a symlink planted there — and expose the write token before the `chmod` lands.
 *
 * Modes are re-applied rather than left to creation flags: `mkdir`/`open` modes
 * are masked by the process umask, and a directory left behind by an earlier run
 * keeps whatever permissions it already had.
 *
 * Failures are logged and swallowed: losing the discovery file must never take
 * down a working collab session.
 */
export async function publishCollabLink(record: CollabLinkRecord): Promise<void> {
	const dir = collabLinkDir();
	const staged = path.join(dir, `${record.pid}.tmp`);
	try {
		await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
		await fs.chmod(dir, DIR_MODE);
		await sweepStaleCollabLinks();
		await fs.rm(staged, { force: true });
		await fs.writeFile(staged, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: FILE_MODE });
		await fs.chmod(staged, FILE_MODE);
		await fs.rename(staged, path.join(dir, `${record.pid}.json`));
	} catch (err) {
		await fs.rm(staged, { force: true }).catch(() => {});
		logger.warn("Failed to publish collab link file", { dir, error: String(err) });
	}
}

/** Remove this process's room record. Safe to call when nothing was published. */
export async function unpublishCollabLink(): Promise<void> {
	const dir = collabLinkDir();
	try {
		await fs.rm(path.join(dir, `${process.pid}.json`), { force: true });
		await fs.rm(path.join(dir, `${process.pid}.tmp`), { force: true });
	} catch (err) {
		logger.warn("Failed to remove collab link file", { dir, error: String(err) });
	}
}
