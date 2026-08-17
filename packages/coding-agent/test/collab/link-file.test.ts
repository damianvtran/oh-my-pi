/**
 * Contract: while `collab.publishLink` is on, a hosting session publishes its room
 * to `<config-root>/run/collab/<pid>.json` and removes it when hosting stops, so
 * local automation can discover live rooms without scraping the TUI. A room
 * shared read-only publishes only the view links, never the write token.
 *
 * The lifecycle tests run a real `CollabHost` over the in-process relay + fake
 * WebSocket transport (see ./helpers/in-memory-relay), so publication is driven
 * by the same `start()`/`stop()` path production uses. The sweep is exercised
 * directly, because a dead-owner record cannot be produced by a live host.
 *
 * Isolation goes through `PI_CONFIG_DIR`, not `setAgentDir`: `collabLinkDir()`
 * resolves from `getConfigRootDir()`, which `DirResolver` derives from the
 * profile config root and NOT from the agent-dir override. Redirecting only the
 * agent dir would leave this suite reading — and its `afterEach` deleting — the
 * developer's real `~/.omp/run/collab`. `PI_CONFIG_DIR` is a directory NAME
 * relative to home (see `getConfigDirName`), matching the pattern in
 * `test/sdk-session-isolation.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { type CollabLinkRecord, collabLinkDir, publishCollabLink } from "@oh-my-pi/pi-coding-agent/collab/link-file";
import { parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { __resetDirsFromEnvForTests, getConfigRootDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const RELAY_URL = "ws://localhost:7777";
const originalConfigDir = process.env.PI_CONFIG_DIR;

let configRoot: string;

/**
 * Minimal InteractiveModeContext double: only the members `CollabHost` touches.
 * Publication is driven by the `publishLink` start option rather than settings,
 * so the double only needs the `""` fallback the other collab suites use.
 */
function makeHostContext(): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-link-file",
			getCwd: () => "/tmp/project",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-link-file", timestamp: new Date().toISOString(), cwd: "/tmp/project" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
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

async function readRecords(): Promise<CollabLinkRecord[]> {
	const dir = collabLinkDir();
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	const records: CollabLinkRecord[] = [];
	for (const name of names.filter(n => n.endsWith(".json"))) {
		records.push((await Bun.file(path.join(dir, name)).json()) as CollabLinkRecord);
	}
	return records;
}

beforeAll(() => {
	process.env.PI_CONFIG_DIR = `.omp-test-collab-link-${process.pid}-${Date.now().toString(36)}`;
	__resetDirsFromEnvForTests();
	configRoot = getConfigRootDir();
	// Fail loudly rather than operating on the developer's real ~/.omp: every
	// assertion below reads, and afterEach deletes, whatever this resolves to.
	expect(configRoot).not.toBe(path.join(os.homedir(), ".omp"));
	expect(path.basename(configRoot)).toBe(process.env.PI_CONFIG_DIR);
});

afterAll(async () => {
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	__resetDirsFromEnvForTests();
	await fs.rm(configRoot, { recursive: true, force: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	uninstallInMemoryRelay();
	await fs.rm(collabLinkDir(), { recursive: true, force: true });
});

describe("collab link file", () => {
	it("publishes the live room and removes it when hosting stops", async () => {
		installInMemoryRelay();
		const host = new CollabHost(makeHostContext());
		await host.start(RELAY_URL, "", { publishLink: true });

		const [record, ...extra] = await readRecords();
		expect(extra).toEqual([]);
		expect(record).toMatchObject({
			pid: process.pid,
			cwd: "/tmp/project",
			sessionId: "sess-link-file",
			relayUrl: RELAY_URL,
			link: host.link,
			webLink: host.webLink,
			viewLink: host.viewLink,
			webViewLink: host.webViewLink,
		});
		expect(Number.isNaN(Date.parse(record?.startedAt ?? ""))).toBe(false);

		// A consumer has to be able to act on what was published: the link must
		// parse back into the room this host is serving, write token included.
		const parsed = parseCollabLink(record?.link ?? "");
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.writeToken).toBeDefined();

		// Only the owning user may read it — the record carries the write token.
		expect((await fs.stat(path.join(collabLinkDir(), `${process.pid}.json`))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(collabLinkDir())).mode & 0o777).toBe(0o700);

		await host.stop("test over");
		expect(await readRecords()).toEqual([]);
	});

	it("omits the write link for a room shared read-only", async () => {
		installInMemoryRelay();
		const host = new CollabHost(makeHostContext());
		await host.start(RELAY_URL, "", { view: true, publishLink: true });

		const [record] = await readRecords();
		expect(record?.link).toBeUndefined();
		expect(record?.webLink).toBeUndefined();
		expect(record?.viewLink).toBe(host.viewLink);

		// The view link must genuinely be non-steerable, not just a different string.
		const parsed = parseCollabLink(record?.viewLink ?? "");
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.writeToken).toBeUndefined();

		await host.stop("test over");
	});

	it("publishes nothing when link-file publication is not requested", async () => {
		installInMemoryRelay();
		const host = new CollabHost(makeHostContext());
		await host.start(RELAY_URL);
		expect(await readRecords()).toEqual([]);
		await host.stop("test over");
	});

	it("aborts a start torn down during the handshake instead of publishing a stopped room", async () => {
		// Auto-start is unawaited, so `/collab stop` and `/leave` can land while
		// `start()` is still parked on the relay handshake. `#teardown` is
		// `#stopped`-guarded and runs only once, so a `start()` that resumed anyway
		// would leave a live socket, an installed session tap, and a published
		// record for a room nothing can stop again. A socket that never opens
		// reproduces that window deterministically.
		installInMemoryRelay();
		const connected = Promise.withResolvers<void>();
		vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(() => connected.resolve());
		const ctx = makeHostContext();
		const host = new CollabHost(ctx);

		const pending = host.start(RELAY_URL, "", { publishLink: true });
		// Stop only once `start()` is genuinely parked on the handshake; stopping
		// earlier would exercise the pre-socket guard instead of this one.
		await connected.promise;
		await host.stop("user stopped");

		await expect(pending).rejects.toThrow(/stopped before the relay handshake/);
		expect(await readRecords()).toEqual([]);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("reclaims a dead owner's leftovers but never a live peer's staged write", async () => {
		const dir = collabLinkDir();
		await fs.mkdir(dir, { recursive: true });
		const base: CollabLinkRecord = {
			pid: 0,
			cwd: "/tmp/gone",
			sessionId: "sess-gone",
			startedAt: new Date().toISOString(),
			relayUrl: RELAY_URL,
			viewLink: "ws://localhost:7777/r/room.key",
			webViewLink: "",
		};
		// pid 0 is never a user process, so these are unambiguously dead. The stage
		// file holds the same secret as the record it was becoming, so it must be
		// reclaimed too.
		await Bun.write(path.join(dir, "0.json"), JSON.stringify(base));
		await Bun.write(path.join(dir, "0.tmp"), JSON.stringify(base));

		// A concurrent publisher sitting between its staged write and its rename:
		// sweeping its `.tmp` would make that rename fail and leave that session
		// silently undiscoverable, which is the one outcome this feature cannot have.
		const peer = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		await Bun.write(path.join(dir, `${peer.pid}.tmp`), "{}");
		try {
			// Publishing is what sweeps.
			await publishCollabLink({ ...base, pid: process.pid, cwd: "/tmp/alive", sessionId: "sess-alive" });
			expect((await fs.readdir(dir)).sort()).toEqual([`${peer.pid}.tmp`, `${process.pid}.json`].sort());
		} finally {
			peer.kill();
			await peer.exited;
		}
	});
});
