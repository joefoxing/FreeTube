# Karaoke Night P4 — drag reordering

**Spec:** `docs/superpowers/specs/2026-11-10-karaoke-night-design.md` §phases (P4), §5 rules, §10 commands.
**Repos:** `~/developer/freetube` (renderer + TV UI) and `~/developer/freetube-remote` (phone PWA).
**Proves:** dragging a row across the priority boundary changes BOTH what the TV displays and what
plays next; and a phone can move its own song but not yours.

## What already exists (do not rebuild it)

- `moveItem(queue, id, toIndex)` in `src/renderer/helpers/karaoke-queue.js` — reorders and derives the
  tier from WHERE THE ROW LANDS (`priority: toIndex < priorityRunLength(rest)`), with `E_NOT_FOUND`
  and `E_BAD_INDEX` refusals. Tested in `tests/karaoke-queue.test.cjs` (including "reads the priority
  tier from where the row lands, not from its old slot").
- Store action `karaokeMove({id, toIndex}) -> code|null`, `src/renderer/store/modules/karaoke.js`.
- The wire: `queueMove` is in both command sets; the bridge relays `{itemId, toIndex}` and stamps
  `from`; the phone's `itemCommand('queueMove', row)` builds it.
- `CODES.BAD_INDEX` and the `E_NOT_HOST` refusal style in `karaoke-actions.js`.

So P4 is the AUTHORIZATION rule, the index arithmetic in two places, and two pieces of UI. No new
reducer logic and no bridge change.

## Global constraints

- Suite commands, by repo: renderer `node --test "tests/*.test.cjs"` (170 today); bridge
  `uv run pytest tests -q` (45); phone `node --test "tests-web/*.test.mjs"` (19). Counts must rise,
  never fall. Write the test first and watch it fail for the right reason.
- Commits run lefthook (eslint + stylelint) — commit WITHOUT `--no-verify`. The two refusals it
  hands back on new UI: a raw glyph or word in a template belongs in `static/locales/en-US.yaml`
  (`vue-i18n/no-raw-text`), and CSS functions are lowercase (`currentcolor`).
- The TV and the phone have separate i18n stories: the TV uses `t('Karaoke.*')` keys from the YAML;
  the phone's strings are plain English literals in `web/app.js`/`web/karaoke.js` (see `voteFailure`).
- The phone app is served by the bridge and must be restarted after a change:
  `systemctl --user restart freetube-remote.service`.

---

### Task 1: The rule — a phone moves its own row, or any row as host

**Files:** `src/renderer/remote/karaoke-actions.js`, `tests/remote-karaoke.test.cjs`.

The spec's command table is explicit: `queueMove | { itemId, toIndex } | own songs only, unless the
sender is the host`. Refusal code `E_NOT_YOURS`, sibling to `E_NOT_HOST` (a literal, not a `CODES`
entry, exactly as `E_NOT_HOST` is today).

```js
    // The spec's rule for a move: your own song, or anything if you hold the host row. The sender is
    // resolved from the bridge-stamped `from` (never from the payload), the row from `itemId`, so a
    // forged payload can neither act for another phone nor claim ownership of another's row.
    queueMove: payload => {
      const singer = store.getters?.getSingerByPhone?.(payload?.from) ?? null
      const row = (store.getters?.getKaraokeUpcoming?.(undefined) ?? []).find(item => item.id === payload?.itemId)

      if (!singer?.host && (!singer || row?.singerId !== singer.id)) return 'E_NOT_YOURS'

      return store.dispatch('karaokeMove', { id: payload?.itemId, toIndex: payload?.toIndex })
    },
```

Tests (append to `tests/remote-karaoke.test.cjs`, using the file's existing harness — a fake store
with `getters.getSingerByPhone`, and `calls` recording dispatches):

1. `an own-row move from a non-host singer reaches karaokeMove` — singer Grace on `ph_g`, row
   `singerId: 's-grace'` → code `null`, one dispatch `{type:'karaokeMove', payload:{id, toIndex}}`.
2. `a move of someone else's row by a non-host is refused and dispatches nothing` — same singer, row
   `singerId: 's-ada'` → `E_NOT_YOURS`, `calls.length === 0`.
3. `a phone that claimed nothing cannot move any row` → `E_NOT_YOURS`, nothing dispatched.
4. `the host may move any row` — the host singer, someone else's row → `null`, one dispatch.

---

### Task 2: The index arithmetic, as two pure helpers

Two different lists produce indices, and getting either wrong is a silent mis-order:

- **The TV** drags within `upcoming`, which IS the store order (`shown` = `upcoming` unfiltered when
  not compact) — so a drop position is a store index once the removed row is accounted for.
- **The phone** displays `orderOwn(upcoming, mySingerId)`, which puts YOUR rows first. Displayed
  index ≠ store index the moment the singer owns two songs. A move index must therefore be computed
  from the frame's `upcoming` order, never from the displayed position.

New module `src/renderer/helpers/karaoke-move.js` (renderer):

```js
/**
 * The `toIndex` a drag means, from the source index and the position the row was dropped AT, in the
 * list as it was displayed (the dragged row still in it). Dropping below its own slot lands one place
 * higher once the row is lifted out; dropping above it lands where it was dropped.
 */
export function dropToIndex(from, droppedAt) {
  if (!Number.isInteger(from) || !Number.isInteger(droppedAt)) return null
  if (droppedAt < 0 || droppedAt > from) return droppedAt - (droppedAt > from ? 1 : 0)
  return droppedAt
}
```

```js
/**
 * The `toIndex` a phone's up/down button means, from the row's index IN THE FRAME's `upcoming`
 * (the store's order, not the order the phone displays) and the direction. `null` at the ends, so
 * the button is disabled rather than sending an index the reducer must refuse.
 */
export function stepToIndex(rows, itemId, direction) {
  const rows_ = Array.isArray(rows) ? rows : []
  const from = rows_.findIndex(row => row?.id === itemId)
  if (from === -1) return null
  const to = direction === 'up' ? from - 1 : from + 1
  return to < 0 || to >= rows_.length ? null : to
}
```

**Why `dropToIndex` is not `droppedAt`:** dropping row 0 onto position 2 must END at index 1
(`[A,B,C,D]` → `[B,A,C,D]`), and the reducer treats `toIndex` as the target in the list with the row
already removed. Dropping row 3 onto position 1 ends at 1.

Tests (new file `tests/karaoke-move.test.cjs`, the `load()`-style dynamic import the sibling test
files use):

1. `a drag downward lands one place higher` — `dropToIndex(0, 2) === 1`, `dropToIndex(1, 3) === 2`.
2. `a drag upward lands exactly where it was dropped` — `dropToIndex(3, 1) === 1`, `dropToIndex(2, 0) === 0`.
3. `a drop onto its own slot is a no-op index` — `dropToIndex(2, 2) === 2` (the reducer then keeps the
   order; a self-drop must not flicker the list).
4. `nonsense drops are refused` — `dropToIndex(undefined, 1) === null`, `dropToIndex(1, undefined) === null`.
5. `a phone step moves one place, and stops at the ends` — with three rows, `stepToIndex(rows, 'k2', 'up') === 0`,
   `stepToIndex(rows, 'k2', 'down') === 2`, `stepToIndex(rows, 'k1', 'up') === null`,
   `stepToIndex(rows, 'k3', 'down') === null`, `stepToIndex(rows, 'nope', 'up') === null`.
6. `the phone index comes from the frame order, not the displayed order` — the displayed list is
   `orderOwn(rows, 's1')` (own first) while the frame order is the seeded order; assert
   `stepToIndex(rows, <own row>, 'down')` equals the FRAME index + 1, and note in the test name why,
   because this is the bug the helper exists to prevent.

---

### Task 3: The TV — drag a row, and drop it across the boundary

**Files:** `src/renderer/components/FtKaraokeQueue/FtKaraokeQueue.vue`, `FtKaraokeQueue.css`,
`static/locales/en-US.yaml`.

- The `<li>` gains `draggable="true"` and the handlers; keep them inert in `compact` mode (the watch
  page's 3-row bar is not a reordering surface).
- `@dragstart="dragFrom = index; $event.dataTransfer.effectAllowed = 'move'"`,
              `@dragover.prevent="dragOver = index"`, `@drop.prevent="dropOn(index)"`,
              `@dragend="clearDrag()"`. `dropOn(target)` dispatches `karaokeMove(dropMove(shown, dragFrom, target))`
  and clears state -- the DRAGGED row moves, never the row under the cursor. (This plan first said
  `shown[target].id`; the live proof below caught it moving the wrong song, and the decision was moved
  into the tested helper `dropMove`.)

**Live proof, 2026-11-11:** drag on the published build moved `Bravo` when `Charlie` was dragged
(`moveItem`'s `priority = toIndex < priorityRunLength(rest)` explains the resulting
`[Charlie*, Bravo*, Alpha*]` exactly), which is why `dropMove` now exists with those tests.
- Classes for the dragging row and the row under it (`.isDragging`, `.isDropTarget`) in the CSS, so
  the affordance is visible — a drag that shows nothing reads as a broken list.
- Locale keys: `Karaoke.Move Up`, `Karaoke.Move Down` (used by the aria-labels below); NO raw glyph in
  the template.
- Accessibility, since drag alone is not usable by keyboard: on each row, two small buttons with
  `aria-label` from those keys, dispatching
  `karaokeMove({id: item.id, toIndex: stepToIndex(upcoming, item.id, 'up'|'down')})` and `disabled`
  when the helper returns `null` (first row up, last row down). This is also the honest fallback if
  the drag-and-drop API misbehaves in the Electron build.

Verification is live, not unit: the SFC's `<script setup>` locals are unreachable from `node --test`,
which is why the maths lives in the helper module above.

---

### Task 4: The phone — move up/down, only where the rule allows

**Files:** `web/karaoke.js`, `web/app.js`, `web/app.css`, `tests-web/karaoke.test.mjs`.

- `web/karaoke.js` gains `canMove(row, mySingerId, iAmHost)` → `Boolean(iAmHost || (mySingerId && row?.mine))`
  — `orderOwn` already marks `mine` per row, so the phone needs no id comparison of its own. Also add
  `E_NOT_YOURS: 'You can only move your own songs.'` to the refusal map in `voteFailure`.
- `web/app.js`'s `queueRow` gains two buttons before the vote button, `▲`/`▼` in `.move` spans whose
  `aria-label`s are words, wired to `sendMove(row, 'up'|'down')`. Enabled only when `canMove(...)`;
  otherwise `disabled` with `title` "Only your own songs, unless you are the host" (the phone's
  conventions are literal English strings, not locale keys).
- `sendMove` mirrors `sendVote`: clear `#queue-error`, bail to the same sentence when the command
  cannot be built, refuse when the socket is not open, and — because the bridge's ack correlates by
  its own id — not send while `claimPending`/`openPending`/another command is in flight.
- The index sent is `stepToIndex(state.queue?.upcoming ?? [], row.id, direction)`; if it is `null`, do
  not send (the button is disabled anyway) — never send `toIndex: null`, which the reducer refuses.

Phone tests (append to `tests-web/karaoke.test.mjs`):

1. `only your own row — or the host — can be moved` — `canMove({mine:true}, 's1', false) === true`,
   `canMove({mine:false}, 's1', false) === false`, `canMove({mine:false}, 's1', true) === true`,
   `canMove({mine:true}, null, false) === false` (no claimed name, no move).
2. `a refused move reads as a sentence` — `voteFailure('E_NOT_YOURS')` is that sentence, and an
   unknown code still echoes itself.

Live verification (two devices, the recipe in the `freetube-development` skill's
`references/remote-bridge-verification.md`): pair a phone, claim a name, add a song, move it up and
down, then confirm the TV's row order changed and that a NON-owner phone's move is refused with the
sentence on screen.

---

### Task 5: Evidence, spec status, commit

- Re-run all three suites and read the counts off the runs (renderer will rise by the `karaoke-move`
  file, phone by the two new tests; the bridge count is unchanged by P4 — say so rather than
  implying it moved).
- Live, on the published build (this is what `metube.joefoxing.it.com` now serves):
  1. seed a queue with **no** priority rows, drag the last row to the top → the row must show the
     Priority badge (the boundary crossed) and become `pickNext`'s answer;
  2. drag a priority row back below the run → the badge must disappear and the next pick must change
     back;
  3. drag within the normal tier → order changes, badges do not.
- Update the spec's **Status** line with the new counts and commit in BOTH repos.

## Rulings this plan makes

1. **`queueMove` is gated, `queueRemove`/`queuePromote` are NOT (this phase).** The spec's command
   table gates only `queueMove` and `queueClear`. But §"Out of scope" calls remove/promote "the
   host's remove/promote powers", and today any paired phone may remove ANY row. Those two readings
   disagree; this phase implements the table exactly and LEAVES remove/promote as they are, because
   changing them is a behavior change to three shipped phases, not a P4 task. If the user wants the
   stricter reading, it is its own change with its own tests (the existing suite never asserts that a
   non-host can remove another's row, so nothing there encodes the loose reading either way).
2. **A phone's move buttons stay VISIBLE but disabled on rows it may not move.** Hiding them would
   make "why can't I move this?" a mystery; a disabled control with a title states the rule at the
   point of confusion, matching how the vote button behaves before a name is claimed.
3. **The TV has no permission check.** Whoever holds the TV is the console's operator — the same
   assumption the existing local Play now/Remove/Clear buttons already make.

## Evidence recorded 2026-11-11 (P4, as executed)

Commits (renderer): `6e911c634` plan, `3c20e9d26` the gate, `074f02131` the helpers, `764e9ff7e` the
move-gate fixtures, `da2ad465e` the TV, `c7094d2a8` the drop fix. Commits (bridge/phone): `c63d590`.

**Task 1** — the gate landed with four tests at the enforcement point (own row moves; another's row is
`E_NOT_YOURS` with nothing dispatched; an unclaimed phone moves nothing; the host moves anything).
Fixture lesson, recorded because it nearly shipped a gate that proved nothing: the FIRST claimant holds
the host row, so a one-singer fixture made the sender a host and the "refused" case passed for the
wrong reason. Every case now asserts the sender is not the host.

**Task 2** — `dropToIndex`, `stepToIndex`, `dropMove` in `src/renderer/helpers/karaoke-move.js`
(9 tests), mirrored by `moveTarget` in `web/karaoke.js` (the two repos share no package; the rule is
written and tested twice on purpose).

**The live proof earned its keep.** On the published build, dragging Charlie from the top onto
position 2 produced `[Charlie*, Bravo*, Alpha*]` — Bravo had moved. The handler named
`shown[target].id`, the row UNDER the cursor, and moving that row reorders the list just as
convincingly as moving the dragged one: the arithmetic is per-row, so no screenshot or assertion about
"the order changed" could have caught it — only dragging a specific row and reading WHICH row moved.
The decision moved into `dropMove` (with the test "a drop moves the row that was DRAGGED, not the row
it was dropped on"), and `dropOn` is now three lines that cannot get it wrong on its own. The plan's
own snippet carried the same bug and was corrected above.

**Delivered, on the published build** (`c7094d2a8`, metube.joefoxing.it.com): seeded
`[Alpha*, Bravo, Charlie]`, next `Alpha` → two clicks of Charlie's own Move up button →
`[Charlie*, Alpha*, Bravo]`, next `Charlie` (crossed the boundary upward: gained the badge, became the
next pick) → drag Charlie from the top onto position 2 → `[Alpha*, Charlie, Bravo]`, next `Alpha`
(the dragged row travelled, and lost priority because it landed outside the run). The affordance
classes were observed mid-drag (`isDragging` on the source row, `isDropTarget` on the target), and the
persisted queue read back `[Alpha*, Charlie, Bravo]`.

**Not live-exercised: the phone's buttons.** `getRemoteControlEnabled` is FALSE in the TV's settings on
that build (the bridge URL is correctly `wss://nextcloud.taild1347f.ts.net:10000/remote/ws`, the toggle
is off), so there is no pairing code and no way to reach a phone flow without changing the user's
setting. What IS verified for the phone half: `canMove`/`moveTarget`/the refusal sentences in the phone
suite (23 tests), the four renderer tests that enforce the rule server-side, and the deployed bundle
carrying the code. The wiring between a phone button and those helpers has no unit test (app.js is not
reachable from `node --test`), so it is the one link still resting on inspection: to close it, switch
Remote Control on in Settings → Player (which reveals "Pair a phone"), pair, claim a name, and add a
song from the phone so one row is owned by the claim.

**Two deployment defects found while proving it, both fixed:**

1. `web.js` is not content-hashed but was served `public, max-age=600`, so a browser could run a
   previous release's bundle against a new `index.html` for ten minutes — measured: a fix that had
   been published minutes earlier "did not work" until the cache expired. Caddy now sends `no-store`
   for `/` and `/index.html`, `public, max-age=31536000, immutable` for content-hashed files, and
   `no-cache` (revalidate; the ETag makes it a 304) for everything else, `web.js` included.
2. Caddy's `header` precedence is not "last match wins" as this session first recorded: a PLAIN
   `header` (no matcher) beats a matcher-scoped one for the same field whatever the Caddyfile order
   (measured both ways). The metube rules are therefore MUTUALLY EXCLUSIVE — one rule matches any
   given path — because that is the only construction that cannot be overridden by accident.
