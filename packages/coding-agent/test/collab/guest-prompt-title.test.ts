/**
 * Contract: a guest prompt is a turn start, so it feeds automatic session
 * titling exactly like the editor's submit handler does.
 *
 * The regression this locks down: a session created from the phone and driven
 * only from the phone stayed unnamed forever, because the sole auto-title
 * trigger lived in the TUI's editor submit path and `CollabHost` prompts the
 * session directly. The two exclusions matter as much as the trigger — a
 * refused read-only prompt never runs, so it must not title anything, and the
 * portal's hidden resume prompt describes an interruption rather than a task.
 *
 * Runs over the in-memory relay + fake WebSocket transport with real AES-GCM
 * sealing; only the TUI context and the network transport are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { INTERNAL_RESUME_MARKER, INTERNAL_RESUME_PROMPT } from "@oh-my-pi/pi-coding-agent/mobile/types";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface HostHarness {
	ctx: InteractiveModeContext;
	/** Text handed to `startAutoTitleGeneration`, in order. */
	titled: string[];
	/** `prompt:<text>` / `title:<text>` in call order — the dispatch must come first. */
	calls: string[];
	/** Resolves on the next promptCustomMessage call, so no test polls. */
	nextPrompt(): Promise<string>;
}

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): HostHarness {
	const titled: string[] = [];
	const calls: string[] = [];
	const promptWaiters: ((text: string) => void)[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: undefined,
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: { content?: unknown }) => {
				const text = typeof message.content === "string" ? message.content : "";
				calls.push(`prompt:${text}`);
				for (const waiter of promptWaiters.splice(0)) waiter(text);
				return Promise.resolve();
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		showStatus: () => {},
		startAutoTitleGeneration: (text: string) => {
			titled.push(text);
			calls.push(`title:${text}`);
		},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const nextPrompt = (): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		promptWaiters.push(resolve);
		return promise;
	};
	return { ctx, titled, calls, nextPrompt };
}

/** Broadcasts interleave nondeterministically with directed replies. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostContext();
	host = new CollabHost(harness.ctx);
	// Port is irrelevant: the fake transport routes by the `role` query param.
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.titled.length = 0;
	harness.calls.length = 0;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

async function joinWriter(): Promise<TestGuest> {
	const guest = await joinAsGuest(host.link, "phone");
	guestCleanups.push(() => guest.socket.close());
	const welcome = await guest.nextFrame();
	if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
	return guest;
}

describe("collab guest prompts and automatic titling", () => {
	it("titles the session from a guest prompt, after the prompt is dispatched", async () => {
		const guest = await joinWriter();
		const prompted = harness.nextPrompt();
		guest.socket.send({ t: "prompt", text: "add a retry to the uploader" });
		expect(await prompted).toBe("add a retry to the uploader");
		expect(harness.titled).toEqual(["add a retry to the uploader"]);
		// Order matters: titling can spawn the local tiny-title worker
		// synchronously, and the guest's prompt must not queue behind that.
		expect(harness.calls).toEqual(["prompt:add a retry to the uploader", "title:add a retry to the uploader"]);
	});

	it("does not title from the phone's hidden resume prompt", async () => {
		const guest = await joinWriter();
		const prompted = harness.nextPrompt();
		guest.socket.send({ t: "prompt", text: INTERNAL_RESUME_PROMPT });
		// The prompt itself still runs: only titling is skipped.
		expect(await prompted).toBe(INTERNAL_RESUME_PROMPT);
		expect(harness.titled).toEqual([]);
	});

	it("still titles a real instruction that merely opens with the resume marker", async () => {
		// The exclusion matches the resume prompt in full, like the phone's own
		// projection filter. A prefix test would hand every write-token guest a
		// switch for suppressing titling on the whole session.
		const text = `${INTERNAL_RESUME_MARKER} add a retry to the uploader`;
		const guest = await joinWriter();
		const prompted = harness.nextPrompt();
		guest.socket.send({ t: "prompt", text });
		expect(await prompted).toBe(text);
		expect(harness.titled).toEqual([text]);
	});

	it("does not title from a read-only guest's refused prompt", async () => {
		const guest = await joinAsGuest(host.viewLink, "viewer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "prompt", text: "rename this session for me" });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(harness.titled).toEqual([]);
		expect(harness.calls).toEqual([]);
	});
});
