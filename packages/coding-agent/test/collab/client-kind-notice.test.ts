/**
 * Contract: the host words its peer notices from the guest's declared `client`
 * kind. `omp mobile serve` joins every local room as a guest to aggregate the
 * session for a phone, so the generic "X joined the collab session" line told
 * the user a person had arrived when nothing of the sort happened — the session
 * merely became reachable from their phone.
 *
 * Two things are load-bearing here:
 *  - A `mobile-portal` hello reads as a relay registration, join and leave.
 *  - Everything else, INCLUDING a hello with no `client` at all (a guest built
 *    before the field existed), keeps the legacy wording byte-for-byte. That is
 *    the regression that matters: every non-mobile peer depends on it.
 *
 * The suite runs a real `CollabHost` over the in-process relay + fake WebSocket
 * transport (see ./helpers/in-memory-relay), so notices are produced by the same
 * hello→welcome→peer-left path production uses, with real sealing, enveloping
 * and write-token verification in the loop. Nothing is time-based: the harness
 * hands out a promise per pending notice, so each assertion awaits the exact
 * emission it is about.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabClientKind, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// Port is irrelevant: the fake transport routes by the `role` query param.
const RELAY_URL = "ws://localhost:7779";

interface Notice {
	level: string;
	message: string;
	source?: string;
}

interface HostHarness {
	ctx: InteractiveModeContext;
	/** Resolves with the next notice the host emits — no polling, no timers. */
	nextNotice(): Promise<Notice>;
}

/**
 * Minimal InteractiveModeContext double: only the members `CollabHost` touches,
 * copied from ./link-file.test.ts, with `session.emitNotice` recording instead
 * of discarding — the recorded text is the whole subject of this suite.
 */
function makeHostContext(): HostHarness {
	// Notices are consumed, not accumulated: a test that awaited one must not be
	// handed it again, and an unread one must survive until someone asks.
	const pending: Notice[] = [];
	const waiters: ((notice: Notice) => void)[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-client-kind",
			getCwd: () => "/tmp/project",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: "sess-client-kind",
					timestamp: new Date().toISOString(),
					cwd: "/tmp/project",
				},
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
			emitNotice: (level: string, message: string, source?: string) => {
				const notice = { level, message, source };
				const waiter = waiters.shift();
				if (waiter) waiter(notice);
				else pending.push(notice);
			},
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
	const nextNotice = (): Promise<Notice> => {
		const queued = pending.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<Notice>();
		waiters.push(resolve);
		return promise;
	};
	return { ctx, nextNotice };
}

/**
 * Raw guest speaking the wire protocol directly, so a hello can omit `client`
 * exactly the way a pre-field build does — something the real `CollabGuestLink`
 * can no longer express.
 */
async function joinAsGuest(link: string, name: string, client?: CollabClientKind): Promise<CollabSocket> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken, client });
	socket.connect();
	return socket;
}

let harness: HostHarness;
let host: CollabHost;

beforeEach(async () => {
	// A fresh relay and host per test: closing a guest in teardown produces a
	// peer-left notice on a later microtask, which would otherwise satisfy the
	// next test's first `nextNotice()`.
	installInMemoryRelay();
	harness = makeHostContext();
	host = new CollabHost(harness.ctx);
	await host.start(RELAY_URL);
});

afterEach(async () => {
	// Restore the real transport first so the global is clean even if stop()
	// throws; the host's socket keeps its own relay reference.
	uninstallInMemoryRelay();
	await host.stop("test done");
});

describe("collab host client-kind notices", () => {
	it("announces a mobile portal as a relay registration, not a person joining", async () => {
		const socket = await joinAsGuest(host.link, "omp-mobile", "mobile-portal");
		try {
			expect(await harness.nextNotice()).toEqual({
				level: "info",
				message: "Mobile relay registered this session — reachable from your phone",
				source: "collab",
			});
		} finally {
			socket.close();
		}
	});

	it("keeps the legacy join wording for a guest that declares no client kind", async () => {
		// The regression guard: an older peer omits `client`, and its notice must
		// be byte-identical to what the host printed before the field existed.
		const socket = await joinAsGuest(host.link, "legacy-guest");
		try {
			expect(await harness.nextNotice()).toEqual({
				level: "info",
				message: "legacy-guest joined the collab session",
				source: "collab",
			});
		} finally {
			socket.close();
		}
	});

	it("keeps the legacy join wording for a tui guest", async () => {
		const socket = await joinAsGuest(host.link, "damian", "tui");
		try {
			expect((await harness.nextNotice()).message).toBe("damian joined the collab session");
		} finally {
			socket.close();
		}
	});

	it("marks a view-link mobile portal read-only", async () => {
		// Joining through the view link means no write token, so the host's own
		// verification — not anything the guest claimed — decides `(read-only)`.
		expect(host.viewLink).not.toBe(host.link);
		const socket = await joinAsGuest(host.viewLink, "omp-mobile", "mobile-portal");
		try {
			expect((await harness.nextNotice()).message).toBe("Mobile relay registered this session (read-only)");
		} finally {
			socket.close();
		}
	});

	it("reports the portal's departure as an un-aggregation and everyone else's as a leave", async () => {
		const portal = await joinAsGuest(host.link, "omp-mobile", "mobile-portal");
		expect((await harness.nextNotice()).message).toBe(
			"Mobile relay registered this session — reachable from your phone",
		);
		const person = await joinAsGuest(host.link, "damian", "tui");
		expect((await harness.nextNotice()).message).toBe("damian joined the collab session");

		// Register the waiter before closing: the relay's peer-left control lands
		// on a microtask, so the notice can be emitted before the next await.
		const portalLeft = harness.nextNotice();
		portal.close();
		expect((await portalLeft).message).toBe("Mobile relay disconnected — this session is no longer aggregated");

		const personLeft = harness.nextNotice();
		person.close();
		expect((await personLeft).message).toBe("damian left the collab session");
	});
});
