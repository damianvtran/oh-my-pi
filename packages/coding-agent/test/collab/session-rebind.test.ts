/**
 * Contract: a room started by `collab.autoStart` is scoped to the *process*, so
 * an in-session transition (`/resume`, `/new`, `/fork`, `/tree`) rebinds it to
 * the session that is now loaded — same room id, same key, same published link —
 * and re-welcomes every guest into that session. Before this, the first frame
 * after a switch tore the room down ("Collab ended: session switched") and
 * nothing restarted it, so remote access survived only until the first
 * in-session resume and had to be recovered by relaunching with `omp resume`.
 *
 * A hand-shared `/collab` room keeps the opposite contract and still ends on a
 * switch: its guests were invited to one specific session and must never be
 * moved to another one silently.
 *
 * A real `CollabHost` runs over the in-process relay + fake WebSocket (see
 * ./helpers/in-memory-relay) with a real `CollabSocket` guest, so sealing,
 * enveloping and the welcome→chunk train are all exercised; only the TUI context
 * and the transport are doubles. Every wait here is on an observable signal (a
 * frame the guest received, a record the host published) rather than a delay:
 * the rebind debounce is production timing, and nothing in the test guesses how
 * long it takes.
 *
 * `PI_CONFIG_DIR` isolation matches ./link-file.test.ts, which explains why the
 * agent-dir override is not enough.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { type CollabLinkRecord, collabLinkDir } from "@oh-my-pi/pi-coding-agent/collab/link-file";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { __resetDirsFromEnvForTests, getConfigRootDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const RELAY_URL = "ws://localhost:7778";
const originalConfigDir = process.env.PI_CONFIG_DIR;

let configRoot: string;

/** Mutable stand-in for the session the manager currently has loaded. */
interface LoadedSession {
	id: string;
	cwd: string;
	entries: SessionEntry[];
}

function makeEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-28T00:00:00Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

/**
 * Minimal InteractiveModeContext double: only the members `CollabHost` touches.
 * `sessionManager` reads through `loaded`, so {@link switchSession} reproduces
 * what a resume does to the real manager — adopt a new id/cwd/transcript, then
 * fire the `onSessionIdChanged` tap the manager funnels every id write through.
 */
function makeHostContext(loaded: LoadedSession): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => loaded.id,
			getCwd: () => loaded.cwd,
			snapshotForReplication: () => ({
				header: { type: "session", id: loaded.id, timestamp: "2026-07-28T00:00:00Z", cwd: loaded.cwd },
				entries: loaded.entries,
			}),
			onEntryAppended: undefined,
			onSessionIdChanged: undefined,
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

function switchSession(ctx: InteractiveModeContext, loaded: LoadedSession, next: Partial<LoadedSession>): void {
	Object.assign(loaded, next);
	ctx.sessionManager.onSessionIdChanged?.(loaded.id);
}

/** One `welcome` plus the `snapshot-chunk` train that followed it. */
interface Sync {
	sessionId: string;
	entryIds: string[];
}

interface Guest {
	/** Resolves on the next completed welcome→chunk-train sync. */
	next(): Promise<Sync>;
	/** Total syncs delivered so far — a rebind that fired twice shows up here. */
	syncCount(): number;
	/** Resolves with the reason when the host ends the room. */
	bye(): Promise<string>;
	close(): void;
}

/** Join as a real guest and record every completed welcome→chunk-train sync. */
async function joinGuest(link: string): Promise<Guest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });

	const delivered: Sync[] = [];
	const buffered: Sync[] = [];
	let waiter: ((sync: Sync) => void) | undefined;
	let assembling: Sync | undefined;
	const goodbye = Promise.withResolvers<string>();
	socket.onFrame = (frame: CollabFrame) => {
		if (frame.t === "welcome") {
			assembling = { sessionId: frame.header.id, entryIds: [] };
			return;
		}
		if (frame.t === "snapshot-chunk") {
			if (!assembling) return;
			for (const entry of frame.entries) assembling.entryIds.push(entry.id);
			if (!frame.final) return;
			const sync = assembling;
			assembling = undefined;
			delivered.push(sync);
			const resolve = waiter;
			waiter = undefined;
			if (resolve) resolve(sync);
			else buffered.push(sync);
			return;
		}
		if (frame.t === "bye") goodbye.resolve(frame.reason);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "test-guest", writeToken });
	socket.connect();

	return {
		next: () =>
			new Promise<Sync>(resolve => {
				const ready = buffered.shift();
				if (ready) resolve(ready);
				else waiter = resolve;
			}),
		syncCount: () => delivered.length,
		bye: () => goodbye.promise,
		close: () => socket.close(),
	};
}

async function readRecord(): Promise<CollabLinkRecord | undefined> {
	// The record is created and removed underneath this read (a rebind replaces
	// it, teardown unlinks it), so a miss is a state, not an error.
	try {
		return (await Bun.file(path.join(collabLinkDir(), `${process.pid}.json`)).json()) as CollabLinkRecord;
	} catch {
		return undefined;
	}
}

/**
 * Read the published record until it satisfies `predicate`. A rebind sends its
 * welcomes before awaiting the re-publish, so the record can trail the frame the
 * test already observed. Each iteration awaits real filesystem I/O, which yields
 * to the event loop the pending publish is waiting on — no delay, and it settles
 * as soon as the write lands.
 */
async function recordWhen(
	predicate: (record: CollabLinkRecord | undefined) => boolean,
	what: string,
): Promise<CollabLinkRecord | undefined> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const record = await readRecord();
		if (predicate(record)) return record;
	}
	throw new Error(`published collab record never became ${what}`);
}

beforeAll(() => {
	process.env.PI_CONFIG_DIR = `.omp-test-collab-rebind-${process.pid}-${Date.now().toString(36)}`;
	__resetDirsFromEnvForTests();
	configRoot = getConfigRootDir();
	// Fail loudly rather than operating on the developer's real ~/.omp.
	expect(configRoot).not.toBe(path.join(os.homedir(), ".omp"));
	expect(path.basename(configRoot)).toBe(process.env.PI_CONFIG_DIR);
});

afterAll(async () => {
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	__resetDirsFromEnvForTests();
	await fs.rm(configRoot, { recursive: true, force: true });
});

beforeEach(() => installInMemoryRelay());

afterEach(async () => {
	uninstallInMemoryRelay();
	await fs.rm(collabLinkDir(), { recursive: true, force: true });
});

describe("collab host session rebind", () => {
	it("re-welcomes guests into the resumed session and republishes the same room", async () => {
		const loaded: LoadedSession = { id: "sess-a", cwd: "/tmp/project-a", entries: [makeEntry("a1", "first")] };
		const ctx = makeHostContext(loaded);
		const host = new CollabHost(ctx);
		await host.start(RELAY_URL, "", { publishLink: true, followSession: true });

		const guest = await joinGuest(host.link);
		try {
			expect(await guest.next()).toEqual({ sessionId: "sess-a", entryIds: ["a1"] });
			const published = await recordWhen(r => r?.sessionId === "sess-a", "bound to the original session");

			// Resuming another session, from another project directory.
			switchSession(ctx, loaded, { id: "sess-b", cwd: "/tmp/project-b", entries: [makeEntry("b1", "resumed")] });

			// The guest is re-synced onto the resumed transcript with nothing of the
			// previous session mixed in.
			expect(await guest.next()).toEqual({ sessionId: "sess-b", entryIds: ["b1"] });

			// The link a phone or supervisor already holds must keep working, so the
			// room identity cannot change — only the record's session binding does.
			const rebound = await recordWhen(r => r?.sessionId === "sess-b", "rebound to the resumed session");
			expect(rebound?.link).toBe(host.link);
			expect(rebound?.viewLink).toBe(host.viewLink);
			expect(rebound?.cwd).toBe("/tmp/project-b");
			// The room did not restart, so its start time must not move.
			expect(rebound?.startedAt).toBe(published?.startedAt);
		} finally {
			guest.close();
			await host.stop("test over");
		}
	});

	it("re-welcomes once for a transition that moves the session id repeatedly", async () => {
		// `/tree` mints a branch session and a failed resume rolls back, so one
		// user-visible transition can write the id several times. Guests must see
		// the session the user landed in, once — not one full re-sync per write.
		const loaded: LoadedSession = { id: "sess-a", cwd: "/tmp/project", entries: [makeEntry("a1", "first")] };
		const ctx = makeHostContext(loaded);
		const host = new CollabHost(ctx);
		await host.start(RELAY_URL, "", { publishLink: true, followSession: true });

		const guest = await joinGuest(host.link);
		try {
			expect(await guest.next()).toEqual({ sessionId: "sess-a", entryIds: ["a1"] });

			switchSession(ctx, loaded, { id: "sess-mid", entries: [makeEntry("m1", "intermediate")] });
			switchSession(ctx, loaded, { id: "sess-final", entries: [makeEntry("f1", "landed")] });

			// An un-debounced rebind would have delivered `sess-mid` first, so the
			// intermediate session showing up at all is a failure — no waiting needed
			// to detect it.
			expect(await guest.next()).toEqual({ sessionId: "sess-final", entryIds: ["f1"] });
			expect(guest.syncCount()).toBe(2);
			expect((await recordWhen(r => r?.sessionId === "sess-final", "rebound once"))?.sessionId).toBe("sess-final");
		} finally {
			guest.close();
			await host.stop("test over");
		}
	});

	it("still ends a hand-shared room when the session switches", async () => {
		// Upstream contract for `/collab`: a guest was given access to one session,
		// so a switch ends the room rather than moving them to another session.
		const loaded: LoadedSession = { id: "sess-a", cwd: "/tmp/project", entries: [makeEntry("a1", "first")] };
		const ctx = makeHostContext(loaded);
		const host = new CollabHost(ctx);
		await host.start(RELAY_URL, "", { publishLink: true });
		ctx.collabHost = host;

		const guest = await joinGuest(host.link);
		try {
			expect(await guest.next()).toEqual({ sessionId: "sess-a", entryIds: ["a1"] });
			// No session tap: a room that does not follow the session must not install one.
			expect(ctx.sessionManager.onSessionIdChanged).toBeUndefined();

			switchSession(ctx, loaded, { id: "sess-b", entries: [makeEntry("b1", "resumed")] });
			// The stop is lazy: it fires on the first frame that would describe the
			// session the guests were never welcomed into.
			ctx.sessionManager.onEntryAppended?.(makeEntry("b2", "post-switch"));

			// Teardown closes the socket in the same turn as the goodbye, so the bye
			// frame is not a reliable signal; the record disappearing is, and it is
			// also what a local supervisor keys off. The guest is never re-welcomed.
			expect(await recordWhen(r => r === undefined, "removed")).toBeUndefined();
			expect(guest.syncCount()).toBe(1);
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			guest.close();
			await host.stop("test over");
		}
	});
});
