/**
 * Contract: the portal's session-spawning routes are authenticated (a portal
 * that can start sessions as this user must never answer an anonymous caller),
 * surface validation errors in words the phone can show, and stay thin — all
 * policy lives in the injected `PortalControl`, so these tests never touch the
 * process table or the PTY layer. The real control is exercised end to end by
 * the manual smoke test against the live stack.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PortalHandle, startPortal } from "@oh-my-pi/pi-coding-agent/mobile/portal";
import type { PortalControl } from "@oh-my-pi/pi-coding-agent/mobile/types";
import { __resetDirsFromEnvForTests, getConfigRootDir } from "@oh-my-pi/pi-utils";

const USERNAME = "omp";
const PASSWORD = "test-password";
/** Discovery is off-topic here; the control routes do not wait on room scans. */
const NEVER_POLL_MS = 60_000;

let portal: PortalHandle | undefined;
let cookie = "";
let configRoot = "";
const originalConfigDir = process.env.PI_CONFIG_DIR;

const DIRECTORIES = { home: "/Users/tester", recent: ["/tmp/project-a", "/tmp/project-b"] };

/** Records spawns and refuses relative paths the way the real validation does. */
interface FakeControl extends PortalControl {
	started: string[];
}

function fakeControl(): FakeControl {
	const started: string[] = [];
	return {
		started,
		async startSession(cwd: string): Promise<void> {
			if (!cwd.startsWith("/")) throw new Error("directory must be an absolute path (~/ is fine)");
			started.push(cwd);
		},
		listDirectories: async () => DIRECTORIES,
	};
}

let control: FakeControl;

function api(pathname: string, init: RequestInit = {}, withCookie = true): Promise<Response> {
	const headers = new Headers(init.headers);
	if (withCookie) headers.set("cookie", cookie);
	return fetch(`http://127.0.0.1:${portal?.port}${pathname}`, { ...init, headers });
}

beforeAll(async () => {
	process.env.PI_CONFIG_DIR = `.omp-test-portal-control-${process.pid}-${Date.now().toString(36)}`;
	__resetDirsFromEnvForTests();
	configRoot = getConfigRootDir();
	// Fail loudly rather than operating on the developer's real ~/.omp.
	expect(configRoot).not.toBe(path.join(os.homedir(), ".omp"));

	control = fakeControl();
	portal = await startPortal({
		port: 0,
		username: USERNAME,
		password: PASSWORD,
		scanIntervalMs: NEVER_POLL_MS,
		control,
	});
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
	await portal?.stop();
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	__resetDirsFromEnvForTests();
	await fs.rm(configRoot, { recursive: true, force: true });
});

describe("portal session control routes", () => {
	it("refuses every control route to an anonymous caller", async () => {
		expect((await api("/api/directories", {}, false)).status).toBe(401);
		expect(
			(
				await api(
					"/api/sessions/start",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cwd: "/tmp" }),
					},
					false,
				)
			).status,
		).toBe(401);
		expect((await api("/api/sessions/1/resume", { method: "POST" }, false)).status).toBe(401);
	});

	it("serves the directory suggestions for the new-session form", async () => {
		const res = await api("/api/directories");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(DIRECTORIES);
	});

	it("spawns a session nanny for a valid directory", async () => {
		const res = await api("/api/sessions/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: "/tmp/project-a" }),
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ ok: true });
		expect(control.started).toEqual(["/tmp/project-a"]);
	});

	it("answers a validation failure in words the phone can show", async () => {
		const res = await api("/api/sessions/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: "relative/path" }),
		});
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: "directory must be an absolute path (~/ is fine)" });
		// A refused spawn records nothing.
		expect(control.started).not.toContain("relative/path");
	});

	it("rejects a malformed body and the wrong method", async () => {
		const badJson = await api("/api/sessions/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(badJson.status).toBe(400);
		expect((await api("/api/sessions/start")).status).toBe(405);
	});

	it("answers resume for an unknown session with 404, not a crash", async () => {
		expect((await api("/api/sessions/999999/resume", { method: "POST" })).status).toBe(404);
	});
});
