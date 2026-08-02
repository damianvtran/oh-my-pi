Schedules a **self-prompt** that arrives later in **this same session**. When it fires you get a normal user-attributed turn carrying `message`, and you act on it then.

## Operations

|Call|Effect|
|---|---|
|`wake({message, at})`|Fire once at `at`|
|`wake({message, every, until})`|Fire every `every` until `until`|
|`wake({message, every, limit})`|Fire every `every`, `limit` times|
|`wake({message, at, every})`|Start the cadence at `at` (e.g. daily on the hour)|
|`wake({op:"list"})`|Show armed wakes with their ids|
|`wake({op:"cancel", id})`|Retire one wake and purge its already-fired queued deliveries|

## `at` / `until` forms

|Form|Means|
|---|---|
|`+90m`|Relative: `45s` `30m` `2h` `7d` `1w`|
|`14:30`|Next local occurrence of that clock time|
|`2026-08-04T09:00:00Z`|ISO-8601 timestamp|

`every` takes a bare duration only (`15m`, `4h`, `1d`). Bare numbers are rejected everywhere — `every: 60` is ambiguous.

## When to reach for it — unprompted

- User asks for work **in the future**: "tomorrow morning", "after the deploy", "at midnight", "in two hours".
- User asks for **repeated observation over time**: watch a pipeline, poll a rollout, track a metric, follow up until something changes.
- A check you cannot finish now because the world has to move first. Scheduling a wake beats reporting "I'll need to check later" — you can actually check later.

**You pick the cadence, not the user.** They describe the goal ("keep an eye on the release"); you choose `every: "10m"` vs `every: "1h"` from how fast the thing moves and how costly a turn is. Never ask them for an interval you can infer.

## Rules

- Write `message` as an instruction to your future self: what to check, what counts as a change, and what to do about it. It arrives with no other context from now.
- **`every` needs a bound**: pass `until` or `limit`, or state in your reply the condition under which you will cancel. An unbounded cadence with no cancel plan burns the session down.
- **Cancel when the longitudinal goal is met.** The moment the pipeline went green, the metric settled, the answer arrived — `wake({op:"cancel", id})`. Cancellation stops future firings and purges already-fired deliveries still waiting in the follow-up queue; the result reports how many it removed. Every delivery echoes the exact cancel call; use it. Leaving a satisfied watch armed is a defect.
- Lost the id? `wake({op:"list"})`. Never guess.
- One op per call. `op:"list"` with `message`, or `op:"cancel"` with `every`, is rejected outright — nothing is scheduled or cancelled.

## Limits

|Limit|Value|
|---|---|
|Minimum `every`|1 minute — a wake starts a full turn|
|Maximum armed wakes|16 per session|
|`message` length|2000 chars|

## Failure mode — know this before you promise anything

A wake only fires **while the session is alive**. It is not a cron job and it does not run on a server.

- Session closed at the scheduled time ⇒ nothing fires then.
- Resuming the session **re-arms** every still-live schedule.
- A wake that came due while the session was gone fires **once** on resume — missed intervals are not replayed.

So a wake is reliable for "later today, while we're working" and for anything the user will still have open. It is not a guarantee for "in three weeks". Say so plainly rather than implying durable delivery.
