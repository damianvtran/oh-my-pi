/**
 * launchd planning for the mobile stack: what gets installed, where, and with
 * which argv.
 *
 * Everything here is pure — no filesystem, no `launchctl` — so the plan can be
 * asserted in tests on any platform and rendered into a plist without side
 * effects. `install`, `status`, the log tailer and the startup healer all read
 * the same plan, which is why the health URL and the log paths live on the spec
 * rather than being recomputed per caller.
 *
 * The services re-enter *this* omp build rather than a separate script: a
 * compiled binary runs `omp mobile relay|serve` directly, and a source checkout
 * runs it through `bun`. That is what makes the stack self-contained — the only
 * artifacts outside the repo are the two plists below.
 */

import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PORTAL_PORT, DEFAULT_RELAY_PORT, PORTAL_LABEL, RELAY_LABEL, serviceLogPaths } from "./paths";
import type { MobileLaunchPlan, MobileServiceName, MobileServiceSpec } from "./types";

/**
 * `caffeinate -dims` wraps both services, matching how an interactive omp is
 * launched: a sleeping Mac is unreachable from the phone, and the whole point of
 * the stack is that a session stays steerable while you are away from the
 * keyboard. `-i` alone is not enough (the display/disk assertions keep the
 * network stack alive on battery).
 */
const CAFFEINATE = "/usr/bin/caffeinate";
const CAFFEINATE_ARGS = ["-dims"];

/**
 * launchd restart backoff. The portal is slower on purpose: it refuses to start
 * without a credential, and a misconfigured install should crash-loop gently
 * enough to read the log rather than spin.
 */
const RELAY_THROTTLE_SECONDS = 5;
const PORTAL_THROTTLE_SECONDS = 10;

export interface LaunchPlanInputs {
	relayPort?: number;
	portalPort?: number;
	/**
	 * argv prefix that re-enters this omp build, e.g. `["/path/to/dist/omp"]` or
	 * `["/path/to/bun", "run", "/repo/packages/coding-agent/src/cli.ts"]`.
	 * Resolved by {@link resolveOmpLaunchArgv} unless a caller overrides it.
	 */
	launchArgv?: string[];
	homeDir?: string;
}

/**
 * Resolve the argv that starts a fresh copy of the omp build currently running.
 *
 * A compiled binary is self-contained, so the plist points straight at it. From
 * a source checkout `process.execPath` is `bun`, which cannot start omp on its
 * own — the CLI entry has to be named explicitly, and it is resolved relative to
 * this module so a moved checkout keeps working.
 */
export function resolveOmpLaunchArgv(moduleDir: string = import.meta.dir): string[] {
	if (process.env.PI_COMPILED === "true") return [process.execPath];
	return [process.execPath, "run", path.resolve(moduleDir, "..", "cli.ts")];
}

/** The two service specs for a given set of ports. */
export function buildLaunchPlan(inputs: LaunchPlanInputs = {}): MobileLaunchPlan {
	const homeDir = inputs.homeDir ?? os.homedir();
	const relayPort = inputs.relayPort ?? DEFAULT_RELAY_PORT;
	const portalPort = inputs.portalPort ?? DEFAULT_PORTAL_PORT;
	const launchArgv = inputs.launchArgv ?? resolveOmpLaunchArgv();
	return {
		relay: buildServiceSpec({
			name: "relay",
			label: RELAY_LABEL,
			// The relay speaks WebSocket, and its health endpoint is plain HTTP on
			// the same port, so one probe covers both.
			healthUrl: `http://127.0.0.1:${relayPort}/healthz`,
			port: relayPort,
			throttleSeconds: RELAY_THROTTLE_SECONDS,
			serviceArgs: ["mobile", "relay", "--port", String(relayPort)],
			launchArgv,
			homeDir,
		}),
		portal: buildServiceSpec({
			name: "portal",
			label: PORTAL_LABEL,
			healthUrl: `http://127.0.0.1:${portalPort}/healthz`,
			port: portalPort,
			throttleSeconds: PORTAL_THROTTLE_SECONDS,
			serviceArgs: ["mobile", "serve", "--port", String(portalPort)],
			launchArgv,
			homeDir,
		}),
	};
}

function buildServiceSpec(input: {
	name: MobileServiceName;
	label: string;
	healthUrl: string;
	port: number;
	throttleSeconds: number;
	serviceArgs: string[];
	launchArgv: string[];
	homeDir: string;
}): MobileServiceSpec {
	return {
		name: input.name,
		label: input.label,
		argv: [CAFFEINATE, ...CAFFEINATE_ARGS, ...input.launchArgv, ...input.serviceArgs],
		plistPath: path.join(input.homeDir, "Library", "LaunchAgents", `${input.label}.plist`),
		logs: serviceLogPaths(input.label, input.homeDir),
		throttleSeconds: input.throttleSeconds,
		port: input.port,
		healthUrl: input.healthUrl,
	};
}

/**
 * launchd `PATH` for both jobs, and for any session the portal starts. A
 * LaunchAgent inherits almost nothing, and both services shell out (the portal
 * reads the Keychain through `security`, omp itself resolves tools through
 * `PATH`), so the usual login directories are spelled out. `HOME` matters even
 * more: every omp path derives from it, and without it a job would write its
 * state somewhere nobody looks.
 *
 * Exported because a phone-started session needs the same treatment: its nanny
 * is created by launchd, so without this it would run agent tool calls against
 * launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin` — no bun, no homebrew, no
 * `~/.local/bin`. That was observed on a real phone-started session, not
 * theorised.
 */
export function launchEnvironment(homeDir: string): Record<string, string> {
	const bunDir = path.join(homeDir, ".bun", "bin");
	const localBin = path.join(homeDir, ".local", "bin");
	return {
		HOME: homeDir,
		PATH: [bunDir, localBin, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
			":",
		),
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
	};
}

/** Minimal XML escaping for the string values that go into a plist. */
function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/**
 * Render a LaunchAgent plist for `spec`.
 *
 * `KeepAlive` is a bare true rather than a dict: both services are supposed to
 * be up whenever the user is logged in, and a crash — including the portal's
 * deliberate refusal to start without a credential — must be retried rather than
 * silently left down. `ProcessType Interactive` keeps the portal off the
 * throttled background band; it holds live WebSocket guests and SSE streams, and
 * a demoted job gets its CPU trimmed exactly when a phone is watching.
 *
 * `RunAtLoad` plus `launchctl bootstrap` at install time means a login session
 * needs no further action, and the startup healer in `ensure.ts` only has to
 * cover the gaps launchd does not (a crash still inside `ThrottleInterval`, a
 * manual `bootout`, a first run before the plists existed).
 */
export function renderLaunchAgentPlist(spec: MobileServiceSpec, homeDir: string = os.homedir()): string {
	const programArguments = spec.argv.map(arg => `\t\t<string>${xmlEscape(arg)}</string>`).join("\n");
	const environment = Object.entries(launchEnvironment(homeDir))
		.map(([key, value]) => `\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by \`omp mobile install\`. Edits are overwritten on the next install/update. -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(spec.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${programArguments}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(homeDir)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${environment}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>ThrottleInterval</key>
\t<integer>${spec.throttleSeconds}</integer>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(spec.logs.stdout)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(spec.logs.stderr)}</string>
</dict>
</plist>
`;
}
