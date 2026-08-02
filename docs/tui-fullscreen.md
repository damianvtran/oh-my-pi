# TUI fullscreen viewport: the pointer contract

The companion to [`tui-core-renderer.md`](./tui-core-renderer.md). That document
describes `viewportMode: "append"`: the transcript lives on the terminal's
normal screen, rows commit into native scrollback exactly once and are never
rewritten, and every invariant it states is a statement about protecting that
history. This document describes the other mode, where **there is no history to
protect**, and the engine takes ownership of scrolling, selection and the
pointer instead.

Scope:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts): `ViewportMode`, `FullscreenPinBoundary`, the scroll API, the pointer router, `#renderFullscreenFrame`, `#emitAltFrame`.
- [`packages/tui/src/hit-zones.ts`](../packages/tui/src/hit-zones.ts): the zone model and the container walk.
- [`packages/tui/src/selection.ts`](../packages/tui/src/selection.ts): drag-select state, reverse-video painting, clipboard text extraction.
- [`packages/tui/src/components/box.ts`](../packages/tui/src/components/box.ts): the zone walk for the one non-`Container` layout node in the transcript path.
- [`packages/coding-agent/src/modes/components/collapsible-block.ts`](../packages/coding-agent/src/modes/components/collapsible-block.ts) and [`subagent-footer.ts`](../packages/coding-agent/src/modes/components/subagent-footer.ts): the app-layer targets.
- [`packages/coding-agent/src/tools/render-utils.ts`](../packages/coding-agent/src/tools/render-utils.ts): `isFullscreenViewport()`, the overflow probe, header decoration.

---

## 1. Two modes, and the tradeoff each makes

`TUI.viewportMode` is `"append"` or `"fullscreen"`, selected by the
`tui.viewport` setting and flipped at runtime by
`InteractiveMode.toggleViewportMode()` (which also persists the choice). The
mode is set at `TUI` construction, before anything paints: entering the
alternate screen after the first frame would strand that frame in the user's
scrollback, where it reappears the moment omp exits.

**`append`** keeps the transcript on the normal screen. Scrolling, selection,
copy and the terminal's own find are the emulator's job, and they keep working
after omp exits because the transcript is still in the terminal's history.

**`fullscreen`** enters the alternate screen (`CSI ? 1049 h`) and turns on SGR
mouse reporting (`CSI ? 1000 h`, `CSI ? 1003 h`, `CSI ? 1006 h`). What that
buys and what it costs:

| Gained | Lost |
|---|---|
| Scrolling the transcript inside omp, with sticky-bottom follow | Native scrollback: the alternate screen has none, and the transcript is gone from the terminal when omp exits |
| Clickable regions (collapse/expand a block, drill into a subagent) | Native selection: mouse reporting takes the pointer away from the emulator |
| Hover feedback on interactive rows | Native copy, for the same reason |
| A pinned bottom chrome that never scrolls away | The terminal's find/search, which only searches its own buffer |

Two of those losses are recovered in-app: `selection.ts` implements
drag-to-select with copy on release, wired to the clipboard by
`InteractiveMode`. Scrollback and terminal find are not recovered and are not
recoverable. That is the price of the mode, and it is why `append` remains the
default.

### This is not an omp limitation

Enabling mouse reporting means the terminal forwards button presses to the
application instead of acting on them. Every TUI that wants clickable regions
pays this, and no renderer can route a pointer event to a row that has already
been committed to the terminal's own history: a committed row is bytes in the
emulator's buffer, not a node in any structure the application still holds.

OpenTUI, the engine behind opencode, hits exactly the same wall. Its
`split-footer` screen mode is the direct analogue of `append`: the renderer
owns only the bottom `footerHeight` rows, its frame buffer and its per-cell hit
grid are both allocated at that size, and everything above is one-way
scrollback commits it never repaints. A mouse report whose row lands above the
footer is rejected outright, by an explicit offset guard that runs before any
hit test, and can never reach a component.

opencode does not even try to work around it. Its split-footer surface
(`opencode run`) boots with mouse reporting disabled entirely, so the emulator
keeps its selection across the whole screen. The opencode TUI that *does*
implement copy-on-release runs on the alternate screen, which is the same
tradeoff omp's fullscreen mode makes and the reason `selection.ts` exists.

So the choice is not "omp's renderer versus a better one". It is
**committed-history-with-native-affordances** versus
**app-owned-viewport-with-app-affordances**, and no engine gets both at once
for the same rows.

---

## 2. Layout: one partition, one sentinel

Fullscreen layout is a two-way partition of the **root children**, decided by
the first child that reports `isFullscreenPinned() === true`:

```
root children:  [ chat, pending, todo, subagentHUD, … | boundary, footer, status, statusLine, hooks, editor, hooks ]
                └──────── scrolling region ─────────┘ └──────── pinned to the base ────────┘
```

Everything before the boundary composes into the **scroll frame** and is
windowed by the scroll offset. Everything from the boundary down composes into
the **pinned run** and is welded to the bottom of the viewport.

Pinning is a partition, not a per-child flag. The first child that reports
pinned begins the pinned run and every child after it is pinned too.
Interleaved pinned and scrolling regions have no sensible scroll semantics, and
the real layout never wants them: transcript and HUDs above, chrome below.

The boundary itself is `FullscreenPinBoundary`, a component that renders zero
rows and answers `true`. A sentinel beats tagging the chrome containers:

- The boundary is declared **once**, at the root composition site in
  `interactive-mode.ts`, where the layout order is actually visible and
  reviewable. Tagging would smear one bit across five container instances, each
  of which would need a bespoke subclass to carry it.
- Zero rows means `append` mode is bit-identical with or without it. A tagged
  container would need the flag ignored on the append path; a sentinel needs
  nothing.

The pinned run is clamped: it gets the rows it asks for, but never more than
`height - 3`, so a composer expanded to twenty lines cannot squeeze the
transcript to nothing. When it does not fit, the **tail** is kept, because the
editor and its caret sit at the bottom of that run.

---

## 3. Scroll and sticky-bottom

The scroll API is `scrollBy(delta)`, `scrollTo(row)`, `scrollToBottom()`, plus
the readables `scrollTop`, `maxScrollTop` and `isStickyBottom`. A wheel notch
is three rows. `onScrollChange` fires when the offset or the sticky flag moves.

Sticky-bottom is **re-derived from where the scroll lands, never from the
direction of travel**:

```
next   = clamp(requested, 0, maxScrollTop)
sticky = next >= maxScrollTop
```

That single rule gives the disengage/re-engage behaviour for free. Any scroll
that leaves the last row disengages follow, so a streaming reply stops yanking
the view out from under a reader. Any scroll back to the bottom re-engages it,
so "scroll up to read, scroll down to catch up" needs no separate gesture and
no explicit "resume following" key.

Re-pinning happens **during compose, before windowing**, not after: the frame
that grows the transcript is the frame that shows the new tail. Deferring it
would land new content one frame late, which reads as stutter during streaming.
When sticky is off and the content shrinks below the current offset, the offset
is clamped down rather than being left pointing past the end.

`scrollTo` returns `false` and does nothing in `append` mode. There is no
engine-owned scroll offset there, and inventing one would fight the emulator.

### The gap above the first block is content, not chrome

`ViewportChrome` deliberately sets no `padTop`. The blank row above the first
transcript block is the scroll region's own leading row, prepended during
compose (`#fullscreenScrollLead`), so it is present at rest and scrolls away
with everything else.

As chrome it stayed welded to the top of the window, and content scrolled *behind*
it — a row vanished early on the way up and appeared late on the way down, which
reads as the viewport losing a row. opencode reaches the same result by making
its top spacer the first child of the scroll box rather than padding on it.

Because the row is part of the composed frame, every consumer of frame
coordinates shifts with it: zone collection adds `#fullscreenScrollLead` to the
scroll-region base offset, and selection maps through `#fullscreenScrollFrame`,
which contains the row.

### Blocks, and why the window needs to know where they are

The composed frame is a flat `string[]`; windowing it by index alone cannot tell
a whole block from the remains of a clipped one. That matters because a card
paints its inset rows: an offset that leaves only a card's blank top padding on
screen leaves a coloured band with no visible cause.

So compose also records `#blockStarts`, and `#orphanBlockRows` drops a clipped
block whose visible rows carry no content. Boundaries come from the child:

- a child implementing `BlockRowSpans` reports its own ledger — `TranscriptContainer`
  must, because it inserts separator rows and trims blank edges, so it is not the
  concatenation of its children;
- a plain `Container` exposes `memoizedChildRowCounts()`, used only when the counts
  actually sum to the rows it returned;
- anything else is one opaque block, which is always safe: an opaque block is
  never suppressed.

A block may paint a one-column left rail down every row it owns, padding
included. Column 0 is therefore discounted — but only when the clipped-away part
of the same block carries the same glyph there, which is what separates a rail
from a row whose only content happens to sit in the first column.

### Cost

Per frame the engine renders every root child (`render()` is the invalidation
point and carries side effects, so it is never skipped) and concatenates the
result. The concatenation is **not** cached across frames: the only available key
is each child's rendered array identity, and the transcript returns one
persistent array it mutates in place, so a cache keyed that way cannot see a
change and freezes the viewport.

What is bounded instead is the work that actually scales. Hit-zone collection
takes a row window (`HitZoneSink.setRowWindow`) and both `Container.publishHitZones`
and `TranscriptContainer.publishHitZones` skip blocks outside it, so a 3000-block
transcript publishes a viewport's worth of zones rather than 3000. And blocks
memoize their own rows: a settled collapsed tool card that rebuilt its summary
string per frame defeated every memo below it, because they all key on array
identity.

---

## 4. Hit zones

### Local rows, container walks

A component publishes zones in **local** rows: row 0 is its own first rendered
row. It never learns its screen position. `Container.publishHitZones` walks its
children and adds each child's row offset from the render memo, so offsets
accumulate down the tree and the zone that reaches the engine already carries
the right coordinates.

```ts
sink.zone(target, rowStart, rowCount = 1, colStart = 0, colEnd = Infinity)
sink.withOffset(delta, fn)   // containers only
```

This exists because the previous approach did not compose. Every clickable
component used to keep its own `line -> item index` table and every host
hand-subtracted its own chrome offsets before forwarding a mouse event. That
works for a modal that owns the screen and knows it paints from row 0. It
cannot work for a transcript block nested inside a scrolled viewport inside the
root tree, which has no way to know its own screen row.

Three walks exist because three layout nodes exist:

- `Container` is the general case, taking offsets from `#memoChildLines`. A stale memo
  publishes nothing rather than publishing at wrong rows.
- `Box` is not a `Container`, so it does not inherit the walk, and tool cards
  live inside one. It shifts children past the top border and vertical padding.
  It deliberately does **not** shift columns by `paddingX`: transcript zones are
  full-width row targets, and shifting the start would make a click in the left
  gutter miss the row it visually belongs to.
- `TranscriptContainer` overrides the inherited walk, which for it is not
  merely unused but unsafe. It assembles its own lines and never populates the
  base render memo, so the inherited walk would derive offsets from absent or
  stale arrays. Its segment ledger is the only record of where a block's rows
  landed, and it already accounts for the separator row and the blank edges
  assembly stripped.

A component that is both a `Container` and a zone owner must call
`super.publishHitZones(sink)` if it also wants its children's zones.

### Reverse-order hit testing

Zones are collected in tree order and tested in **reverse**, so a zone published
by a descendant wins over an ancestor's larger zone. That reproduces DOM-style
z-order without an explicit z-index and without any component declaring depth.

### A flat list, not a cell grid

`hitTestZones` is a linear reverse scan over an array. The alternative, which
OpenTUI takes, is a `width * height` array of per-cell owner ids, cleared and
repopulated every frame so that lookup is `O(1)`.

The grid is the wrong trade here. It costs a full-screen write per frame to
accelerate a lookup that happens at most a few hundred times a second, and omp's
transcript publishes roughly one zone per visible block, so the list is almost
always under 100 entries. A linear scan over 100 entries a few hundred times a
second is free; a `width * height` array write at every frame is not. Revisit
only if a surface ever publishes thousands of simultaneous zones.

### Coordinates at collection time

Zones are collected per frame into screen coordinates directly: the scroll
region starts at offset `-scrollTop`, and the pinned run restarts at
`viewportRows - pinnedClipped`. Scroll-region zones scrolled off the top get
negative rows and simply never match. One hit test therefore serves both
regions, and dispatch does no coordinate translation at all.

Selection, by contrast, works in **frame** coordinates
(`scrollTop + screenRow`), so a highlight stays attached to the text it was
drawn over rather than to a screen row, and survives scrolling.

### Overlays and modals

Modal overlays decode SGR themselves and hit-test against their own frame; they
predate zones. The engine therefore claims the pointer stream only when no
overlay is visible. A modal that asked for the whole screen still gets the
blank-base painter even while the app is fullscreen: it wants to cover the
transcript, not composite over it.

---

## 5. Press/release pairing, and why components have no selection guards

The pointer router (`#routePointerInput`) is the whole reason a click and a drag
can share one button:

- **Press** arms two things at once: a candidate click target (the zone under
  the press) and a selection anchor at the press cell. It also clears any
  previous selection, because click-to-dismiss is how every text surface
  cancels one.
- **Motion** extends the selection when the button is down, and updates hover
  when it is not. A selection only becomes *active* once the pointer leaves the
  press cell.
- **Release** decides which gesture happened. If the pointer moved, it was a
  drag: the selection wins, the text is handed to `onCopy`, and **no click
  fires**. Otherwise the click fires, but only when the release zone is the
  same zone as the press, so dragging off a control cancels it the way every
  other UI does.

The consequence is the important part: **a component must not implement its own
"was the user selecting?" guard.** The engine has already decided by the time
`onZoneClick` is called. A component-level guard would be dead code at best and,
if it read a slightly different notion of "selecting", a source of clicks that
silently do nothing. Components implement `onZoneClick`, `onZoneHover` and
`onZoneWheel`, and nothing else.

`onZoneWheel` returning `false` (or being absent) lets the wheel bubble to the
scroll viewport, which is what keeps a wheel over a tool block scrolling the
transcript instead of dead-ending on it.

Any other report (middle button, right button, modifier-only) is swallowed
rather than forwarded. Leaking it to the focused component would type escape
noise into the composer.

### What the selection paints and copies

Selection is confined to the scroll region. A press outside it produces no
anchor at all, so dragging across the composer moves the caret instead of
selecting chrome.

The highlight is SGR reverse video (`CSI 7 m` … `CSI 27 m`), not an explicit
background colour. Reverse composes with whatever colours a row already carries,
so selected text stays legible over every theme, over diff highlighting and over
syntax-highlighted code without the selection layer knowing any of their
colours. Rows shorter than the selection are padded, or a multi-row drag looks
ragged on every short line it crosses.

What reaches the clipboard is stripped of ANSI and right-trimmed per row: the
frame pads every row to the terminal width, so without the trim every copied
line would carry spaces out to the last column. A single-row selection is an
inline fragment; a multi-row one is joined with newlines.

### Hover

Hover moves by zone key, not by object identity, so a component free to rebuild
its zone objects every frame keeps its hover state. `onZoneHover` returns
whether the visual state actually changed, and the engine repaints only then, so
sweeping the pointer across inert rows costs nothing.

Keys must be **stable across frames and unique within one**, and must not be
derived from transcript position: a positional key hands a block its
neighbour's hover state the moment anything above it is removed. Blocks derive
keys from their own instance identity (`subagent-footer:parent`,
`task-agent:<agentId>`, and so on).

---

## 6. The per-row alt-screen diff

`#emitAltFrame` diffs the composed screen against the previous frame row by row
and rewrites only the rows that changed, addressed absolutely (`CSI row;1 H`).

The alt buffer makes this safe in a way the normal screen never was. It has no
scrollback, so absolute addressing is unambiguous, and there is no scrolled
reader to disturb. Those are exactly the two constraints that force the normal
screen into relative cursor moves and a commit ledger.

It also matters far more here than it did for a modal. A modal is mostly static
between keystrokes, so the old code just skipped byte-identical repaints. A
full-screen app streaming an assistant reply changes two or three rows per
frame, continuously, at the render cadence (a 30 fps ceiling with adaptive
backpressure). Rewriting the whole viewport for each of those frames is the
difference between smooth and visibly chugging on a tall terminal.

The caret is tracked alongside the rows: a frame whose rows are all identical
but whose caret moved (arrow keys in the composer) still emits, and one where
neither moved emits nothing at all. A forced repaint (`resetDisplay`,
`requestRender(true)`) bypasses the diff entirely, because the redraw gesture
must repair a corrupted screen even when the cache says nothing changed.

---

## 7. Invariants: MUST / NEVER

1. **NEVER apply an append-mode invariant to a fullscreen frame.** The commit
   ledger (`#committedRows`, `#windowTopRow`, the emitters, the audit) does not
   run on this path. There is no native scrollback to protect, so there is
   nothing to commit, audit, or re-anchor, and `tui-core-renderer.md` §3 is
   vacuous here.
2. **NEVER add a second pinning mechanism.** Bottom chrome is the run after the
   first `isFullscreenPinned()` child, and nothing else. A per-child flag that
   interleaves pinned and scrolling regions has no defined scroll semantics.
3. **NEVER let fullscreen behaviour leak into `append`.** Anything that would
   change what append mode renders or emits is gated on
   `viewportMode === "fullscreen"`. The pin boundary renders zero rows for
   exactly this reason.
4. **Zones are published in LOCAL rows.** A component that computes a screen row
   is wrong: it cannot know its scroll offset, its container's padding, or its
   position in the tree. Publish local, let the walks translate.
5. **Zone keys are stable and non-positional.** Derive from instance identity,
   never from an index in the transcript, or hover and click will follow the
   wrong block after a removal above it.
6. **NEVER guard `onZoneClick` on selection state.** Press/release pairing has
   already excluded drags and cross-zone releases before the handler runs.
7. **A stale render memo publishes nothing.** Every walk bails when its
   geometry does not match its children. Publishing at a guessed row hands one
   component's rows to another, and the failure is silent.
8. **The pinned run never takes the whole screen.** It is clamped so the
   transcript keeps a floor of rows, and it keeps its tail rather than its head
   when clipped, because the caret lives at the bottom.
9. **Sticky-bottom is derived from position, never from direction.** Compute it
   from `next >= maxScrollTop` on every scroll; do not track "the user scrolled
   up" as separate state.
10. **NEVER forward an unhandled pointer report to the focused component.** It
    reaches the composer as escape-sequence text.

---

## 8. App-layer behaviour built on this

### Clickable collapse and expand

Every collapsible transcript block owns a `CollapsibleBlockHeader`: one hit zone
over its header row, a hover wash on that row, and a disclosure marker in its
gutter. Where the header row sits is known only to the block, and whether the
collapsed form hides anything is measurable only by the block, so those two
stay with the block and everything else is shared.

Two details are load-bearing:

- **Overflow is discovered, not declared.** A block becomes clickable only when
  its collapsed form actually omits content, and that fact is found deep inside
  whichever of the roughly thirty tool renderers drew the block, none of which
  can see the enclosing component. Rather than widen every renderer signature,
  the helpers that emit an expand affordance report into an ambient probe the
  block installs around its own render (`measureCollapsedOverflow`).
- **Overflow is latched.** A block that has been expanded no longer hides
  anything and stops reporting overflow, but it must stay clickable so it can be
  collapsed again. Content only grows, so the latch never goes stale.

The expand hint names the gesture that exists: `click to expand` in fullscreen,
the keybinding in append mode, where there is no pointer target.

### Compacted settled output

In the fullscreen viewport a settled tool call keeps one line of output
(`PREVIEW_LIMITS.OUTPUT_SETTLED`). A completed call is history and its header
already carries the outcome, so the collapsed form is a line of evidence rather
than a paragraph, and one click on the header restores the rest. This is
fullscreen-only because it depends on that click existing.

### Subagent drill-down

Clicking an agent row in a task block focuses that agent's session.
`SessionFocusController` keeps the view as a **stack, not a pointer**: drilling
from a subagent into one of its children pushes, and popping returns to the
exact session that was on screen rather than re-deriving an ancestor from the
registry. A revived agent's `parentId` chain says where it sits in the tree, not
how the user got there, which is what makes depth greater than one navigable in
both directions. Jumping straight to a deep agent from the flat Agent Hub roster
seeds the ancestor frames so the pop still walks up one level at a time, and
re-entering a level already on the path truncates back to it rather than pushing
a cycle.

`SubagentFooter` is one row, no border, no panel: the agent label, its position
among its siblings, and three chips mirroring `app.session.parent`,
`app.session.sibling.prev` and `app.session.sibling.next`, each showing the key
actually bound to it. The drill-down is a mode, not a workspace, and permanent
chrome would cost a transcript line on every frame. It renders nothing on the
main session, and its state is pulled per frame rather than pushed, so nothing
has to resync it after a focus change or a sibling spawning mid-turn.

The chips are pointer affordances only. In append mode the footer publishes no
zones and loses nothing but the clicks; the keys still work. A viewport too
narrow for both halves drops the identity text outright rather than truncating,
because a chip painted at the wrong column would take clicks meant for its
neighbour.

The navigation keys decline on the main session, and that declining is what lets
them share `Alt+Up` with message dequeue and `Alt+Left`/`Alt+Right` with word
motion in the editor.

---

## 9. Before you touch the fullscreen path: checklist

- [ ] Does your change alter what `append` mode renders or emits? It must be
      gated on `viewportMode === "fullscreen"`.
- [ ] Are you computing a screen row inside a component? Publish local rows and
      let the container walk translate.
- [ ] New layout node between the root and a zone owner? It needs its own
      `publishHitZones` walk, or every zone below it silently disappears.
- [ ] Is your zone key derived from a position in the transcript? It will follow
      the wrong block after a removal.
- [ ] Adding a "was the user selecting?" check to a click handler? The engine
      already did it.
- [ ] Repainting the whole viewport where a row diff would do? At streaming
      cadence that is the difference between smooth and chugging.
- [ ] Did you exercise it in a real PTY at a small terminal height, with the
      composer expanded, while a reply streams? The pinned-run clamp and the
      sticky-bottom re-pin only misbehave under those conditions.
