/**
 * Contract: the launch capture names the omp binary that is actually running.
 *
 * cmux builds a restored surface's resume command from these variables, and its
 * fallback — resolving `omp` on PATH — silently picks a different build on a
 * machine that has more than one. Everything asserted here is what stops a
 * restored workspace from coming back on the wrong omp: the exact variable
 * names cmux reads, the NUL-separated base64 argv encoding it decodes, and the
 * cases where publishing would be worse than staying quiet.
 */
import { describe, expect, it } from "bun:test";
import { type CmuxAgentLaunch, publishCmuxAgentLaunchCapture } from "@oh-my-pi/pi-coding-agent/cmux/launch-capture";

const COMPILED_OMP = "/Users/someone/oss/oh-my-pi/packages/coding-agent/dist/omp";

function launch(overrides: Partial<CmuxAgentLaunch> = {}): CmuxAgentLaunch {
	return { executable: COMPILED_OMP, args: [], ...overrides };
}

/** cmux decodes the argv the same way: NUL-terminated entries, base64 over the whole run. */
function decodeArgv(value: string | undefined): string[] {
	if (value === undefined) return [];
	const decoded = Buffer.from(value, "base64").toString("utf8");
	// Every entry is NUL-TERMINATED, so the split leaves a trailing empty tail.
	return decoded.split("\0").slice(0, -1);
}

describe("publishCmuxAgentLaunchCapture", () => {
	it("publishes the running binary and a decodable argv", () => {
		const env: NodeJS.ProcessEnv = { CMUX_SURFACE_ID: "SURFACE-1" };
		publishCmuxAgentLaunchCapture(env, launch({ args: ["--model", "opus"] }));

		expect(env.CMUX_AGENT_LAUNCH_KIND).toBe("omp");
		expect(env.CMUX_AGENT_LAUNCH_EXECUTABLE).toBe(COMPILED_OMP);
		// argv[0] is the real binary, not the in-bundle entry point cmux would
		// otherwise read out of `process.argv` — that substitution is the fix.
		expect(decodeArgv(env.CMUX_AGENT_LAUNCH_ARGV_B64)).toEqual([COMPILED_OMP, "--model", "opus"]);
	});

	it("stays quiet outside a cmux surface", () => {
		const env: NodeJS.ProcessEnv = {};
		publishCmuxAgentLaunchCapture(env, launch());

		expect(env.CMUX_AGENT_LAUNCH_KIND).toBeUndefined();
		expect(env.CMUX_AGENT_LAUNCH_EXECUTABLE).toBeUndefined();
		expect(env.CMUX_AGENT_LAUNCH_ARGV_B64).toBeUndefined();
	});

	it("stays quiet when the executable is a runtime rather than an omp binary", () => {
		// `bun run src/main.ts`: claiming bun as the resume executable would make
		// the next restore worse than cmux's own PATH fallback.
		const env: NodeJS.ProcessEnv = { CMUX_SURFACE_ID: "SURFACE-1" };
		publishCmuxAgentLaunchCapture(env, launch({ executable: "/opt/homebrew/bin/bun" }));

		expect(env.CMUX_AGENT_LAUNCH_KIND).toBeUndefined();
		expect(env.CMUX_AGENT_LAUNCH_EXECUTABLE).toBeUndefined();
	});

	it("overwrites an inherited capture instead of deferring to the ancestor's", () => {
		// These variables leak to every descendant, so an inherited value describes
		// the launch of whatever started this process, not this process.
		const env: NodeJS.ProcessEnv = {
			CMUX_SURFACE_ID: "SURFACE-1",
			CMUX_AGENT_LAUNCH_KIND: "claude",
			CMUX_AGENT_LAUNCH_EXECUTABLE: "/opt/other/bin/claude",
			CMUX_AGENT_LAUNCH_ARGV_B64: Buffer.from("/opt/other/bin/claude\0", "utf8").toString("base64"),
		};
		publishCmuxAgentLaunchCapture(env, launch());

		expect(env.CMUX_AGENT_LAUNCH_KIND).toBe("omp");
		expect(env.CMUX_AGENT_LAUNCH_EXECUTABLE).toBe(COMPILED_OMP);
		expect(decodeArgv(env.CMUX_AGENT_LAUNCH_ARGV_B64)).toEqual([COMPILED_OMP]);
	});

	it("clears an inherited working directory rather than passing on the parent's", () => {
		// cmux falls back to the cwd the hook reports, which is the session's real
		// directory after omp relocates a home-directory launch. A stale inherited
		// value would pin the resume to the ancestor's project instead.
		const env: NodeJS.ProcessEnv = {
			CMUX_SURFACE_ID: "SURFACE-1",
			CMUX_AGENT_LAUNCH_CWD: "/somewhere/else",
		};
		publishCmuxAgentLaunchCapture(env, launch());

		expect(env.CMUX_AGENT_LAUNCH_CWD).toBeUndefined();
	});
});
