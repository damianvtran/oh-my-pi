/**
 * Loopback collab relay — the `relay` half of `omp mobile`.
 *
 * omp sessions dial this to host a room; the portal joins each room as a guest.
 * It is content-blind by construction: every payload is sealed AES-256-GCM by
 * the endpoints, and the only thing this process understands is the 4-byte peer
 * envelope used for routing.
 *
 * Why this exists rather than `packages/collab-web/scripts/local-relay.ts`:
 *   1. That script omits `hostname`, so `Bun.serve` binds 0.0.0.0 — fine for a
 *      dev stand-in, wrong for a login-time service, which would put a relay on
 *      the LAN. This binds loopback, matching the portal: a tunnel in front of
 *      these ports is the only remote path into this machine.
 *   2. It is a `scripts/` entry in a package the omp binary does not bundle, and
 *      it takes its port from argv rather than from an installed service plan. A
 *      launchd job needs a module the compiled binary can reach and a caller
 *      that owns process lifetime.
 *
 * Protocol contract (mirrors the upstream reference implementation — the bytes
 * here are what live sessions and browser guests already speak, so none of it
 * may drift):
 *   GET /r/<roomId>?role=host|guest  upgrades to a WebSocket.
 *   The host creates the room; a second host is rejected with 4009, and a guest
 *   joining a missing room with 4004.
 *   Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N
 *   targets that guest — forwarded unchanged either way.
 *   Guest binary frames: the first 4 envelope bytes are rewritten to the
 *   sender's peerId, then forwarded to the host.
 *   TEXT control to the host: {"t":"peer-joined","peer":N} / {"t":"peer-left","peer":N}.
 *   Host disconnect: TEXT {"t":"room-closed"} to every guest, then close 4001.
 */
import { ENVELOPE_HEADER_LENGTH } from "../collab/protocol";
import { DEFAULT_RELAY_PORT } from "./paths";

/**
 * Deliberately wider than omp's own ids (`ROOM_ID_BYTES` = 16 → 22 base64url
 * chars): the relay routes for any client that speaks the envelope, and the
 * bound is a sanity check on the path, not an identity check.
 */
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface RelayHandle {
	readonly port: number;
	/** Closes every room and stops the server. */
	stop(): void;
}

/**
 * Bring up the relay. The port comes from the caller (the installed service
 * plan), never from the environment, so the plist is the single source of truth
 * for what got installed; `process.exit` is likewise the CLI's business.
 */
export function startRelay(options: { port?: number } = {}): RelayHandle {
	const requestedPort = options.port ?? DEFAULT_RELAY_PORT;
	const rooms = new Map<string, Room>();

	// stdout IS the launchd log for this job, so lifecycle lines go there. The
	// file is already service-specific, hence no `[relay]` tag — just a timestamp,
	// which launchd does not add.
	const log = (msg: string): void => console.log(`${new Date().toISOString()} ${msg}`);

	const server = Bun.serve<SocketData>({
		port: requestedPort,
		// The invariant that makes this safe to run at login.
		hostname: "127.0.0.1",
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);

			// Liveness for the installer and for `omp mobile status`. Deliberately
			// not a room listing: room ids are the only thing this process knows,
			// and it has no reason to hand them out.
			if (url.pathname === "/healthz") {
				return Response.json({ ok: true, rooms: rooms.size, uptimeSec: Math.round(process.uptime()) });
			}

			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) return new Response("not found", { status: 404 });

			const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			open(ws: RelaySocket): void {
				const { roomId, role } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					log(`room open ${roomId} (${rooms.size} live)`);
					return;
				}
				const room = rooms.get(roomId);
				if (!room) {
					ws.close(4004, "no such room");
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			},

			message(ws: RelaySocket, message: string | Buffer): void {
				// Clients never send TEXT; control frames only ever flow relay -> client.
				if (typeof message === "string") return;
				const room = rooms.get(ws.data.roomId);
				if (!room || message.byteLength < ENVELOPE_HEADER_LENGTH) return;

				// Buffer's big-endian accessors rather than `unpackEnvelope` /
				// `rewriteEnvelopePeer` from ../collab/protocol: those wrap the frame in
				// a fresh DataView (and an object) per call, and this is the one hot
				// path in the process — every frame in both directions lands here.
				if (ws.data.role === "host") {
					const target = message.readUInt32BE(0);
					if (target === 0) for (const guest of room.guests.values()) guest.send(message);
					else room.guests.get(target)?.send(message);
					return;
				}
				// Stamp the sender so the host cannot be lied to about which guest sent
				// a frame — the one piece of trust this content-blind relay provides.
				message.writeUInt32BE(ws.data.peerId, 0);
				room.host.send(message);
			},

			close(ws: RelaySocket): void {
				const { roomId, role, peerId } = ws.data;
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					// A rejected second host must not tear down the live room.
					if (room.host !== ws) return;
					rooms.delete(roomId);
					const closure = JSON.stringify({ t: "room-closed" });
					for (const guest of room.guests.values()) {
						guest.send(closure);
						guest.close(4001, "room closed");
					}
					room.guests.clear();
					log(`room close ${roomId} (${rooms.size} live)`);
					return;
				}
				if (room.guests.delete(peerId)) room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
			},
		},
	});

	const port = server.port ?? requestedPort;
	log(`listening ws://127.0.0.1:${port} (loopback only)`);

	return {
		port,
		stop(): void {
			void server.stop(true);
		},
	};
}
