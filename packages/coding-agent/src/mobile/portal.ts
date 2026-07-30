/**
 * omp mobile portal — local aggregator for every running omp session.
 *
 * Watches the collab link directory (`<config-root>/run/collab/<pid>.json`,
 * published by `collab/link-file.ts`), holds one persistent collab guest per
 * live room, and serves a plain HTTP+SSE API plus a mobile UI. Loopback only:
 * remote access is the job of a tunnel ingress in front of this port, so no
 * WebSocket ever crosses the identity boundary.
 *
 * The portal is a guest of the rooms it shows, exactly like a browser guest —
 * it holds no session state of its own and cannot see a session that has not
 * published a link.
 */
import * as fs2 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, procmgr } from "@oh-my-pi/pi-utils";
import { type CollabLinkRecord, collabLinkDir } from "../collab/link-file";
import { defaultPortalControl } from "./control";
import { isDarwin, reapStaleSessionJobs } from "./launchctl";
import { SESSION_JOB_LABEL_PREFIX } from "./paths";
import { PortalGuest } from "./portal-guest";
import portalHtml from "./portal-ui.html" with { type: "text" };
import { INTERNAL_RESUME_PROMPT, type PortalControl } from "./types";

/** bun-types claims `*.html` as `HTMLBundle`; with `type: "text"` it is the file's text. */
const UI = portalHtml as unknown as string;

const DEFAULT_SCAN_INTERVAL_MS = 2000;
/**
 * Coalescing window for link-directory events. A record is published as a staged
 * write plus a rename (two events), and sessions often start in bursts, so a
 * short debounce turns any of that into one scan while still feeling instant.
 */
const WATCH_DEBOUNCE_MS = 50;

const COOKIE = "omp_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const HTML = { "content-type": "text/html; charset=utf-8" } as const;

/**
 * How much transcript a client is handed. The SSE pushes are incremental
 * repaints of a phone screen; the REST reads back a slightly longer tail for a
 * cold open. Both are far below the guest's own 200-item cap.
 */
const TRANSCRIPT_PUSH_LIMIT = 40;
const TRANSCRIPT_FETCH_LIMIT = 50;

interface Attached {
	record: CollabLinkRecord;
	guest: PortalGuest;
	/**
	 * Set from `onClose`, which fires only on a TERMINAL close. `guest.connected`
	 * is false during ordinary reconnect backoff (and right after `connect()`,
	 * which resolves while the socket is still dialing), so it cannot be used to
	 * decide whether a re-attach is needed.
	 */
	closed: boolean;
}

export interface PortalHandle {
	readonly port: number;
	/** Stops scanning, drops every guest, and closes the server. */
	stop(): Promise<void>;
}

export interface PortalOptions {
	port: number;
	username: string;
	password: string;
	/** Link-directory poll interval. Defaults to 2s — the phone should see a new session promptly. */
	scanIntervalMs?: number;
	/** Session-spawning surface. Tests inject a fake; the real one is {@link defaultPortalControl}. */
	control?: PortalControl;
	/**
	 * Sweep stale session-host launchd labels on start. Defaults to true; tests set
	 * false so starting a portal never shells out to launchctl or removes a label
	 * belonging to the developer's own running portal.
	 */
	reapSessionJobs?: boolean;
}

class Portal implements PortalHandle {
	readonly port: number;
	readonly #username: string;
	readonly #password: string;
	/**
	 * Cookies are HMAC-signed rather than stored in a table: the portal is
	 * KeepAlive-restarted by launchd, and an in-memory session set would silently
	 * log the phone out on every crash or reboot. Keying the secret with the
	 * password means rotating the password also invalidates every live cookie.
	 */
	readonly #secret: Buffer;
	/**
	 * `collabLinkDir()` rather than a hand-rolled `~/.omp/run/collab`: omp treats
	 * `PI_CONFIG_DIR` as a directory *name* under `$HOME` (not a path), and
	 * `--profile` inserts a `profiles/<name>` segment. Deriving the path here got
	 * both wrong, so a non-default profile watched a directory nothing publishes
	 * to.
	 */
	readonly #linkDir = collabLinkDir();
	readonly #scanIntervalMs: number;
	readonly #control: PortalControl;
	readonly #attached = new Map<number, Attached>();
	readonly #subscribers = new Map<number, Set<(chunk: string) => void>>();
	readonly #server: Bun.Server<undefined>;
	#scanTimer: Timer | undefined;
	/** Link-directory watcher; undefined until the directory exists. */
	#watcher: fs2.FSWatcher | undefined;
	#watchDebounce: Timer | undefined;
	#stopped = false;

	static async start(options: PortalOptions): Promise<Portal> {
		const portal = new Portal(options);
		// Create the link directory before watching it. Hosts create it when they
		// publish, but a portal that starts first would otherwise have nothing to
		// watch and would discover the first session only on the next poll — the
		// one case where "instant" silently degraded to two seconds. Same 0700 as
		// `collab/link-file.ts`, with the explicit chmod for the same reason: the
		// creation mode is masked by the umask, and a directory left by an earlier
		// run keeps whatever permissions it already had.
		try {
			await fs.mkdir(portal.#linkDir, { recursive: true, mode: 0o700 });
			await fs.chmod(portal.#linkDir, 0o700);
		} catch (err) {
			logger.debug("mobile portal could not prepare the link directory", { error: String(err) });
		}
		// Session-host jobs remove their own launchd label on exit; a SIGKILL skips
		// that line. Sweeping here keeps the leaks bounded to one portal lifetime
		// instead of accumulating in the user domain until logout. Opt-out because
		// this shells out to launchctl and removes real labels: a test that starts a
		// portal must not mutate the developer's launchd state.
		if (isDarwin() && options.reapSessionJobs !== false) {
			const reaped = await reapStaleSessionJobs(SESSION_JOB_LABEL_PREFIX).catch(() => []);
			if (reaped.length > 0) portal.#log(`reaped ${reaped.length} stale session job label(s)`);
		}
		// One scan before returning so `omp mobile status` and the phone's first
		// load see the sessions that were already running.
		await portal.#scan();
		portal.#scanTimer = setInterval(() => void portal.#scan(), portal.#scanIntervalMs);
		portal.#watchLinkDir();
		return portal;
	}

	/**
	 * Watch the link directory so a session that starts hosting is picked up in
	 * milliseconds instead of on the next poll — the phone should show a session
	 * you just started, not one you started two seconds ago.
	 *
	 * The poll stays as the backstop, and it re-installs this watcher if the
	 * directory is ever deleted underneath us, so discovery cannot be lost
	 * permanently by someone clearing `run/collab`.
	 *
	 * Publication is a staged write plus a rename, which is two events for one
	 * record; the debounce collapses those, and a burst of sessions starting
	 * together, into one scan.
	 */
	#watchLinkDir(): void {
		if (this.#stopped || this.#watcher) return;
		try {
			this.#watcher = fs2.watch(this.#linkDir, () => {
				clearTimeout(this.#watchDebounce);
				this.#watchDebounce = setTimeout(() => void this.#scan(), WATCH_DEBOUNCE_MS);
			});
		} catch {
			// Directory not there yet (or unwatchable): the poll retries.
			return;
		}
		// A watcher on a directory that is later deleted goes silent rather than
		// erroring; drop it so the poll re-installs one when the directory returns.
		this.#watcher.on("error", () => {
			this.#watcher?.close();
			this.#watcher = undefined;
		});
	}

	constructor(options: PortalOptions) {
		this.#username = options.username;
		this.#password = options.password;
		this.#control = options.control ?? defaultPortalControl(msg => this.#log(msg));
		this.#secret = new Bun.CryptoHasher("sha256")
			.update(`omp-mobile\u0000${options.username}\u0000${options.password}`)
			.digest();
		this.#scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
		this.#server = Bun.serve({
			port: options.port,
			hostname: "127.0.0.1",
			// SSE connections are long-lived and mostly idle; the default timeout
			// would cut them.
			idleTimeout: 255,
			fetch: req => this.#handle(req),
		});
		this.port = this.#server.port ?? options.port;
		this.#log(`listening http://127.0.0.1:${this.port} watching ${this.#linkDir}`);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#scanTimer);
		this.#scanTimer = undefined;
		clearTimeout(this.#watchDebounce);
		this.#watchDebounce = undefined;
		this.#watcher?.close();
		this.#watcher = undefined;
		for (const entry of this.#attached.values()) entry.guest.close();
		this.#attached.clear();
		this.#subscribers.clear();
		await this.#server.stop(true);
	}

	// stdout IS the launchd log for this job, so lifecycle lines go there. The log
	// file is already service-specific, hence no `[omp-mobile]` tag — just a
	// timestamp, which launchd does not add.
	#log(msg: string): void {
		console.log(`${new Date().toISOString()} ${msg}`);
	}

	// ── Session discovery ────────────────────────────────────────────────────

	#push(pid: number, event: string, data: unknown): void {
		const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const send of this.#subscribers.get(pid) ?? []) send(chunk);
	}

	async #scan(): Promise<void> {
		let names: string[] = [];
		try {
			names = await fs.readdir(this.#linkDir);
			// The directory exists, so a watcher can be installed — this is how the
			// poll upgrades a cold start (nothing has ever hosted) to instant
			// discovery, and how it recovers a watcher lost to a deleted directory.
			this.#watchLinkDir();
		} catch {
			names = [];
		}
		const seen = new Set<number>();
		for (const name of names.filter(n => n.endsWith(".json"))) {
			let record: CollabLinkRecord;
			try {
				record = (await Bun.file(path.join(this.#linkDir, name)).json()) as CollabLinkRecord;
			} catch {
				continue;
			}
			// pid liveness is authoritative — a SIGKILLed omp leaves its record behind.
			if (!(record?.link ?? record?.viewLink) || !procmgr.isPidRunning(record.pid)) continue;
			seen.add(record.pid);
			const existing = this.#attached.get(record.pid);
			const target = record.link ?? record.viewLink;
			if (existing && (existing.record.link ?? existing.record.viewLink) === target && !existing.closed) {
				// Same room, guest not terminally closed — but not necessarily the same
				// session. An omp room started by `collab.autoStart` follows the host
				// across an in-session `/resume`, republishing this record with the
				// resumed session's id and cwd under an unchanged link. Adopt it so the
				// session list stops describing the session the host has already left,
				// and leave the guest alone: rebuilding it here would throw away the
				// transcript projection the phone is showing.
				existing.record = record;
				continue;
			}
			existing?.guest.close();
			const guest: PortalGuest = new PortalGuest(
				{
					onState: state => this.#push(record.pid, "state", state),
					onEntry: () => {
						this.#push(record.pid, "transcript", guest.transcript.slice(-TRANSCRIPT_PUSH_LIMIT));
						this.#push(record.pid, "todos", guest.todos);
					},
					// A snapshot replaced everything the phone is showing (join, or the
					// host rebinding the room to a resumed session). Nothing else pushes
					// the transcript, so without this the detail view keeps rendering the
					// previous session until the next entry happens to arrive.
					onResync: () => {
						this.#push(record.pid, "transcript", guest.transcript.slice(-TRANSCRIPT_PUSH_LIMIT));
						this.#push(record.pid, "todos", guest.todos);
						// Activity too: a welcome resets it and the snapshot then rebuilds
						// `interrupted` from the replayed tail, so a phone reconnecting to
						// an aborted session would otherwise have no resume button until
						// something unrelated changed.
						this.#push(record.pid, "activity", guest.activity);
						// Subagents are deliberately absent here: unlike the projections above,
						// the guest schedules its own push when the welcome's roster lands, so
						// pushing again would deliver the identical payload twice ~250ms apart
						// and run the phone's scroll-anchoring logic twice for one event.
					},
					onEvent: event => this.#push(record.pid, "agent", { type: event.type }),
					onActivity: activity => this.#push(record.pid, "activity", activity),
					onSubagents: subagents => this.#push(record.pid, "subagents", subagents),
					onUiRequest: request => this.#push(record.pid, "ui-request", request),
					onUiRequestEnd: reqId => this.#push(record.pid, "ui-request-end", { reqId }),
					onClose: reason => {
						// Terminal: the socket will not come back on its own, so the next
						// scan must build a fresh guest. Guarded on identity because a
						// superseded guest can close after its replacement is in the map.
						const entry = this.#attached.get(record.pid);
						if (entry?.guest === guest) entry.closed = true;
						this.#push(record.pid, "closed", { reason });
					},
				},
				"omp-mobile",
			);
			try {
				await guest.connect(target);
				this.#attached.set(record.pid, { record, guest, closed: false });
				this.#log(`attached pid=${record.pid} cwd=${record.cwd}`);
			} catch (err) {
				// A link-parse failure quotes the link it rejected, and that link carries
				// the room key and write token — redact it before it reaches either log.
				const detail = (err instanceof Error ? err.message : String(err)).replaceAll(target, "<link>");
				this.#log(`attach failed pid=${record.pid}: ${detail}`);
				logger.warn("mobile portal could not attach to a published collab room", { pid: record.pid, detail });
			}
		}
		for (const [pid, entry] of this.#attached) {
			if (seen.has(pid)) continue;
			entry.guest.close();
			this.#attached.delete(pid);
			this.#log(`detached pid=${pid}`);
		}
	}

	/** Card payload for the session list. Never includes a link: the phone steers through this API, not the room. */
	#sessionSummary(entry: Attached): Record<string, unknown> {
		const s = entry.guest.state;
		return {
			pid: entry.record.pid,
			cwd: entry.record.cwd,
			sessionId: entry.record.sessionId,
			name: s?.sessionName ?? path.basename(entry.record.cwd),
			startedAt: entry.record.startedAt,
			connected: entry.guest.connected,
			streaming: s?.isStreaming ?? false,
			queued: s?.queuedMessageCount ?? 0,
			model: s?.model?.id ?? s?.model?.name,
			thinking: s?.thinkingLevel,
			context: s?.contextUsage,
			participants: s?.participants ?? [],
			activity: entry.guest.activity,
			// Just the count for the card. The roster itself rides the session's SSE
			// stream, which only the open session has: a list of ten sessions must not
			// carry ten rosters on a two-second poll.
			subagents: entry.guest.subagents.running,
			needsAttention: Boolean(entry.guest.pendingUi),
			pendingUi: entry.guest.pendingUi,
		};
	}

	// ── Auth ─────────────────────────────────────────────────────────────────
	//
	// Form login backed by a signed cookie, defense in depth behind the tunnel's
	// own identity layer. That layer is the identity boundary; this is the second
	// lock, so a tunnel or policy misconfiguration does not immediately hand an
	// anonymous visitor the ability to steer live agents and approve their tool
	// calls. Credentials come from the caller (`omp mobile` reads them out of the
	// macOS Keychain) and are never written to disk here.
	//
	// Why a form and not HTTP Basic: the browser's native Basic dialog is not a
	// form, so iOS/1Password autofill treats it as a second-class prompt, and any
	// 401 on a subresource re-opens it. A real <form> with proper autocomplete
	// hints fills in one tap and only ever appears once.

	#sign(expiry: number): string {
		const mac = new Bun.CryptoHasher("sha256", this.#secret).update(String(expiry)).digest("hex");
		return `${expiry}.${mac}`;
	}

	#authorized(req: Request): boolean {
		const raw = req.headers.get("cookie") ?? "";
		const token = raw
			.split(";")
			.map(c => c.trim())
			.find(c => c.startsWith(`${COOKIE}=`))
			?.slice(COOKIE.length + 1);
		if (!token) return false;
		const expiry = Number(token.split(".")[0]);
		if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
		return timingSafeEqual(token, this.#sign(expiry));
	}

	/**
	 * `Secure` is conditional because the same server answers plain HTTP on
	 * loopback (health checks, local testing) and HTTPS through the tunnel; an
	 * unconditional `Secure` cookie is silently dropped on the loopback path.
	 */
	#setCookieHeader(req: Request): string {
		// Two independent signals rather than trusting one: cloudflared sets
		// `x-forwarded-proto`, but anything reaching this server on a non-loopback
		// Host arrived through the tunnel by construction (Bun binds 127.0.0.1
		// only), so that alone is sufficient evidence the browser leg was HTTPS.
		const host = (req.headers.get("host") ?? "").split(":")[0];
		const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
		const https = (req.headers.get("x-forwarded-proto") ?? "").includes("https") || !loopback;
		const attrs = [
			`${COOKIE}=${this.#sign(Date.now() + SESSION_MAX_AGE * 1000)}`,
			"HttpOnly",
			"SameSite=Lax",
			"Path=/",
			`Max-Age=${SESSION_MAX_AGE}`,
		];
		if (https) attrs.push("Secure");
		return attrs.join("; ");
	}

	// ── HTTP ─────────────────────────────────────────────────────────────────

	async #handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const seg = url.pathname.split("/").filter(Boolean);

		// Unauthenticated liveness only: the launchd/tunnel health check must not
		// need a credential, and it reveals nothing.
		if (url.pathname === "/healthz") return new Response("ok");

		if (url.pathname === "/login") {
			if (req.method === "POST") {
				const form = await req.formData();
				const user = String(form.get("username") ?? "");
				const pass = String(form.get("password") ?? "");
				// Compare both halves unconditionally so a wrong username and a wrong
				// password cost the same.
				const ok = timingSafeEqual(user, this.#username) === true && timingSafeEqual(pass, this.#password) === true;
				if (!ok) {
					return new Response(loginPage("Incorrect username or password.", nextOf(url)), {
						status: 401,
						headers: HTML,
					});
				}
				return new Response(null, {
					status: 303,
					headers: { location: nextOf(url), "set-cookie": this.#setCookieHeader(req) },
				});
			}
			if (this.#authorized(req)) return Response.redirect(nextOf(url), 303);
			return new Response(loginPage(undefined, nextOf(url)), { headers: HTML });
		}
		if (url.pathname === "/logout") {
			return new Response(null, {
				status: 303,
				headers: { location: "/login", "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` },
			});
		}

		if (!this.#authorized(req)) {
			// A browser navigation gets the login form; an API/SSE call gets a bare
			// 401 so the client can react without parsing HTML.
			const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
			if (!wantsHtml) return new Response("unauthorized", { status: 401 });
			const next = url.pathname + url.search;
			return Response.redirect(`/login?next=${encodeURIComponent(next)}`, 303);
		}

		if (url.pathname === "/") return new Response(UI, { headers: { "content-type": "text/html" } });
		if (url.pathname === "/api/sessions") {
			return Response.json([...this.#attached.values()].map(entry => this.#sessionSummary(entry)));
		}

		// Suggestions for the new-session form. Read-only.
		if (url.pathname === "/api/directories") {
			return Response.json(await this.#control.listDirectories());
		}

		// Start a session in a directory. Matched before the :pid block below —
		// "start" is not a pid. The session appears through ordinary room
		// discovery once its nanny has it hosting; the launchd label is deliberately
		// an implementation detail rather than an API handle.
		if (url.pathname === "/api/sessions/start") {
			if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
			let cwd: string;
			try {
				const body: unknown = await req.json();
				cwd =
					body !== null && typeof body === "object" && "cwd" in body && typeof body.cwd === "string"
						? body.cwd
						: "";
			} catch {
				return Response.json({ error: "invalid JSON body" }, { status: 400 });
			}
			try {
				const dir = await this.#control.startSession(cwd);
				this.#log(`session host requested cwd=${dir}`);
				// The resolved directory goes back so the phone remembers what the
				// server used rather than what was typed (`~/x` vs `/Users/me/x`).
				return Response.json({ ok: true, cwd: dir }, { status: 201 });
			} catch (err) {
				// Validation errors are the expected failure and worded for the phone.
				return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 422 });
			}
		}

		// /api/sessions/:pid/...
		if (seg[0] === "api" && seg[1] === "sessions" && seg[2]) {
			const entry = this.#attached.get(Number(seg[2]));
			if (!entry) return new Response("no such session", { status: 404 });
			const action = seg[3];

			if (action === "events") return this.#events(entry);

			if (req.method === "POST" && action === "prompt") {
				const { text } = (await req.json()) as { text: string };
				entry.guest.prompt(text);
				return Response.json({ ok: true });
			}
			if (req.method === "POST" && action === "interrupt") {
				const sent = entry.guest.abort();
				// Not every abort persists an aborted assistant entry — a turn stopped
				// before its first token throws instead, emitting `agent_end` with
				// nothing to record — so the phone would show no resume button for a
				// stop it just issued. Only claim it when the frame actually went out:
				// a read-only room drops it, and telling the phone a turn was cut short
				// when nothing was sent is worse than showing no button.
				if (sent) entry.guest.markInterrupted();
				return Response.json({ ok: sent });
			}
			if (req.method === "POST" && action === "resume") {
				// The play button's hidden continue prompt (INTERNAL_RESUME_PROMPT is
				// filtered out of the phone's projection). No streaming guard: a resume
				// that races a running turn queues like any other prompt.
				entry.guest.prompt(INTERNAL_RESUME_PROMPT);
				return Response.json({ ok: true });
			}
			if (req.method === "POST" && action === "ui" && seg[4]) {
				const { value } = (await req.json()) as { value?: string };
				entry.guest.answerUi(Number(seg[4]), value);
				return Response.json({ ok: true });
			}
			if (action === "transcript") return Response.json(entry.guest.transcript.slice(-TRANSCRIPT_FETCH_LIMIT));
			if (action === "todos") return Response.json(entry.guest.todos);
			if (action === "subagents") return Response.json(entry.guest.subagents);
		}
		return new Response("not found", { status: 404 });
	}

	/** SSE stream for one session. Opens with a full snapshot so a reconnecting phone renders immediately. */
	#events(entry: Attached): Response {
		const pid = entry.record.pid;
		let sendFn: (chunk: string) => void = () => {};
		const stream = new ReadableStream<Uint8Array>({
			start: controller => {
				const enc = new TextEncoder();
				sendFn = chunk => {
					try {
						controller.enqueue(enc.encode(chunk));
					} catch {
						/* client gone */
					}
				};
				let subscribers = this.#subscribers.get(pid);
				if (!subscribers) {
					subscribers = new Set();
					this.#subscribers.set(pid, subscribers);
				}
				subscribers.add(sendFn);
				sendFn(`event: state\ndata: ${JSON.stringify(entry.guest.state ?? {})}\n\n`);
				sendFn(
					`event: transcript\ndata: ${JSON.stringify(entry.guest.transcript.slice(-TRANSCRIPT_PUSH_LIMIT))}\n\n`,
				);
				sendFn(`event: todos\ndata: ${JSON.stringify(entry.guest.todos)}\n\n`);
				sendFn(`event: activity\ndata: ${JSON.stringify(entry.guest.activity)}\n\n`);
				sendFn(`event: subagents\ndata: ${JSON.stringify(entry.guest.subagents)}\n\n`);
				if (entry.guest.pendingUi) {
					sendFn(`event: ui-request\ndata: ${JSON.stringify(entry.guest.pendingUi)}\n\n`);
				}
			},
			cancel: () => {
				this.#subscribers.get(pid)?.delete(sendFn);
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				// Cloudflare and any reverse proxy in front must not buffer the stream,
				// or events arrive in bursts (or not at all) on mobile.
				"x-accel-buffering": "no",
			},
		});
	}
}

/**
 * Bring up the portal on `options.port`.
 *
 * Refusing to start unauthenticated is deliberate: a silent fallback to "no
 * auth" is exactly the failure you would not notice. This throws rather than
 * exiting so process lifetime stays with the CLI layer.
 */
export async function startPortal(options: PortalOptions): Promise<PortalHandle> {
	if (!options.username || !options.password) {
		throw new Error("portal requires a username and a password; run `omp mobile install` to store one");
	}
	return await Portal.start(options);
}

/** Constant-time compare so a token cannot be probed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Same-origin redirect target only — an open redirect here would bounce a freshly authenticated visitor off-site. */
function nextOf(url: URL): string {
	const raw = url.searchParams.get("next") ?? "/";
	return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

/**
 * Login form, styled from the same omp palette as the portal so the phone never
 * drops out of the theme. Deliberately hand-written rather than reusing the SPA
 * shell: it must render with no JS, no fetch, and no session.
 *
 * The autocomplete hints and the `action`/`method` pair are what make iOS and
 * 1Password offer to fill and then save this as a normal login.
 */
function loginPage(error: string | undefined, next: string): string {
	return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0F0b14">
<title>omp \u2014 sign in</title>
<style>
:root{color-scheme:dark;--bg:oklch(0.16 0.02 307);--bg-raised:oklch(0.19 0.022 307);--bg-inset:oklch(0.13 0.016 307);
--fg:oklch(0.92 0.01 307);--fg-muted:oklch(0.71 0.016 307);--fg-faint:oklch(0.53 0.018 307);
--accent:oklch(0.674 0.23 341);--border:oklch(1 0 0 / 9%);--border-strong:oklch(1 0 0 / 13%);
--err:oklch(0.66 0.19 25);--radius:8px}
@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){color-scheme:light;--bg:oklch(0.985 0.004 307);--bg-raised:oklch(1 0 0);
--bg-inset:oklch(0.95 0.006 307);--fg:oklch(0.26 0.03 307);--fg-muted:oklch(0.46 0.03 307);--fg-faint:oklch(0.58 0.025 307);
--border:oklch(0 0 0 / 10%);--border-strong:oklch(0 0 0 / 15%)}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);
font:400 13px/1.5 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;-webkit-font-smoothing:antialiased}
form{width:100%;max-width:320px;display:flex;flex-direction:column;gap:14px}
.brand{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
.brand b{font-size:15px;font-weight:650;letter-spacing:.01em}
.brand span{color:var(--fg-faint);font-size:11px}
label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--fg-muted)}
input{font:inherit;color:var(--fg);background:var(--bg-inset);border:1px solid var(--border);
border-radius:var(--radius);padding:11px 12px;min-height:44px}
input:focus-visible{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px oklch(0.674 0.23 341 / 22%)}
button{font:inherit;font-weight:600;min-height:44px;cursor:pointer;color:oklch(0.15 0.02 307);
background:var(--accent);border:1px solid var(--accent);border-radius:var(--radius);padding:11px 12px}
button:active{filter:brightness(.94)}
.err{color:var(--err);font-size:11px;border-left:2px solid var(--err);padding-left:8px}
</style>
</head>
<body>
<form method="POST" action="/login?next=${escapeHtml(encodeURIComponent(next))}">
	<div class="brand"><b>omp</b><span>remote access</span></div>
	${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
	<label>username
		<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
	</label>
	<label>password
		<input name="password" type="password" autocomplete="current-password" required>
	</label>
	<button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
