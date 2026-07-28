# wake

> Schedules a self-prompt that arrives later in the same session — once at a time, or on a bounded cadence — and lists or cancels the schedules it created.

## Source
- Entry: `packages/coding-agent/src/tools/wake.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wake.md`
- Key collaborators:
  - `packages/coding-agent/src/wake/schedule.ts` — schedule shape, `at`/`every`/`until` parsing, recurrence math, and all create-time validation (`buildWakeSchedule`).
  - `packages/coding-agent/src/wake/scheduler.ts` — arms the timers, fires due schedules, retires them.
  - `packages/coding-agent/src/wake/store.ts` — transcript persistence (`wake_schedules` custom entry) and the delivered message text.
  - `packages/coding-agent/src/session/agent-session.ts` — owns the live list (`getWakeSchedules` / `setWakeSchedules`) and injects a fired wake into the conversation.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates it to top-level sessions.

## What a wake is

A **wake** is a message you (the agent) address to your own future self. Nothing external runs it: the session's own scheduler holds a timer, and when it expires the message is injected into the live conversation as a user-attributed turn. It shows up in the transcript, and the agent takes a normal turn on it.

That makes it right for "check back on this later" and "keep watching this while we work", and wrong for anything needing a guarantee that survives the session being closed. See [Lifecycle & persistence](#lifecycle--persistence).

## Inputs

Every field is optional; `op` selects the branch.

| Op | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| *(omitted)* — create | `message`, plus `at` or `every` (or both) | `until`, `limit` | Validates the request and appends a new schedule. Returns the assigned id. |
| `list` | None | None | Read-only listing of every armed schedule. |
| `cancel` | `id` | None | Removes that schedule. |

### Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"list" \| "cancel"` | No | Omit to create. |
| `message` | `string` | For create | The prompt delivered when the wake fires. Capped at 2000 characters. |
| `at` | `string` | For create, unless `every` is given | When the first (or only) delivery happens. |
| `every` | `string` | For create, unless `at` is given | Recurrence interval. Minimum 1 minute. |
| `until` | `string` | No | Hard stop; same forms as `at`. Must be in the future and not before the first delivery. |
| `limit` | `number` | No | Retire after this many deliveries. Positive integer; a value above 1 requires `every`. |
| `id` | `string` | For `cancel` | The `w<N>` handle returned when the wake was created. |

### Time formats

`at` and `until` accept three forms, tried in this order:

| Form | Example | Means |
| --- | --- | --- |
| Relative duration | `+90m`, `+7d` | That far from now. Units: `s` `m` `h` `d` `w`. |
| Clock time | `14:30`, `00:00` | The next local occurrence of that wall-clock time. |
| ISO-8601 | `2026-08-04T09:00:00Z` | That instant. |

`every` takes a bare duration only (`45s` is parseable but below the floor; `15m`, `4h`, `1d`, `1w` are typical). A bare number is rejected everywhere — `every: 60` reads as both seconds and milliseconds depending on who wrote it.

## Worked examples

```js
// Once, at the next local midnight.
wake({ at: "00:00", message: "Post the end-of-day summary of what landed today." })
// → Wake w1 scheduled — in 6h (00:00)

// Hourly for a week.
wake({ every: "1h", until: "+7d", message: "Check MR !412's pipeline; report only if it changed state." })
// → Wake w2 scheduled — in 1h (15:30) · every 1h · until Aug 4 14:30

// Daily at 09:00 — a past `at` combined with `every` rolls forward to the next live slot.
wake({ at: "09:00", every: "1d", message: "Re-run the flake triage and update the tally." })
// → Wake w3 scheduled — in 19h (Jul 29 09:00) · every 1d

// Eight checks, then it retires itself.
wake({ every: "15m", limit: 8, message: "Poll the rollout; cancel early if it goes green." })
// → Wake w4 scheduled — in 15m (14:45) · every 15m · 0/8 fired

wake({ op: "list" })
// → 4 wakes scheduled:
//   w1 — in 6h (00:00) — Post the end-of-day summary of what landed today.
//   …

wake({ op: "cancel", id: "w4" })
// → Wake w4 cancelled (was in 15m (14:45) · every 15m · 0/8 fired). 3 wakes still scheduled.
```

## Outputs

A single-shot `AgentToolResult`:

- `content`: one text part.
  - **create** — the schedule line (`Wake w1 scheduled — in 4h (14:30) · every 1h · until Aug 4 09:00`), the exact cancel call to use later, and the live count when more than one wake is armed.
  - **list** — `No wakes scheduled.`, or a count header followed by one `id — schedule — message preview` line per wake.
  - **cancel** — confirmation naming the retired id, the schedule it had, and how many remain.
  - On rejection, the text is the explanatory sentence and `isError: true` is set.
- `details` (`WakeToolDetails`):
  - `op: "create" | "list" | "cancel"`
  - `schedules: WakeSchedule[]` — the list **after** the call (the pre-call list on a rejection)
  - `targetId?: string` — the id created or retired
  - `nowMs: number` — the clock the text was computed against, so the TUI renderer shows the same relative times on every repaint instead of recomputing them at paint time

`WakeSchedule`: `{ id, message, nextDueAt, everyMs?, untilAt?, limit?, firedCount, createdAt }`.

## What a delivery looks like

When a wake fires, the session injects one envelope line, a blank line, then `message`:

```
⏰ Scheduled wake w2 (2/168, every 1h) — cancel with `wake({op:"cancel",id:"w2"})` once its goal is met.

Check MR !412's pipeline; report only if it changed state.
```

A one-shot header reads `⏰ Scheduled wake w1 (one-shot).`, and the last delivery of a bounded schedule reads `(168/168, final delivery)`.

Delivery uses the session's follow-up path: a wake **never interrupts an in-flight turn**. If the agent is mid-turn the wake queues and starts the next turn; if the session is idle it starts a turn immediately.

## Lifecycle & persistence

- Schedules are stored on the session branch, so they survive a reload: resume, fork, rewind, tree navigation, handoff, and compaction all re-read them and re-arm the timers.
- **A wake only fires while the session is alive.** It is not a cron job and nothing runs on a server. With the session closed, nothing is delivered at the scheduled time.
- On resume, a schedule that came due while the session was gone fires **once**. Missed intervals are not replayed — a 1-minute cadence that was away for a day does not deliver 1440 turns.
- Timers are `unref`'d and re-checked at most every 60 seconds, so a long horizon survives laptop sleep and wall-clock changes.
- A schedule retires when its `limit` is reached, when it passes `until`, after a one-shot fires, or when it is cancelled.
- Subagents do not get the tool: a subagent's session is disposed the moment it yields, so a wake it armed could never fire. `WakeTool.createIf` returns `null` for `taskDepth > 0`.

## Limits & caps

| Limit | Value | Source |
| --- | --- | --- |
| Minimum `every` | 1 minute (`MIN_WAKE_INTERVAL_MS`) | A wake starts a full agent turn; a sub-minute cadence outruns its own turns. |
| Maximum armed schedules | 16 (`MAX_WAKE_SCHEDULES`) | `src/wake/schedule.ts` |
| `message` length | 2000 chars (`MAX_WAKE_MESSAGE_CHARS`) | A wake is an instruction, not a payload. |
| Past-`at` grace | 5 seconds | Absorbs clock skew between the model composing the call and the tool running it. |
| Message preview in listings | 80 chars | `src/tools/wake.ts` |
| Execution mode | `concurrency = "exclusive"`, `strict = true`, `loadMode = "discoverable"`, `approval = "read"` | `src/tools/wake.ts` |

## Errors

All rejections come back as `isError: true` with a sentence to act on; the schedule list is left untouched.

Create-time (from `buildWakeSchedule`):
- `message` missing/empty, or over the character cap
- `MAX_WAKE_SCHEDULES` already reached
- neither `at` nor `every` given
- unparseable `at`, `every`, or `until`
- `every` below the 1-minute floor
- `at` in the past for a one-shot (a past `at` **with** `every` is fine — it rolls forward)
- `until` not in the future, or before the first delivery
- `limit` not a positive integer, or `limit > 1` without `every`

Op-routing:
- `op: "cancel"` without `id`
- `op: "cancel"` with an unknown `id` — the error names the live ids
- mixed ops: `op: "list"` with any other argument, `op: "cancel"` with a create field, or `id` on a create call. These are rejected rather than silently dropped, because quietly ignoring `message` on a `list` call would leave the agent believing it had scheduled work that never existed.

## The `/wake` command

`/wake` gives the user the same view without a model turn:

| Command | Effect |
| --- | --- |
| `/wake` | List armed schedules with ids, next fire time, cadence, and bound |
| `/wake cancel <id>` | Cancel one schedule |
| `/wake cancel all` | Cancel every schedule |

The user cannot create a wake from the command — cadence is the agent's call, made from the goal the user described. Ask for the outcome ("keep an eye on the release"), not the interval.

## Notes
- Ids are per-session (`w1`, `w2`, …). The next id is one past the highest **live** id, so numbers get reused once the wakes above them retire — treat an id as a handle for as long as its wake exists, not as a permanent name.
- `every` alone schedules the first delivery one interval out, not immediately: the agent's current turn already covers "now".
- Combining `at` with `every` phases a cadence to a wall-clock boundary — `at: "09:00", every: "1d"` is "daily at 09:00", not "daily, starting whenever this ran".
- The transcript block is rendered by `wakeToolRenderer`: an inline `⏰ Wake` status line merged with the call, one row per schedule, expanding to show each wake's message preview.
