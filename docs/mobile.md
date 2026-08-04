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

`omp mobile serve` watches `<config-root>/run/collab/`, joins each live record's
room as a guest, and serves:

| Route | Purpose |
|---|---|
| `GET /` | The phone app (a single self-contained page) |
| `GET /healthz` | Unauthenticated liveness — health checks need it and it reveals nothing |
| `GET`/`POST /login`, `GET /logout` | Form login, signed-cookie session |
| `GET /api/sessions` | One summary per attached session |
| `GET /api/sessions/:pid/events` | SSE: `state`, `transcript`, `todos`, `subagents`, `activity`, `agent`, `ui-request`, `ui-request-end`, `closed` |
| `POST /api/sessions/:pid/prompt` | Steer the agent (`{text}`) |
| `POST /api/sessions/:pid/interrupt` | Abort the current turn — the phone's stop button, the Escape key |
| `POST /api/sessions/:pid/resume` | The resume button: send the hidden internal continue prompt |
| `POST /api/sessions/:pid/ui/:reqId` | Answer an `ask` dialog (`{value}`) |
| `GET /api/sessions/:pid/{transcript,todos,subagents}` | Snapshot fetches for a cold page load |
| `GET /api/directories` | Picker choices for the new-session form: `{home, recent[]}` |
| `POST /api/sessions/start` | Start a session in a directory (`{cwd}`), answering `{ok, cwd}` with the resolved path — see below |

### Subagents

A session that fans work out to `task` subagents shows them on the phone: a
`⟳ N agents` chip on its card in the list — N being the *running* count, so a fan-out
that has finished leaves rows in the panel but no chip — and a `Subagents` panel under
the todos in the detail view:

```text
Subagents · 2/3 running · $4.42 ▾
├ ⟳ InstallPlanAudit  scout · $1.57 · 3m
│   • Reading health.ts
├ ⟳ CollabHostAudit   scout · $1.59 · 3m
│   • Numbering state trigger events
└ ✔ PortalRouteAudit  scout · $1.26 · 3m
    96.7k tok · 15 tools
```

Two or three lines per agent: the identity line, then the spawn's label if it has one,
then a last line that changes with the state — a running agent shows the tool it is in,
a finished one shows what the run cost in tokens and tool calls. An agent with neither
a label nor anything to report is a single line. Cost is on the identity line because it
is the field most worth reading.

**The header is a collapse toggle, and it is the whole panel when collapsed.** At the
row cap the list is ~470px tall directly above the composer, for as long as the
fan-out runs — which is exactly when the transcript underneath it is worth reading, so
past four rows it starts collapsed. Everything the header states is therefore
aggregated over the whole roster rather than the capped rows: `N/M running`, spend, and
a failure count that shows *while* work is still running, because a failure is
actionable precisely then. Parked agents are counted separately from done ones — a
parked subagent has a disposed but revivable session and is often waiting on its
parent, which is not the same as finished.

**Nothing new crosses the wire for it.** The host already broadcasts its
agent-registry roster (a `agents` frame, 100ms-debounced on registry change, plus
one inside every `welcome`) and mirrors the `task:subagent:lifecycle` and
`task:subagent:progress` EventBus channels as `bus` frames — that is what feeds
the TUI's own Subagents HUD and Agent Hub for a terminal guest. The portal used to
drop both frames on the floor; it now joins them on the registry id they share.

Both halves are needed. The roster is the authoritative "which subagents exist and
are they running" but carries no work description; the bus traffic carries the
label, the live tool, tokens and cost but only flows while an agent is reporting.
So a portal that attaches mid-run knows an agent exists before it knows what the
agent is doing.

Decisions worth knowing, because each one is a departure from something:

- **The count is the TUI's count.** `running` uses exactly the status-line badge's
  predicate (`kind === "sub" && status === "running"`), so the number on the phone
  and the number in the terminal cannot disagree.
- **Sync spawns are listed too**, unlike the TUI HUD. The HUD skips a blocking
  `task` call because the parent's inline tool block already draws its progress
  live; the phone's transcript renders a tool card with no progress at all, so
  filtering here would hide running work with nothing else showing it.
- **A finished agent nothing was heard from is dropped.** The registry keeps
  finished subagents as `idle` and then `parked` until release, and rehydrates on-disk
  ones whenever something enumerates them (opening the Agent Hub, or `hub` messaging),
  so a long session's roster accumulates names from fan-outs that ended hours ago. With
  no bus traffic for them such a row
  is a name and a dim glyph, pushing live work off a phone screen. One that
  finished while the portal was watching keeps its row, with the lifecycle's
  verdict (`✔` / `✘` / `⨯`) rather than the registry's `idle` — though only once the
  roster agrees the agent stopped, since the executor's `completed` beats the
  debounced roster flip and a green tick beside a header still counting the agent as
  running is worse than a glyph one frame late.
- **A row is labelled only with a real description.** A `task` batch names each
  spawn, and that name is the registry id *and* the description until the
  tiny-model label lands, so the obvious precedence printed the id twice; and the
  raw `progress.task` is the prompt with omp's wrapper preamble, identical across
  every agent. An unlabelled row is honest — the live intent line under it already
  says what the agent is doing.
- **Pushes are throttled, not debounced.** The executor coalesces progress at 150ms
  *per agent*, so a wide fan-out streams continuously and a reset-on-change
  debounce would never fire until the last agent finished. The guest emits at most
  one `subagents` frame per 250ms, and skips a frame whose projection is unchanged —
  a settled or finished agent re-reporting, or churn confined to fields the phone does
  not render (`recentTools`, `recentOutput`). That skip cannot quiet a *live* agent,
  whose cumulative tokens and cost move on nearly every emit; the throttle is what
  bounds the radio wakeups. It works at all only because the projection quantizes the
  two numbers that would otherwise move on every single emit: the host's run duration
  is floored to whole seconds (raw, it is `Date.now() - startTime` recomputed per emit)
  and the aggregate cost is rounded to the cent. Without both, no two projections ever
  compared equal and the skip was a no-op.
- **Bus detail is pruned against the roster, not cleared on a rebind.** The host's
  agent registry is process-global and survives a `/resume`, so a detached fan-out
  still running belongs to the roster the new welcome carries; wiping the maps cost
  those agents their label and live tool. Pruning to the roster's ids also bounds the
  maps for a guest that stays attached for days.
- **Rows are capped at 8**, matching the HUD's own limit, with a `… N more` row.
  The counts are uncapped so the panel can say what it hid.

There is deliberately no per-agent transcript view. The host exposes one
(`fetch-transcript`, which the Agent Hub uses) but it needs the incremental
byte-offset protocol and a reader worth the screen; the phone answers "how many,
and what is each doing", not "what did that one say".

### The composer

Typing on a phone is the part of this app a browser fights hardest, so the
composer is mostly a list of defences against WebKit.

**Nothing zooms.** WebKit zooms the page whenever a focused control's computed
font-size is under 16px, and on iOS it never zooms back out: tapping a 12px field
once left the layout viewport wider than the screen for the rest of the visit.
Every text-entry control is therefore 16px (`--input-size`) while the rest of the
chrome stays at 12px. `user-scalable=no` and `maximum-scale=1` are not
alternatives — WebKit ignores both by design so that pinch-zoom always works,
which is the right call and the reason the size has to be the fix.

**The width is fixed.** The shell's grid column is `minmax(0,1fr)`; left implicit
it was sized to its widest item's max-content and the new-session `<select>`
reports the width of its longest option, so one deep recent directory path
stretched the whole app past the screen and made the document pannable.

**The keyboard moves the app, not the page.** Chrome on Android resizes the layout
viewport (`interactive-widget=resizes-content`) and `100dvh` handles it. iOS does
not: the layout viewport stays, only the visual one shrinks, the composer ends up
behind the keys, and WebKit scrolls the document to chase the caret with nothing
scrolling it back. So while a keyboard is up the shell is sized from the visual
viewport and the document is pinned to the top. A pinch-zoom shrinks the visual
viewport the same way and is explicitly not treated as a keyboard.

**The field grows.** A steer is regularly a paragraph or a pasted stack trace, so
it is a textarea: one row up to five, then it scrolls. Past two rows it takes the
whole composer width and `stop`/`send` wrap underneath, because sharing the row
with them leaves 16 characters a line. The layout is decided at a fixed reference
geometry — the compact width, measured with the class off — so it depends on the
text and never on what the field was doing when the question was asked; deciding
it at the current width oscillates, since the class sets the width the row count
is measured at. Enter is a newline on a soft keyboard and send on a hardware one.

**A draft belongs to its session.** The composer is one element shared by every
session, so unsent text used to follow you across a switch with `send` armed. It
is now stashed per pid, the card of a session holding one shows a `› draft` chip,
and the map is pruned against the live session list — after two consecutive
absences, because a restarting portal answers one empty list with every session
still alive. A send captures its pid before the request, so a failure that lands
after you have moved on goes back to its own session's draft rather than into
whichever composer is on screen.

### Stop and resume

Stop on the phone is the **Escape key, not a signal**: it aborts the running
turn and leaves the session exactly where it was — process, context, todos and
all. There is deliberately no way to terminate a session from the phone; a
portal that can kill processes as your user is a much bigger thing to expose
than a portal that can press Escape.

Both halves are one control in the composer, next to `send`: `stop` while a turn
runs, `resume` once one was stopped, never both. They share a fixed-width slot so
the row cannot shift under a thumb, and the stop leaves a marker in the
transcript (`⨯ stopped — the session is still open`) with the header switching to
`· stopped` — an aborted turn otherwise read exactly like one that finished, and
a prompt whose turn died before its first token looked like the agent ignoring
the user.

Resume exists for a cancelled turn. The portal derives it from the transcript —
the last assistant message's `stopReason: "aborted"` — so a turn cut short at the
terminal counts too, and it also marks the session interrupted when the portal
itself issues the abort, because a turn stopped before its first token persists
no aborted entry to derive from. Pressing it sends a real prompt carrying the
`[omp-mobile:resume]` marker. It is a real prompt on purpose: the host, the
session transcript and every other guest see exactly what drove the agent. Only
the phone's own projection drops it, matched in full rather than by prefix, so no
other participant can steer the agent with text the phone will not render. A
"continue" typed by hand always shows.

Prompts sent from the phone show up as ordinary user cards even though the host
records them as `collab-prompt` custom messages rather than plain user messages;
a prompt from another participant is labelled with its sender, so a shared
session never renders someone else's instruction as your own.

### Starting a session from the phone

`POST /api/sessions/start` asks for a session in a directory. The portal
spawns a **nanny** (`omp mobile host --cwd <dir>`), a tiny process that runs
one interactive omp under a PTY and waits for it. Two constraints shape that
design:

- **An interactive omp expects a terminal.** Under the PTY it is an ordinary
  session — `collab.autoStart` hosts its room, the record publishes, the
  portal discovers it through the same watcher as any terminal launch. There
  is no special headless mode and no second startup path to keep honest.
- **The portal must not own the PTY.** launchd restarts the portal on updates
  and crashes, and a closed PTY master takes the session with it. On macOS the
  nanny runs as its own self-removing launchd job — a sibling of the portal,
  not its descendant — so portal and sessions have independent lifetimes.
  The nanny's lifecycle lines land in `run/mobile/host.log` for the day a
  session never appears.

The directory is validated before anything spawns: absolute (with `~`
expansion), existing, and a directory. Relative input is rejected rather than
resolved — the portal's own working directory under launchd is unpredictable,
so resolving would start sessions in places you never meant.

Picking the directory is the part a phone keyboard is worst at, so typing is the
fallback rather than the interface. `GET /api/directories` answers with the home
directory as a named choice plus the working directories of recent omp sessions
(checked for existence *before* the cap, so deleted scratch directories cannot
crowd out live ones, and cached for a few seconds so a tap does not rescan every
session file). The form is a single native select — a full-height wheel on iOS and
Android — showing `<name> — <path>` with `~` for home, name first because a select
clips the tail. A final `type a path…` option reveals the free-text field for
anything not listed.

Successful starts are remembered in the browser's `localStorage` under
`omp.mobile.directories.v1`, listed as "on this phone", and the last one is
preselected when the form opens, so the common case is open and tap start. The
resolved path is what gets remembered — the start route answers with it — so
`~/x` and `/Users/me/x` stay one entry. Only successful starts are remembered, so
a rejected typo never becomes the next default, and the memory is per-browser: it
survives portal restarts and never leaves the phone. Once a start is accepted the
form stays disabled until the session appears, at which point the phone opens it
directly rather than leaving you to find it in a list of look-alike cards.

**A prompt from the phone titles the session.** Automatic titling used to hang
off the TUI's editor submit handler alone, so a session created from the phone
and steered only from the phone stayed nameless: its card read the directory
basename and `omp --resume` listed it as `Untitled · HH:MM` forever. Guest
prompts now feed the same seam, with the same skips (an already-named session,
`PI_NO_TITLE`, low-signal input like "hi") plus one of their own — the resume
button's hidden prompt, which describes an interruption rather than a task. The
title lands asynchronously and rides the next state broadcast, so the card
renames itself a moment after the first instruction.

**A session you resume stays attached.** An auto-started room is bound to the
process, not to one session, so `/resume`, `/new`, `/fork` and `/tree` rebind it
and re-welcome the portal into the session you moved to (see
[collab](./collab.md#unattended-hosting)). The portal treats a fresh `welcome` as
a full replacement and re-reads the republished record, so the card renames
itself instead of describing a session the host already left.

### The phone view is the TUI

The phone does not have a web idiom of its own. It paints omp's **fullscreen
viewport**, down to the palette, and every departure below is named and reasoned.

**The palette is the host's own theme.** `mobile/theme-css.ts` resolves whatever
`theme.dark` / `theme.light` this machine is configured with and injects it as a
`<style>` block ahead of `</head>` on both the app and the login form, overriding
the built-in `dark`/`light` values `portal-ui.html` ships with so the file still
renders standalone. The collab protocol carries session state, not appearance, and
it is shared with `collab-web` — but the portal runs on the same machine as every
session it serves, as the same user, from the same binary, so it can read the same
settings and theme files the sessions do. Resolved once per portal process: a theme
switch needs `omp mobile restart`, the same lifetime as the port and the credential.

**Four flat surfaces, no borders, no rounded corners.** The fullscreen viewport
derives a "surface ladder" from one theme key (`statusLineBg`), stepping every RGB
channel by +10 per rung on a dark theme. The light theme steps −14 rather than the
terminal's −5, the one deliberate numeric divergence: at −5 a light card measured
1.049:1 against its canvas, below the 1.5:1 floor the theme module itself sets for
"two surfaces read as two surfaces", and the phone is the one omp surface used in
daylight, where auto-brightness compresses exactly that range. The fills are the
only thing that marks a boundary anywhere in the transcript — the terminal replaced
every `╭──╮` with a filled row — so the page has no rule and no radius on it either,
and the rung separation is load-bearing rather than decorative. Geometry follows the same source: a 2-column
viewport gutter, 2 columns of card inset, one filled row above and below a card's
content, and exactly one unpainted canvas row between blocks.

**A tool call is one row until you tap it.** A settled call in the fullscreen
viewport collapses to the identity line `renderStatusLine` built for it — sigil,
title, the argument it is recognised by — and the whole card is the hit zone because
"the fill is what the pointer sees, so the fill is the target". Write and edit carry
the language icon and the `⟦+N/-M⟧` change badge their terminal headers carry; read
carries its `:start-end` selector; an edit in hashline or apply_patch mode has its
path recovered from the payload's own markers (`[PATH#TAG]`, `*** Update File:`),
because those modes' arguments are only `{ i, input }` / `{ input }`. The identity
is the row's only elastic part: the badge and the hint are fixed siblings, so a
long path clamps from the front (`…/entities/EnemyFactory.cpp`, the terminal's own
`clampPathLength` idiom) and an ellipsis can never eat the line counts. A card that
hides nothing is inert, as it is in the terminal.

Touch-screen departures, all because a phone has no hover and no laptop to fall back
to: the hint is `⟦tap⟧` rather than `⟦click to expand⟧` — the viewport's phrasing
cost 16.4 of a 390px row's 44.6 columns and named a gesture the device does not
have — a leading `cd <dir> &&` is stripped from a bash identity (the cwd is in the
status line; at 19 visible characters the prefix *was* the visible row), an expanded
card says `⟦collapse⟧` and collapses from its sticky head ONLY (a flick that fails
the movement threshold is delivered as a click, which collapsed a 200-row card and
dropped the reader thousands of pixels with no undo), and the expanded body pages
200 rows per tap of its `… N more lines` marker rather than capping at the
terminal's 10 — a tap is an explicit request to read that call, but a tool result
is unbounded and a build log through `innerHTML` is a several-second freeze.

**Reasoning is never drawn.** Not the thinking blocks in the transcript, not the
live trace that used to sit under the working line. It is what `hideThinkingBlock`
does in the TUI, chosen unconditionally here because a phone screen is the one place
where a paragraph of reasoning per turn buries the work. The items still cross the
wire and are still projected; nothing renders them.

**The status line is the composer's last row**, exactly where the fullscreen
viewport puts it, in `presets.default`'s order: `π ▶ ⬢ <model> · <thinking> ▶ ▤
<cwd> ▶ ◫ <pct>%/<window>` on the left — `context_pct` is a LEFT segment in the
default preset, and keeping it in the right group meant a 390px screen dropped the
number a reader opens the phone to check — `◀ ◈ N agents ⏱ <age>` on the right.
Overflow is resolved by **dropping** segments in the terminal's own precedence —
`path` preserved longest — rather than by squeezing them, because a squeezed row was
four ellipses naming nothing. Symbols are omp's `unicode` preset, never `nerd` (a
phone browser cannot be assumed to have a patched font), and geometric rather than
colour emoji (`▤`/`▥` for folder/scratch, `◈` for agents): an emoji is one cell in
a terminal and 1.6 cells of Apple Color Emoji in a browser, and it breaks the
monospace grid the rest of the row keeps. Two segments differ from `segments.ts`:
`⏱` is the session's age rather than the host's active-agent milliseconds, which are
not published — printed with the list card's coarseness, since a seconds-precision
age churned on every tick and disagreed with the same session's card — and the
session name is omitted because it is the first segment the terminal pops and the
header states it in full instead.

**The todos panel defaults to the terminal's collapsed policy.** A non-active phase
is its header alone, the phase window starts at the active one and spans five stages
(`subsequentStageCap`), and the active phase's tasks run `selectCollapsedTodos`'s
own selection — completed and abandoned rows omitted, active work promoted to the
head, five rows capped, a `… N more todos` summary — because rendering the whole
plan took 58% of a 390×844 viewport above the composer on a 12-task plan. The header
is a disclosure button like `Subagents`, and the full plan is one tap away, exactly
as `todoExpanded` is one key away in the TUI.

**An approval cannot leave the screen.** The ask panel is sticky to the bottom of
the scroll area, where the terminal pins its overlay, and the header gains a fourth
state, `needs answer` in the warning role — the host's `working` flag is still true
while it waits on the reader, so the two states could not share a word. Options are
fields on the canvas rung with no selection cursor (a terminal always has one row
selected; a touch screen never does), and an option that writes a permanent
allowlist entry — "and don't ask again" — is separated by a full row and marked in
the warning role.

Everything else already followed the terminal and still does: the spinner and its
intent line come from the same `agent_start` / `tool_execution_start` /
`message_update` / `agent_end` events the terminal titles its working line with,
markdown tables render as box-drawn terminal tables, the todos panel draws roman-
numbered phases over `├─`/`└─` guides with the terminal's checkbox glyphs, and tool
calls stay structured cards instead of flattened text.

One thing is knowingly inherited along with the palette: omp's theme tokens are
tuned for a terminal, not measured against WCAG, so the `dim` role that carries the
expand hint and the tree guides sits near 3.4:1 on the dark panel. Parity is the
point there — a portal-only override would make the phone and the terminal disagree
about what `dim` means — but CONTENT does not ride that tier: the tool card's
argument, table cells, the empty-state instruction and the header's state word all
take the body or muted tier, because on a phone they are information, not
decoration. Two more states follow the terminal's vocabulary: `prefers-reduced-motion`
still both infinite animations (the spinner's tick and the status dot's pulse), and
the session list's meta rows use fixed columns so context, age and pid align down a
list of look-alike sessions.

### Session discovery

A session becomes visible by **publishing its room**, and the portal reacts to
that file appearing, so a session you start shows up in milliseconds. A two-second
poll runs behind the watcher as a backstop (and re-arms the watcher if the
directory is ever deleted); the portal creates the directory at startup so the
very first session on a fresh machine is caught by the watcher too.

**The relay cannot do this discovery, and that is by design.** It forwards sealed
frames and never sees a room key, so it cannot join a room, enumerate what a room
contains, or hand a key to the portal. The published record — readable only by
your account — is the only place a key exists outside the host. Any design where
the relay could register sessions for you would be a design where the relay could
read them.

Which leaves one honest gap: a session that publishes **nothing** (started before
the services existed, or with `collab.autoStart` off) is invisible, and nothing
outside a session can make it start hosting — an interactive TUI has no control
channel. `omp mobile status` therefore lists those separately:

```text
unregistered sessions  (running, but hosting no room)
  pid 4821    no room  /Users/me/oss/oh-my-pi/packages/coding-agent/dist/omp
  → these started before the relay, or with collab.autoStart off. Restart them, or type /collab in each.
```

They are found in the process table and matched against the published records, so
the two services and any `omp <subcommand>` invocation are excluded — only actual
sessions are reported.

### What a session shows when the portal attaches

The host distinguishes the portal from a person, because "someone joined your
session" is the wrong story for a service that makes it phone-reachable:

```text
collab: Mobile relay registered this session — reachable from your phone
collab: Mobile relay disconnected — this session is no longer aggregated
```

A human guest still reads `<name> joined the collab session`. The distinction
comes from a `client` kind the guest declares in its hello (`tui`, `web`,
`mobile-portal`) — advisory only, never a permission: what a guest may *do* still
comes from the write token alone. A guest too old to declare one gets the generic
wording, which is also what a session running an older build will keep printing
until it restarts.

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
- Credential-form responses are `Cache-Control: no-store`, and a form restored
  from the browser's back/forward cache replaces itself with a GET to the same
  URL. A valid cookie therefore reaches the server-side redirect instead of
  leaving a stale login form on screen or replaying a POST-produced 401.
- Before submitting credentials, the form probes `/healthz` with a GET. If an
  identity-proxy session expired while the form was open, the probe replaces
  the page with a GET and starts reauthentication there. This avoids Cloudflare
  Access's 400 return path when its login flow is initiated by the form's POST.
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

- **never blocks the agent** — nothing on the way to the prompt awaits it, and
  it stays silent on failure, because a relay that will not start costs phone
  access, not your session;
- **is safe with many terminals at once** — a job that is merely still starting
  is left alone, and only a loaded-but-dead job is kicked. (An earlier version
  kickstarted anything not yet answering, and eight simultaneous launches spent
  seconds restarting each other's instance.) A job launchd already reports as
  `running` gets a much longer grace than a merely loaded one: at login the
  stack pages in cold and the relay can take the better part of twenty seconds
  to bind.
- **gates auto-start hosting** — the host attempt is sequenced behind the heal
  rather than racing it. A session launched at login (a restored terminal
  workspace, a window macOS reopened) otherwise beats launchd to the relay, and
  a first connect that fails is terminal: the host reconnects a connection it
  *lost*, never one that never opened, so the room is silently never published.
  The whole chain stays unawaited, so the prompt is not delayed;
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
installed. A session started while the relay was still coming up now waits for
the healer before it hosts, so the login race no longer leaves one silently
unpublished; a session that predates the relay's *install*, or that failed to
host anyway, does not retroactively host. Restart it, or type `/collab` in it.

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
