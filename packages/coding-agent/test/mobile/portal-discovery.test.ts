/**
 * Contract: the portal registers a session as soon as it publishes a room, and
 * drops it when the record goes away.
 *
 * The poll is a backstop, not the mechanism — a phone should show the session you
 * just started, not the one you started two seconds ago. So the scan interval
 * here is set absurdly high: anything that appears did so because the
 * link-directory watcher fired, which is what this suite exists to prove. A
 * regression to poll-only discovery fails it.
 *
 * Everything below the record is real: a real relay on a loopback port, a real
 * `CollabHost` per session, a real portal serving real HTTP with a real login.
 * Only the *session* is a double, because a room is all the portal ever sees of
 * one. Records name live pids (sleeping children), since the portal deliberately
 * ignores records whose owner is gone.
 *
 * Waiting is done by re-reading the portal's own API — real async I/O, no timers
 * (`ts-no-test-timers`), and a fixed delay would be a guess anyway.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { collabLinkDir } from "@oh-my-pi/pi-coding-agent/collab/link-file";
import { startPortal } from "@oh-my-pi/pi-coding-agent/mobile/portal";
import { startRelay } from "@oh-my-pi/pi-coding-agent/mobile/relay";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { __resetDirsFromEnvForTests, getConfigRootDir } from "@oh-my-pi/pi-utils";

const USERNAME = "omp";
const PASSWORD = "portal-discovery-test-password";
/** Far longer than the suite can run, so only the watcher can explain a hit. */
const NEVER_POLL_MS = 600_000;

const originalConfigDir = process.env.PI_CONFIG_DIR;
let configRoot: string;
let relay: { port: number; stop(): void } | undefined;
let portal: { port: number; stop(): Promise<void> } | undefined;
let cookie = "";
const hosts: CollabHost[] = [];
const sleepers: Bun.Subprocess[] = [];

/** Minimal InteractiveModeContext double: only the members `CollabHost` touches. */
function makeHostContext(sessionId: string, cwd: string): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
			snapshotForReplication: () => ({
				header: { type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd },
				entries: [],
			}),
			onEntryAppended: undefined,
			onSessionIdChanged: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: path.basename(cwd),
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

/** A live pid to own a record, since the portal skips records whose owner is gone. */
function spawnSleeper(): number {
	const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
	sleepers.push(child);
	return child.pid;
}

/** Host a room on the test relay and return its steerable link. */
async function hostRoom(sessionId: string, cwd: string): Promise<string> {
	const host = new CollabHost(makeHostContext(sessionId, cwd));
	hosts.push(host);
	await host.start(`ws://127.0.0.1:${relay?.port}`, "", { publishLink: false });
	return host.link;
}

/** Publish a link record the way a hosting session does: staged write, then rename. */
async function publishRecord(pid: number, cwd: string, link: string): Promise<void> {
	const dir = collabLinkDir();
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const record = {
		pid,
		cwd,
		sessionId: `sess-${pid}`,
		startedAt: new Date().toISOString(),
		relayUrl: `ws://127.0.0.1:${relay?.port}`,
		link,
		webLink: "",
		viewLink: link,
		webViewLink: "",
	};
	const staged = path.join(dir, `${pid}.tmp`);
	await Bun.write(staged, `${JSON.stringify(record, null, 2)}\n`);
	await fs.rename(staged, path.join(dir, `${pid}.json`));
}

/** Pids in an `/api/sessions` payload, read without trusting its shape. */
function pidsOf(payload: unknown): number[] {
	if (!Array.isArray(payload)) return [];
	const pids: number[] = [];
	for (const row of payload) {
		if (row !== null && typeof row === "object" && "pid" in row && typeof row.pid === "number") pids.push(row.pid);
	}
	return pids;
}

/** Re-read the portal's own API until `predicate` holds; every wait is real I/O. */
async function sessionsUntil(predicate: (pids: number[]) => boolean, what: string, attempts = 3000): Promise<number[]> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const response = await fetch(`http://127.0.0.1:${portal?.port}/api/sessions`, { headers: { cookie } });
		const pids = pidsOf(await response.json());
		if (predicate(pids)) return pids;
	}
	throw new Error(`portal never reported ${what}`);
}

beforeAll(async () => {
	process.env.PI_CONFIG_DIR = `.omp-test-portal-discovery-${process.pid}-${Date.now().toString(36)}`;
	__resetDirsFromEnvForTests();
	configRoot = getConfigRootDir();
	// Fail loudly rather than operating on the developer's real ~/.omp.
	expect(configRoot).not.toBe(path.join(os.homedir(), ".omp"));

	// Port 0 everywhere: never collide with the relay/portal a developer is running.
	relay = startRelay({ port: 0 });
	portal = await startPortal({ port: 0, username: USERNAME, password: PASSWORD, scanIntervalMs: NEVER_POLL_MS });
	const login = await fetch(`http://127.0.0.1:${portal.port}/login`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString(),
		redirect: "manual",
	});
	cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	expect(cookie).toStartWith("omp_session=");
});

afterAll(async () => {
	for (const host of hosts.splice(0)) await host.stop("test over");
	await portal?.stop();
	relay?.stop();
	for (const child of sleepers.splice(0)) {
		child.kill();
		await child.exited;
	}
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	__resetDirsFromEnvForTests();
	await fs.rm(configRoot, { recursive: true, force: true });
});

afterEach(async () => {
	// Remove the records, not the directory: deleting the directory a portal is
	// watching is a separate scenario (covered explicitly below) and would leave
	// the next test relying on the poll this suite deliberately disables.
	for (const name of await fs.readdir(collabLinkDir()).catch(() => [])) {
		await fs.rm(path.join(collabLinkDir(), name), { force: true });
	}
	for (const host of hosts.splice(0)) await host.stop("test over");
});

describe("portal session discovery", () => {
	it("registers a session from its published record without waiting for a poll", async () => {
		const pid = spawnSleeper();
		await publishRecord(pid, "/tmp/project-a", await hostRoom("sess-a", "/tmp/project-a"));

		expect(await sessionsUntil(pids => pids.includes(pid), "the published session")).toContain(pid);
	});

	it("registers a burst of sessions and drops one whose record disappears", async () => {
		const first = spawnSleeper();
		await publishRecord(first, "/tmp/project-a", await hostRoom("sess-a", "/tmp/project-a"));
		await sessionsUntil(pids => pids.includes(first), "the first session");

		// Two at once: the watcher must survive repeated firing and settle with both.
		const second = spawnSleeper();
		const third = spawnSleeper();
		await publishRecord(second, "/tmp/project-b", await hostRoom("sess-b", "/tmp/project-b"));
		await publishRecord(third, "/tmp/project-c", await hostRoom("sess-c", "/tmp/project-c"));
		const pids = await sessionsUntil(seen => seen.includes(second) && seen.includes(third), "both later sessions");
		expect(pids).toContain(first);

		// Session exits: `unpublishCollabLink` removes the record, and the card must
		// go with it rather than lingering forever.
		await fs.rm(path.join(collabLinkDir(), `${second}.json`));
		expect(await sessionsUntil(seen => !seen.includes(second), "the removed session")).not.toContain(second);
	});

	it("discovers the first session even when no link directory existed at startup", async () => {
		// A portal can start before anything has ever hosted (fresh machine, fresh
		// profile). It creates the directory it watches for exactly this reason: with
		// nothing to watch, the first session would appear only on the next poll,
		// which this suite has disabled — so a hit here proves the directory was
		// prepared and watched, not polled.
		await fs.rm(collabLinkDir(), { recursive: true, force: true });
		const cold = await startPortal({
			port: 0,
			username: USERNAME,
			password: PASSWORD,
			scanIntervalMs: NEVER_POLL_MS,
		});
		try {
			const login = await fetch(`http://127.0.0.1:${cold.port}/login`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString(),
				redirect: "manual",
			});
			const coldCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
			const pid = spawnSleeper();
			await publishRecord(pid, "/tmp/project-cold", await hostRoom("sess-cold", "/tmp/project-cold"));

			for (let attempt = 0; attempt < 3000; attempt++) {
				const response = await fetch(`http://127.0.0.1:${cold.port}/api/sessions`, {
					headers: { cookie: coldCookie },
				});
				if (pidsOf(await response.json()).includes(pid)) return;
			}
			throw new Error("a portal that created its own link directory never reported the first session");
		} finally {
			await cold.stop();
		}
	});
});
