/**
 * Contract: the launchd plan is the single source of truth for the mobile stack.
 * The plist launchd loads, the health endpoint every command probes, the log
 * files `omp mobile logs` tails and the ports `omp mobile status` reports all
 * come out of `buildLaunchPlan`, so a service can never be installed at one port
 * and probed at another.
 *
 * These are pure builders, so they run on every platform: only `install`/`status`
 * touch `launchctl`, and keeping the planner platform-free is what makes it
 * testable at all (the same reason `procmgr.resolveWindowsShell` takes an
 * injected environment).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { relayPortFromUrl } from "@oh-my-pi/pi-coding-agent/mobile/paths";
import {
	buildLaunchPlan,
	renderLaunchAgentPlist,
	resolveOmpLaunchArgv,
} from "@oh-my-pi/pi-coding-agent/mobile/service";

const HOME = "/Users/test-user";

describe("mobile launch plan", () => {
	it("binds each service's argv, plist, logs and health probe to the same port", () => {
		const plan = buildLaunchPlan({ relayPort: 7777, portalPort: 4444, launchArgv: ["/opt/omp"], homeDir: HOME });

		expect(plan.relay.label).toBe("sh.omp.mobile-relay");
		expect(plan.portal.label).toBe("sh.omp.mobile-portal");
		// The services re-enter this same binary — that is what makes the stack
		// self-contained, with the plists as the only artifacts outside the repo.
		expect(plan.relay.argv).toEqual([
			"/usr/bin/caffeinate",
			"-dims",
			"/opt/omp",
			"mobile",
			"relay",
			"--port",
			"7777",
		]);
		expect(plan.portal.argv).toEqual([
			"/usr/bin/caffeinate",
			"-dims",
			"/opt/omp",
			"mobile",
			"serve",
			"--port",
			"4444",
		]);
		expect(plan.relay.healthUrl).toBe("http://127.0.0.1:7777/healthz");
		expect(plan.portal.healthUrl).toBe("http://127.0.0.1:4444/healthz");
		expect(plan.relay.plistPath).toBe(path.join(HOME, "Library", "LaunchAgents", "sh.omp.mobile-relay.plist"));
		expect(plan.portal.logs.stdout).toBe(path.join(HOME, "Library", "Logs", "sh.omp.mobile-portal.out.log"));
		// The portal refuses to start without a credential, so it backs off slower:
		// a misconfigured install must be readable in the log, not a spin.
		expect(plan.portal.throttleSeconds).toBeGreaterThan(plan.relay.throttleSeconds);
	});

	it("defaults both ports to the documented values", () => {
		const plan = buildLaunchPlan({ launchArgv: ["/opt/omp"], homeDir: HOME });
		expect(plan.relay.port).toBe(7466);
		expect(plan.portal.port).toBe(4097);
	});

	it("re-enters a source checkout through bun, and a compiled binary directly", () => {
		const moduleDir = "/repo/packages/coding-agent/src/mobile";
		const previous = process.env.PI_COMPILED;
		try {
			process.env.PI_COMPILED = "true";
			expect(resolveOmpLaunchArgv(moduleDir)).toEqual([process.execPath]);

			// From source `process.execPath` is bun, which cannot start omp on its own:
			// the CLI entry has to be named, resolved relative to this module so a
			// moved checkout keeps working.
			delete process.env.PI_COMPILED;
			expect(resolveOmpLaunchArgv(moduleDir)).toEqual([
				process.execPath,
				"run",
				path.resolve("/repo/packages/coding-agent/src", "cli.ts"),
			]);
		} finally {
			if (previous === undefined) delete process.env.PI_COMPILED;
			else process.env.PI_COMPILED = previous;
		}
	});
});

describe("launch agent plist", () => {
	it("declares the keys launchd needs to keep a phone-facing service up", () => {
		const plan = buildLaunchPlan({ relayPort: 7777, portalPort: 4444, launchArgv: ["/opt/omp"], homeDir: HOME });
		const plist = renderLaunchAgentPlist(plan.portal, HOME);

		expect(plist).toContain("<key>Label</key>\n\t<string>sh.omp.mobile-portal</string>");
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		// Bare-true KeepAlive: the portal's refusal to start without a credential is
		// a crash that must be retried, not a reason to give up on the job.
		expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
		// Interactive keeps the job off the throttled background band while it holds
		// live WebSocket guests and SSE streams.
		expect(plist).toContain("<key>ProcessType</key>\n\t<string>Interactive</string>");
		expect(plist).toContain("<key>ThrottleInterval</key>\n\t<integer>10</integer>");
		expect(plist).toContain(plan.portal.logs.stdout);
		expect(plist).toContain(plan.portal.logs.stderr);
		for (const arg of plan.portal.argv) expect(plist).toContain(`<string>${arg}</string>`);
		// A LaunchAgent inherits almost nothing, and everything omp resolves hangs
		// off HOME.
		expect(plist).toContain(`<key>HOME</key>\n\t\t<string>${HOME}</string>`);
		expect(plist).toContain("<key>PATH</key>");
	});

	it("escapes XML metacharacters in paths instead of emitting a broken plist", () => {
		const plan = buildLaunchPlan({ launchArgv: ["/opt/omp & co/omp"], homeDir: "/Users/a<b>" });
		const plist = renderLaunchAgentPlist(plan.relay, "/Users/a<b>");
		expect(plist).toContain("<string>/opt/omp &amp; co/omp</string>");
		expect(plist).toContain("<string>/Users/a&lt;b&gt;</string>");
		expect(plist).not.toContain("<string>/Users/a<b>");
	});
});

describe("relayPortFromUrl", () => {
	it("reads the port a locally installed relay must listen on", () => {
		expect(relayPortFromUrl("ws://localhost:7466")).toBe(7466);
		expect(relayPortFromUrl("ws://127.0.0.1:9000")).toBe(9000);
		// No explicit port means the scheme default, which is what a browser would dial.
		expect(relayPortFromUrl("ws://localhost")).toBe(80);
	});

	it("refuses a remote or unparseable relay so install never claims to serve someone else's relay", () => {
		expect(relayPortFromUrl("wss://relay.example.com")).toBeUndefined();
		expect(relayPortFromUrl("http://localhost:7466")).toBeUndefined();
		expect(relayPortFromUrl("not a url")).toBeUndefined();
		expect(relayPortFromUrl("")).toBeUndefined();
	});
});
