# Mobile: reach every running session from a phone

`omp mobile` turns the machine you code on into a phone-facing control plane for
every omp session running on it. Each session hosts an end-to-end encrypted
collab room on a loopback relay; a local portal joins every room as a guest and
re-serves them as one authenticated app, so a phone can watch progress, steer a
session, and answer the questions and tool-approval prompts an agent raises.

It is built on two existing pieces — [`collab`](./collab.md) rooms and the
`collab.publishLink` discovery records — plus two supervised services and one
install command.

## Quick start

```sh
omp mobile install          # services, credential, settings, health check
omp mobile status           # what is up, what is reachable, which sessions are live
open http://127.0.0.1:4097  # log in as "omp" with the generated password
```

`install` is idempotent and one-shot. It:

1. generates a portal password in the login Keychain (service `omp-mobile`) if
   there is not one already — an existing password is kept, so a rotation never
   happens behind your back;
2. writes two LaunchAgents that re-run **this** omp binary as `omp mobile relay`
   and `omp mobile serve`;
3. loads them, waits for both health endpoints, and reports what it did;
4. turns on `collab.autoStart`, `collab.publishLink` and points
   `collab.relayUrl` at the relay it just installed — a session that hosts no
   room has nothing for the portal to serve. An existing `view` share stays
   read-only.

Nothing else is required, and nothing outside the repo is needed to set it up:
the two plists it generates and the Keychain item are the only artifacts it
creates.

### Commands

| Command | Effect |
|---|---|
| `omp mobile install` | Install/refresh both services, credential and settings, then verify |
| `omp mobile status` | Install state, settings, launchd state, endpoint probes, live sessions, log paths |
| `omp mobile start` \| `stop` \| `restart` | Service control; `--service relay\|portal` narrows it |
| `omp mobile update` | Rebuild the binary from its checkout, reinstall the jobs, restart, verify |
| `omp mobile logs` | Tail both services’ stdout/stderr (`--service`, `--lines`, `--follow`) |
| `omp mobile password` | Rotate the portal password and restart the portal |
| `omp mobile uninstall` | Unload and delete both LaunchAgents (`--purge` also deletes the password) |
| `omp mobile serve` \| `relay` | Run one service in the foreground — what the LaunchAgents run |

Every action takes `--json`; `install`, `uninstall` and `update` take
`--dry-run` (`-n`) and change nothing.

## Architecture

```text
omp #1 ─┐
omp #2 ─┼─ wss (AES-256-GCM, loopback) ─► relay 127.0.0.1:7466 ─┐
omp #N ─┘                                                       │ guest sockets
   │  publishes <config-root>/run/collab/<pid>.json              ▼
   └──────────────────────────────────────────────► portal 127.0.0.1:4097
                                                                 │
Phone ──[ your tunnel + identity proxy ]─────────────────────────┘
                                          HTTP + SSE (no WebSocket)
```

**Both services bind `127.0.0.1` only.** That is the security invariant of the
whole design: remote access is something you put *in front* (see
[Remote access](#remote-access)), never a wider bind.

**The phone leg is HTTP + SSE, never WebSocket.** An identity proxy answers an
unauthenticated request with a redirect to its login page, and a browser cannot
follow a redirect on a WebSocket handshake — the socket fails opaquely while the
rest of the app works. SSE also dodges proxy WebSocket idle timeouts. Every
WebSocket in this design is loopback-only.

### The relay

`omp mobile relay` is a content-blind room switch: it forwards sealed frames
between one host and its guests and never sees plaintext. It is the same wire
contract as the public relay (`packages/collab-web/scripts/local-relay.ts` is
the dev equivalent), with one difference that matters — it binds loopback.

### The portal

`omp mobile serve` scans `<config-root>/run/collab/` every two seconds, joins
each live record's room as a guest, and serves:

| Route | Purpose |
|---|---|
| `GET /` | The phone app (a single self-contained page) |
| `GET /healthz` | Unauthenticated liveness — health checks need it and it reveals nothing |
| `GET`/`POST /login`, `GET /logout` | Form login, signed-cookie session |
| `GET /api/sessions` | One summary per attached session |
| `GET /api/sessions/:pid/events` | SSE: `state`, `transcript`, `todos`, `activity`, `ui-request`, `ui-request-end`, `closed` |
| `POST /api/sessions/:pid/prompt` | Steer the agent (`{text}`) |
| `POST /api/sessions/:pid/interrupt` | Abort the current turn |
| `POST /api/sessions/:pid/ui/:reqId` | Answer an `ask` dialog (`{value}`) |
| `GET /api/sessions/:pid/{transcript,todos}` | Snapshot fetches for a cold page load |

The phone view mirrors the TUI rather than inventing a web idiom: the spinner and
its activity line come from the same `agent_start` / `tool_execution_start` /
`message_update` / `agent_end` events the terminal titles its working line with,
markdown tables render as box-drawn terminal tables, and tool calls stay
structured cards instead of flattened text.

**A session you resume stays attached.** An auto-started room is bound to the
process, not to one session, so `/resume`, `/new`, `/fork` and `/tree` rebind it
and re-welcome the portal into the session you moved to (see
[collab](./collab.md#unattended-hosting)). The portal treats a fresh `welcome` as
a full replacement and re-reads the republished record, so the card renames
itself instead of describing a session the host already left.

## Auth

> [!WARNING]
> **Treat access to the portal as the ability to run commands as this user.** It
> can prompt agents and approve their tool calls. Do not expose it without an
> identity boundary in front, and never bind it to a public interface.

The portal requires a form login and issues an HMAC-signed session cookie
(`omp_session`, HttpOnly, SameSite=Lax, 30 days). Notes that matter:

- **Cookies are signed, not stored.** launchd restarts the service; an in-memory
  session table would log the phone out on every restart. The signing key is
  derived from the username and password, so rotating the password invalidates
  every live cookie for free.
- **The password lives only in the login Keychain** (service `omp-mobile`,
  account = your username), and is never passed as a process argument —
  `install` and `password` feed it to `security -i` over stdin, because argv is
  readable through `ps`. `OMP_MOBILE_PASSWORD` exists for containers and
  throwaway foreground runs.
- **There is no unauthenticated mode.** A portal with no credential refuses to
  start rather than serving anonymously.
- Browser navigations without a cookie get `303 → /login?next=…` (same-origin
  targets only); API and SSE calls get a bare `401` so the client can react
  without parsing HTML. `omp mobile status` asserts both.
- `Secure` is set on the cookie only when the request arrived over HTTPS
  (`x-forwarded-proto`) or through a non-loopback `Host`. An unconditional
  `Secure` cookie is silently dropped on the loopback path, which breaks local
  testing.

Read the password back with:

```sh
security find-generic-password -a "$(id -un)" -s omp-mobile -w
```

## Remote access

`omp mobile` deliberately stops at the loopback boundary — it installs no tunnel
and touches no DNS. To reach the portal from a phone, put a tunnel and an
identity proxy in front of `http://127.0.0.1:<portal port>`; Cloudflare Tunnel +
Access, Tailscale Serve/Funnel, or an SSH port-forward all work.

Whatever you choose:

- **Create the identity policy before the public hostname exists.** Between a
  route existing and a policy existing, the portal is open to the internet.
- **Verify that an unauthenticated request is redirected, not served**, from
  outside the machine.
- Give the proxy a generous idle timeout: the SSE stream is long-lived (the
  portal sets `idleTimeout: 255`), and it must not buffer responses
  (`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` are set
  for proxies that honour them).
- The form login stays useful even behind a proxy: it is the defence-in-depth
  layer for the day the tunnel or the policy is misconfigured.

## Files and state

| Purpose | Path |
|---|---|
| Install record (ports, launch argv, enabled flag) | `<config-root>/run/mobile/state.json` (`0600`) |
| Discovered rooms | `<config-root>/run/collab/<pid>.json` (`0700` dir, `0600` records) |
| LaunchAgents | `~/Library/LaunchAgents/sh.omp.mobile-{relay,portal}.plist` |
| Service logs | `~/Library/Logs/sh.omp.mobile-{relay,portal}.{out,err}.log` |
| Portal password | login Keychain, service `omp-mobile` |

`<config-root>` follows `PI_CONFIG_DIR` and `--profile`, so a profile manages its
own install record. launchd labels are global, so one machine runs one relay and
one portal; a second profile that wants its own pair needs different ports.

## Boot path and self-healing

launchd covers the normal cases (`RunAtLoad` + `KeepAlive`). What it does not
cover is a crash still inside `ThrottleInterval`, a job booted out by hand, or
the first session started after an install — all of which leave a session
hosting a room nothing aggregates.

So every interactive launch, when `collab.autoStart` is on, probes both health
endpoints and heals what is down. It:

- **never blocks the agent** — it runs unawaited and stays silent on failure,
  because a relay that will not start costs phone access, not your session;
- **is safe with many terminals at once** — a job that is merely still starting
  is left alone, and only a loaded-but-dead job is kicked. (An earlier version
  kickstarted anything not yet answering, and eight simultaneous launches spent
  seconds restarting each other's instance.)
- **respects `omp mobile stop`** — that clears `enabled` in the install record,
  and the healer honours it. Use `omp mobile start` to bring them back.

## Verification

```sh
# 1. loopback only — must be 127.0.0.1, never 0.0.0.0
lsof -nP -iTCP:4097 -sTCP:LISTEN
lsof -nP -iTCP:7466 -sTCP:LISTEN

# 2. the login gate: a browser navigation bounces, the API 401s, health is open
curl -o /dev/null -w '%{http_code}\n' -H 'accept: text/html' http://127.0.0.1:4097/   # 303
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4097/api/sessions              # 401
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4097/login                     # 200
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4097/healthz                   # 200

# 3. everything at once, including live sessions
omp mobile status
```

`omp mobile status` exits non-zero when the stack is installed and enabled but
something does not answer, so it works as a monitor check.

## Troubleshooting

**No sessions listed.** Sessions only publish rooms with `collab.autoStart` set
to `full` or `view` and `collab.publishLink` on — `omp mobile status` prints
both, and flags a `collab.relayUrl` that points somewhere other than the relay it
installed. Sessions started before the relay came up do not retroactively host;
restart them.

**`omp mobile status` shows the services running but nothing reachable.** Read
the service log: `omp mobile logs --service portal`. The most common cause is a
missing credential (the portal refuses to start without one) — `omp mobile
install` fixes it.

**A card names a session I resumed away from.** The rebind that renames it is a
host-side behaviour; check that the session runs a build that has it (see
[collab](./collab.md#unattended-hosting)). A room shared by a hand-typed
`/collab` is bound to one session on purpose and ends on a switch.

**Everything is healthy locally but the phone cannot connect.** That is the
tunnel or identity layer, not this stack: check that the hostname resolves, that
an unauthenticated request is redirected to your identity provider, and that the
proxy is not buffering SSE.

**`bootstrap failed: 5: Input/output error`.** launchd still had the old job when
a new one was loaded. `omp mobile install` waits for the unload and retries, so
re-running it is the fix; a stale hand-installed job with the same label must be
`launchctl bootout`-ed first.

## Architecture notes

- The services re-enter the same omp binary (`omp mobile relay|serve`) rather
  than shipping separate scripts. That is what makes the stack self-contained:
  install has no interpreter, path or dependency assumptions beyond the binary
  it is already running, and `omp mobile update` can rebuild and reload it.
- The planner (`src/mobile/service.ts`) is pure and platform-free: it renders
  argv, plists, log paths and health URLs from the ports, so a service can never
  be installed at one port and probed at another, and the whole plan is
  assertable in tests on any OS. Only `launchctl`/`security` calls are macOS-only.
- The portal reuses omp's own collab client (`CollabSocket`, `parseCollabLink`,
  the `CollabFrame` union) instead of reimplementing the wire format, so the
  room protocol has exactly one implementation on each side.
