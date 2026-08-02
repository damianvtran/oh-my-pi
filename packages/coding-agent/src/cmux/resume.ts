/**
 * Telling cmux how to bring this session back after a restart.
 *
 * cmux restores a workspace by re-running what its surface was running. For an
 * agent it wants more than the bare command — it wants the *session*, so the
 * workspace comes back where you left it — and it can work that out on its own
 * only when the session id is already visible in the process argv
 * (`omp --session <id>`). That is true for exactly one population: surfaces cmux
 * itself relaunched. A session started by typing `omp` publishes its id nowhere
 * cmux can see it; the `piSessionFile` fallback in its agent config keys on the
 * surface's working directory, and omp relocates a home-directory launch (see
 * `cli/startup-cwd.ts`), so the lookup reads a directory the session was never
 * written to. Those surfaces come back as an empty shell, and after a reboot
 * that is most of them.
 *
 * So omp tells cmux directly instead of waiting to be discovered.
 * `surface.resume.set` binds an argv to the surface this process runs in; cmux
 * persists it alongside the rest of the workspace and uses it on the next
 * restore. Re-asserted whenever the active session id changes, because
 * `/resume`, `/new`, `/fork` and `/tree` all move the process to a different
 * session, and a binding that points at the one you left is worse than none.
 *
 * Best-effort throughout: a resume binding is a convenience for the next reboot,
 * never a reason to warn on someone's terminal or to slow a launch down. Every
 * failure is swallowed at debug level.
 */

import * as path from "node:path";
import { logger, ptree } from "@oh-my-pi/pi-utils";

/** The CLI round-trips over a Unix socket to the app; a hang means the app is wedged. */
const CLI_TIMEOUT_MS = 10_000;

/**
 * Everything the binder reads from the outside world, in one injectable place so
 * a test can exercise the real sequencing against a stub CLI instead of the
 * running desktop app.
 */
export interface CmuxResumeEnvironment {
	/**
	 * `CMUX_SURFACE_ID`, or undefined when not running under cmux. Both the "is
	 * there a cmux" test and the target: the CLI would otherwise resolve the
	 * calling surface by walking the process tree, and naming it is free and
	 * exact — which also sidesteps `CMUX_WORKSPACE_ID` going stale when a surface
	 * is moved between workspaces.
	 */
	surfaceId: string | undefined;
	/** Absolute path to the CLI in the running cmux bundle, else the name on PATH. */
	cli: string;
	/** The binary a restore should re-run; see {@link CmuxResumeBinder.register}. */
	executable: string;
}

export function readCmuxResumeEnvironment(): CmuxResumeEnvironment {
	const bundled = process.env.CMUX_BUNDLED_CLI_PATH;
	return {
		surfaceId: process.env.CMUX_SURFACE_ID,
		cli: bundled !== undefined && bundled.length > 0 ? bundled : "cmux",
		executable: process.execPath,
	};
}

/**
 * Keeps one cmux surface's resume command pointed at the session this process
 * currently has loaded.
 *
 * Owns the small amount of state that makes repeated calls cheap and safe:
 * what cmux has confirmed, what it should end up with, and whether a write is
 * already running. Per-instance rather than module-global so nothing leaks
 * between the sessions an embedded host may run in one process.
 */
export class CmuxResumeBinder {
	readonly #env: CmuxResumeEnvironment;
	/** Latest id we have been asked to bind, whether or not it is written yet. */
	#desired: string | undefined;
	/** Latest id cmux has confirmed, so an unchanged re-assert costs no subprocess. */
	#bound: string | undefined;
	/** Serializes writes: `/tree` navigation can walk ids faster than the CLI runs. */
	#writing = false;

	constructor(env: CmuxResumeEnvironment = readCmuxResumeEnvironment()) {
		this.#env = env;
	}

	/**
	 * Point this cmux surface's resume command at `sessionId`.
	 *
	 * Returns immediately; the write happens in the background. Safe to call on
	 * every session change, and safe to call when there is no cmux — outside a
	 * cmux surface it does nothing at all.
	 */
	register(sessionId: string): void {
		if (sessionId.length === 0) return;
		if (this.#env.surfaceId === undefined || this.#env.surfaceId.length === 0) return;
		// Only a compiled omp binary can be re-run as `<exe> --session <id>`. Under
		// `bun run src/main.ts` the executable is bun itself, and binding
		// `bun --session <id>` over the workspace would replace a working shell
		// with a broken one on the next restore — strictly worse than no binding.
		if (path.basename(this.#env.executable) !== "omp") return;
		this.#desired = sessionId;
		void this.#drain();
	}

	/**
	 * Drain {@link #desired} into cmux, one write at a time.
	 *
	 * A failed write deliberately leaves {@link #bound} alone rather than
	 * recording the attempt, so the next session change retries instead of
	 * concluding the binding is already correct.
	 */
	async #drain(): Promise<void> {
		if (this.#writing) return;
		this.#writing = true;
		try {
			while (this.#desired !== undefined && this.#desired !== this.#bound) {
				const target = this.#desired;
				if (!(await this.#write(target))) return;
				this.#bound = target;
			}
		} catch (err) {
			logger.debug("cmux: resume registration failed", { error: String(err) });
		} finally {
			this.#writing = false;
		}
	}

	async #write(sessionId: string): Promise<boolean> {
		const { cli, surfaceId, executable } = this.#env;
		const result = await ptree.exec(
			[cli, "surface", "resume", "set", "--surface", surfaceId as string, "--", executable, "--session", sessionId],
			{
				signal: ptree.combineSignals(CLI_TIMEOUT_MS),
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			},
		);
		if (result.exitCode === 0) return true;
		logger.debug("cmux: surface resume set failed", {
			exitCode: result.exitCode,
			stderr: result.stderr.trim(),
		});
		return false;
	}

	/** Resolves once no write is in flight. Test seam; production never waits. */
	async settled(): Promise<void> {
		while (this.#writing) await Bun.sleep(5);
	}
}
