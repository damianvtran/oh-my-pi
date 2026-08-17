/**
 * Telling cmux which omp binary is running.
 *
 * cmux's first-party omp integration (`cmux hooks omp install`) publishes this
 * surface's resume binding from the lifecycle events omp fires at it. To build
 * the resume command it needs the executable to re-run, and its extension
 * derives that from `process.argv` — which, under a Bun single-file build, does
 * not name the binary at all: argv[0] is the runtime and argv[1] the in-bundle
 * entry, so its `looksLikeOmpExecutable(argv[0])` check fails and it falls back
 * to resolving `omp` on PATH. On a machine that has more than one omp — a
 * Homebrew build alongside a local or forked one — PATH order decides, and the
 * restored surface comes back running the wrong build against the right
 * session.
 *
 * The `CMUX_AGENT_LAUNCH_*` contract exists for exactly this case: an agent that
 * knows its own launch publishes it in the environment and cmux prefers that
 * over anything it can infer. Under a compiled build `process.execPath` IS the
 * running binary, so omp can answer definitively what no observer can.
 *
 * Written unconditionally rather than only when unset: these variables leak to
 * every descendant, so an inherited value describes an ANCESTOR's launch, and
 * this process knows its own executable better than its parent did. cmux only
 * trusts a capture whose `KIND` names the agent whose hook is firing, so tagging
 * it `omp` keeps another agent launched from inside this session from reading it
 * as its own.
 *
 * Best-effort and side-effect-free beyond the environment: the capture is a
 * convenience for the next restart, never a reason to fail a launch.
 */

import * as path from "node:path";

/**
 * The agent kind cmux knows omp by. Must match the registration id in cmux's
 * vault (`cmux hooks omp …`, `AgentIcons/Pi`), or cmux discards the capture as
 * belonging to some other agent.
 */
const LAUNCH_KIND = "omp";

/** cmux decodes the argv as NUL-separated base64. */
function nulSeparatedBase64(values: readonly string[]): string {
	return Buffer.from(values.map(value => `${value}\0`).join(""), "utf8").toString("base64");
}

/**
 * The launch this process would have to reproduce to come back, in one
 * injectable place so a test can exercise a compiled-omp launch from a `bun
 * test` process whose own executable is bun.
 */
export interface CmuxAgentLaunch {
	/** The binary a restore re-runs. `process.execPath` under a compiled build. */
	executable: string;
	/** The user's arguments, without the runtime and entry-point prefix. */
	args: readonly string[];
}

export function readCmuxAgentLaunch(): CmuxAgentLaunch {
	return { executable: process.execPath, args: process.argv.slice(2) };
}

/**
 * Publish this process's launch into `env` for cmux's omp hooks to read.
 *
 * Call once, as early as possible: the hook extension reads the environment when
 * an event fires, and `session_start` fires during startup.
 *
 * @param env Environment to mutate; defaults to this process's own.
 * @param launch The launch to describe; defaults to this process's own.
 */
export function publishCmuxAgentLaunchCapture(
	env: NodeJS.ProcessEnv = process.env,
	launch: CmuxAgentLaunch = readCmuxAgentLaunch(),
): void {
	// Nothing reads this outside a cmux surface, and writing it there would only
	// leak a launch description into unrelated process trees.
	const surfaceId = env.CMUX_SURFACE_ID;
	if (surfaceId === undefined || surfaceId.length === 0) return;
	// Only a compiled `omp` can be re-run as `<exe> --session <id>`. Under
	// `bun run src/main.ts` execPath is bun itself, and naming a bare runtime as
	// the resume executable is strictly worse than cmux's PATH fallback.
	if (path.basename(launch.executable) !== LAUNCH_KIND) return;

	env.CMUX_AGENT_LAUNCH_KIND = LAUNCH_KIND;
	env.CMUX_AGENT_LAUNCH_EXECUTABLE = launch.executable;
	// argv[0] is replaced with the real binary for the same reason the capture
	// exists at all; everything after the entry point is the user's invocation,
	// which cmux sanitizes down to the flags a resume may safely carry.
	env.CMUX_AGENT_LAUNCH_ARGV_B64 = nulSeparatedBase64([launch.executable, ...launch.args]);
	// Deliberately NOT set: cmux falls back to the working directory the hook
	// reports, which is the session's own cwd after omp relocates a home-directory
	// launch (see `cli/startup-cwd.ts`). A value captured here would predate that
	// relocation, and an inherited one would point at the parent's project.
	delete env.CMUX_AGENT_LAUNCH_CWD;
}
