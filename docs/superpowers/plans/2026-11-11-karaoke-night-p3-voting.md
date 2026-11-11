# Karaoke Night P3 — voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the party vote a song up the queue — one togglable upvote per singer per song, a voted song
that actually moves (within its lane), counts on the TV and the phone, and a top-voted badge on the TV.

**Architecture:** Votes live on the queue row (`item.votes = [singerId, …]`), because they are party
state that orders the pending list, not a record: they ride the existing `freetube-karaoke` localStorage
key and the existing `{t:'queue'}` frame, and the roster store gains nothing. The ordering rule is one
more pure function in `karaoke-queue.js`; the phone sends `{cmd:'vote', itemId}` and the renderer resolves
the voter from the singer that phone claimed (P2), so re-pairing cannot buy a second vote. The only
Python is a per-phone command limit in the bridge's hub — the spec names votes as the spam surface.

**Tech Stack:** Vue 3 + Vuex (renderer), `node:test` suites, the Flask/FastAPI bridge
(`~/developer/freetube-remote`) with its plain-JS phone PWA.

**Spec:** `docs/superpowers/specs/2026-11-10-karaoke-night-design.md` — §5 (voting) is the binding
authority, with §3 (the `pick()` ordering rule and the priority rule), §10 (the `vote` command and the
frame's `votes` map), §12 (surfaces), Stages → P3. If this plan and the spec disagree, the spec wins and
the disagreement is a ruling for the controller.

## Global Constraints

- **P1 and P2 are merged.** Renderer `freetube-remote` @ `bac73644e`, bridge `master` @ `ff68c80`.
  Branch `karaoke-night-p3` off each. Do not work in a worktree: `freetube-web.service` serves these exact
  paths on `:9080` and `freetube-remote.service` on `127.0.0.1:9098`, and the evidence steps verify
  against the running services.
- **Baselines measured before this plan was written** (`node --test "tests/*.test.cjs"` → **151 pass /
  0 fail**; `uv run pytest tests -q` → **43 passed**; `node --test "tests-web/*.test.mjs"` → **16 pass /
  0 fail**). Re-measure — the number in this plan is a baseline, not a gate.
- **No new dependencies**, no new datastore, no schema version bump: a queue written by the old code
  loads (rows simply have no `votes`) and every reader defaults to an empty list.
- **The wire rules from P1/P2 hold.** The bridge owns `t`/`cmd`/`from`/`id`; `from` is the phone's opaque
  room id and the only identity a command may carry into the store; a row target travels as `itemId`; the
  queue rides its own `{t:'queue'}` frame and **never** the 1 s state frame (a test asserts the state
  frame's exact key set).
- **The voter is a singer, never a phone.** A phone that has not claimed a roster row cannot vote
  (`E_NO_SINGER`); a phone cannot name a voter in its payload.
- **Never `git commit --no-verify`.** When a hook rejects a construct, change the construct (the P2
  constraints list the two offenders: `replaceAll` over a global-regex `replace`, and nested
  `@param context.state` / `@param context.commit` instead of one `@param context`).
- **Locale keys** go in `static/locales/en-US.yaml` under the existing `Karaoke:` block; a new key needs
  `systemctl --user restart freetube-web` before it renders.
- **Verification honesty.** The controller owns the browser, the live bridge and the packaged Electron
  app. An implementer never claims a DOM, pairing or playback check it did not run.

---

### Task 1: The vote rules, in the pure reducer

Voting's whole behaviour is a function of the queue array, so it lives beside `addItem` and `promoteItem`
where the store, the TV and the tests all reach it. Nothing here touches Vuex, localStorage or the DOM.

**Files:**
- Modify: `src/renderer/helpers/karaoke-queue.js`
- Test: `tests/karaoke-votes.test.cjs` (new)

**Interfaces:**
- Consumes: `PRIORITY_CAP`, `CODES`, `priorityRunLength` (module-private), the item shape P1 mints
  (`{id, videoId, title, channel, durationSeconds, thumbnail, requester, singerId, priority, addedAt}`).
- Produces: `CODES.NOT_QUEUED = 'E_NOT_QUEUED'`, `CODES.NO_SINGER = 'E_NO_SINGER'`;
  `itemVotes(item) -> string[]`; `voteCount(item) -> number`; `topVoted(queue) -> item|null`;
  `toggleVote(queue, id, singerId) -> {queue, code}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/karaoke-votes.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/helpers/karaoke-queue.js')

/** A queue with three normal rows, one of them priority. */
async function fixture() {
  const q = await load()
  let queue = q.createQueue()
  queue = q.addItem(queue, { videoId: 'aaaaaaaaaaa', title: 'One' }, 's1').queue
  queue = q.addItem(queue, { videoId: 'bbbbbbbbbbb', title: 'Two' }, 's2').queue
  queue = q.addItem(queue, { videoId: 'ccccccccccc', title: 'Three' }, 's1').queue
  return { q, queue }
}

const titles = queue => queue.items.map(item => item.title)

test('a vote records the singer on the row and a second vote by the same singer is the same vote', async () => {
  const { q, queue } = await fixture()
  const id = queue.items[0].id

  const once = q.toggleVote(queue, id, 's1')
  assert.equal(once.code, null)
  assert.deepEqual(once.queue.items[0].votes, ['s1'])
  assert.equal(q.voteCount(once.queue.items[0]), 1)

  // The same singer again toggles it OFF — one vote per singer per song.
  const twice = q.toggleVote(once.queue, id, 's1')
  assert.equal(twice.code, null)
  assert.deepEqual(q.itemVotes(twice.queue.items.find(item => item.id === id)), [])
})

test('two singers voting the same song is two votes', async () => {
  const { q, queue } = await fixture()
  const id = queue.items[0].id

  const one = q.toggleVote(queue, id, 's1').queue
  const two = q.toggleVote(one, id, 's2').queue

  assert.equal(q.voteCount(two.items.find(item => item.id === id)), 2)
})

test('a vote moves the row after the last row with more votes, and never past a priority row', async () => {
  const { q, queue } = await fixture()
  // Make the LAST row priority, then vote for the middle one: the vote must land after the
  // priority run (the priority row keeps its place at the top) and after nothing else.
  const promoted = q.promoteItem(queue, queue.items[2].id).queue
  assert.deepEqual(titles(promoted), ['Three', 'One', 'Two'])

  const voted = q.toggleVote(promoted, promoted.items[2].id, 's1')
  assert.equal(voted.code, null)
  assert.deepEqual(titles(voted.queue), ['Three', 'Two', 'One'])
})

test('a second vote on a different row does not outrank the leader, and lands under it', async () => {
  const { q, queue } = await fixture()
  const [first, second] = queue.items

  const leader = q.toggleVote(queue, first.id, 's1').queue
  const leaderTwice = q.toggleVote(leader, first.id, 's2').queue
  const other = q.toggleVote(leaderTwice, second.id, 's3')

  assert.deepEqual(titles(other.queue), ['One', 'Two', 'Three'])
  assert.equal(q.voteCount(other.queue.items[0]), 2)
  assert.equal(q.voteCount(other.queue.items[1]), 1)
})

test('under round_robin a vote stays inside its own singer lane', async () => {
  const { q, queue } = await fixture()
  const rotated = q.setRotation(queue, 'round_robin').queue
  // Order: One(s1), Two(s2), Three(s1). s1 votes for their LAST row: it may pass s1's other
  // row, never s2's — a vote cannot outrank another singer's turn.
  const voted = q.toggleVote(rotated, rotated.items[2].id, 's1')

  assert.equal(voted.code, null)
  assert.deepEqual(titles(voted.queue), ['Three', 'One', 'Two'])
})

test('a vote on a priority row counts but does not move it', async () => {
  const { q, queue } = await fixture()
  const promoted = q.promoteItem(queue, queue.items[2].id).queue
  const voted = q.toggleVote(promoted, promoted.items[0].id, 's2')

  assert.deepEqual(titles(voted.queue), titles(promoted))
  assert.equal(q.voteCount(voted.queue.items[0]), 1)
})

test('an unvote leaves the row where the vote left it', async () => {
  const { q, queue } = await fixture()
  const voted = q.toggleVote(queue, queue.items[2].id, 's1').queue
  assert.deepEqual(titles(voted), ['Three', 'One', 'Two'])

  const unvoted = q.toggleVote(voted, voted.items[0].id, 's1')

  assert.equal(unvoted.code, null)
  assert.deepEqual(titles(unvoted.queue), ['Three', 'One', 'Two'])
  assert.equal(q.voteCount(unvoted.queue.items[0]), 0)
})

test('a song that has already played is refused with E_NOT_QUEUED', async () => {
  const { q, queue } = await fixture()
  const started = q.startItem(queue, queue.items[0].id).queue
  const played = q.completeCurrent(started).queue

  assert.equal(played.played.length, 1)
  assert.equal(q.toggleVote(played, played.played[0].id, 's1').code, 'E_NOT_QUEUED')
})

test('an unknown row id is refused with E_NOT_QUEUED and nothing is written', async () => {
  const { q, queue } = await fixture()
  const result = q.toggleVote(queue, 'k_nope', 's1')

  assert.equal(result.code, 'E_NOT_QUEUED')
  assert.equal(result.queue, queue)
})

test('a vote with no singer is refused with E_NO_SINGER', async () => {
  const { q, queue } = await fixture()
  const result = q.toggleVote(queue, queue.items[0].id, null)

  assert.equal(result.code, 'E_NO_SINGER')
  assert.equal(result.queue, queue)
})

test('topVoted is the normal tier leader, ties going to the row that comes first', async () => {
  const { q, queue } = await fixture()
  let voted = q.toggleVote(queue, queue.items[0].id, 's1').queue
  voted = q.toggleVote(voted, voted.items[1].id, 's2').queue

  assert.equal(q.topVoted(voted).id, voted.items[0].id)
  assert.equal(q.topVoted(queue), null)
})

test('a priority row is never the top-voted row: it already carries the priority badge', async () => {
  const { q, queue } = await fixture()
  const promoted = q.promoteItem(queue, queue.items[2].id).queue
  const voted = q.toggleVote(promoted, promoted.items[0].id, 's1').queue

  assert.equal(q.voteCount(voted.items[0]), 1)
  assert.equal(q.topVoted(voted), null)
})

test('votes survive a serialize round trip and a payload without votes still loads', async () => {
  const { q, queue } = await fixture()
  const voted = q.toggleVote(queue, queue.items[0].id, 's1').queue

  const restored = q.deserializeQueue(q.serializeQueue(voted))
  assert.deepEqual(restored.items[0].votes, ['s1'])

  // A queue written before voting existed: rows with no `votes` field at all.
  const old = JSON.parse(q.serializeQueue(queue))
  delete old.items[0].votes
  const loaded = q.deserializeQueue(JSON.stringify(old))

  assert.equal(q.voteCount(loaded.items[0]), 0)
  assert.equal(q.toggleVote(loaded, loaded.items[0].id, 's1').code, null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "tests/karaoke-votes.test.cjs"` (from `~/developer/freetube`)
Expected: FAIL — `q.toggleVote is not a function` (and `q.voteCount`, `q.itemVotes`, `q.topVoted`).

- [ ] **Step 3: Write the reducer**

In `src/renderer/helpers/karaoke-queue.js`, extend `CODES`:

```js
export const CODES = {
  BAD_VIDEO_ID: 'E_BAD_VIDEO_ID',
  DUPLICATE: 'E_DUPLICATE',
  PRIORITY_CAP: 'E_PRIORITY_CAP',
  NOT_FOUND: 'E_NOT_FOUND',
  BAD_INDEX: 'E_BAD_INDEX',
  BAD_ROTATION: 'E_BAD_ROTATION',
  // A vote targets a *queued* row: a song that has already played (or an id from a stale
  // phone frame) is refused rather than resurrected, and an unclaimed phone has no singer
  // to vote as — re-pairing would change its `from`, so voting as the phone would buy a
  // second vote for the same human.
  NOT_QUEUED: 'E_NOT_QUEUED',
  NO_SINGER: 'E_NO_SINGER'
}
```

Then add, after `moveItem`:

```js
/**
 * @param {object} item
 * @returns {string[]} the singer ids that voted for this row, `[]` for a row from an older queue
 */
export function itemVotes(item) {
  return Array.isArray(item?.votes) ? item.votes : []
}

/**
 * @param {object} item
 * @returns {number}
 */
export function voteCount(item) {
  return itemVotes(item).length
}

/**
 * The row the TV's "top voted" badge belongs to: the normal tier's highest vote count, ties
 * going to the row that comes first. Priority rows are excluded — they carry the priority
 * badge, and a vote never moves them (§5).
 *
 * @param {object} queue
 * @returns {object|null}
 */
export function topVoted(queue) {
  let best = null

  for (const item of queue.items) {
    if (item.priority || voteCount(item) === 0) continue
    if (!best || voteCount(item) > voteCount(best)) best = item
  }

  return best
}

/**
 * The index a just-voted row moves to: immediately after the last row it outranks inside its
 * own lane, or at the head of that lane when it outranks nothing. Under `fifo` the lane is
 * the whole normal tier; under `round_robin` it is that singer's own normal rows, so a vote
 * can never jump another singer's turn (§5). `at` is the row's index before it was lifted
 * out, which is where it goes back when it has nowhere to move.
 *
 * @param {object[]} items the queue WITHOUT the voted row
 * @param {object} item the voted row
 * @param {string} rotation
 * @param {number} at
 * @returns {number}
 */
function votePosition(items, item, rotation, at) {
  if (item.priority) {
    return Math.min(at, items.length)
  }

  const lane = entry =>
    !entry.priority && (rotation !== 'round_robin' || entry.singerId === item.singerId)

  let after = -1

  for (let index = 0; index < items.length; index += 1) {
    if (lane(items[index]) && voteCount(items[index]) > voteCount(item)) {
      after = index
    }
  }

  if (after >= 0) return after + 1

  const first = items.findIndex(lane)

  if (first >= 0) return first

  // The lane holds no other row at all. Under fifo that is an empty normal tier, whose head
  // is just past the priority run; under round_robin the row has no rival to move past, so
  // it stays exactly where it was.
  return rotation === 'round_robin' ? Math.min(at, items.length) : priorityRunLength(items)
}

/**
 * Toggle one singer's upvote on a queued row.
 *
 * Adding a vote is what moves the row ("a vote moves a song"); removing one leaves the row
 * where the last vote put it, so an unvote cannot teleport a row the party just watched
 * settle. Both directions refuse a row that is not queued, and both refuse a vote with no
 * singer behind it.
 *
 * @param {object} queue
 * @param {string} id
 * @param {string} singerId
 * @returns {{queue: object, code: string|null}}
 */
export function toggleVote(queue, id, singerId) {
  if (!singerId) {
    return { queue, code: CODES.NO_SINGER }
  }

  const at = queue.items.findIndex(entry => entry.id === id)

  if (at === -1) {
    return { queue, code: CODES.NOT_QUEUED }
  }

  const item = queue.items[at]
  const voters = itemVotes(item)
  const adding = !voters.includes(singerId)
  const updated = {
    ...item,
    votes: adding ? [...voters, singerId] : voters.filter(voter => voter !== singerId)
  }

  const rest = queue.items.filter(entry => entry.id !== id)
  const to = adding ? votePosition(rest, updated, queue.rotation, at) : Math.min(at, rest.length)
  rest.splice(to, 0, updated)

  return { queue: { ...queue, items: rest }, code: null }
}
```

In `deserializeQueue`, harden the rows' `votes` (the key is user-writable localStorage and it
orders the list):

```js
      items: Array.isArray(raw.items) ? normalizeVotes(raw.items) : base.items,
      played: Array.isArray(raw.played) ? normalizeVotes(raw.played) : base.played,
```

with, above `serializeQueue`:

```js
/**
 * Rows are kept exactly as stored, except for `votes`: a non-array (or a non-string entry)
 * would make `itemVotes` throw on a payload any page script can write.
 *
 * @param {object[]} items
 * @returns {object[]}
 */
function normalizeVotes(items) {
  return items.map(item =>
    Array.isArray(item?.votes)
      ? { ...item, votes: item.votes.filter(voter => typeof voter === 'string') }
      : item
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "tests/karaoke-votes.test.cjs"`
Expected: PASS, 12 tests, 0 fail.

- [ ] **Step 5: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"`
Expected: **163 pass / 0 fail** (151 + the 12 new). Nothing may regress.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/helpers/karaoke-queue.js tests/karaoke-votes.test.cjs
git commit -m "feat(karaoke): the vote rules, as pure reducer state"
```

---

### Task 2: The vote reaches the store, and survives a reload

**Files:**
- Modify: `src/renderer/store/modules/karaoke.js`

**Interfaces:**
- Consumes: `toggleVote`, `voteCount`, `topVoted` from Task 1, and the module's existing `snapshot(state)`
  / `persist(queue)` helpers.
- Produces: action `karaokeVote({id, singerId}) -> Promise<string|null>`; getters
  `getKaraokeVoteCount(id) -> number`, `getKaraokeTopVotedId -> string|null`.

*(Ruling: no `getKaraokeVotes` map getter. The only consumer of an `itemId -> voters` map is the wire
frame, which the agent builds from the raw state in Task 3 — a second builder here would be two
implementations of one shape, and the TV reads counts through `getKaraokeVoteCount` instead.)*

- [ ] **Step 1: Write the failing tests**

Add to `tests/karaoke-store.test.cjs`, in that file's own harness (`context(module, storage)` returns
`{state, committed, commit}`, and a getter is called as `module.default.getters.getX(ctx.state)`):

```js
test('a vote lands on the queue row, moves it and persists', async () => {
  const module = await load()
  const storage = fakeStorage()
  const ctx = await context(module, storage)
  const actions = module.default.actions
  const getters = module.default.getters

  await actions.karaokeAdd(ctx, { videoId: 'aaaaaaaaaaa', title: 'One' })
  await actions.karaokeAdd(ctx, { videoId: 'bbbbbbbbbbb', title: 'Two' })
  const target = ctx.state.items[1].id

  const code = await actions.karaokeVote(ctx, { id: target, singerId: 's1' })

  assert.equal(code, null)
  assert.equal(getters.getKaraokeVoteCount(ctx.state)(target), 1)
  assert.equal(getters.getKaraokeTopVotedId(ctx.state), target)
  // The row moved to the head of the normal tier, and the move is persisted.
  assert.deepEqual(ctx.state.items.map(item => item.title), ['Two', 'One'])
  assert.deepEqual(JSON.parse(storage.dump()['freetube-karaoke']).items[0].votes, ['s1'])
})

test('a refused vote changes nothing', async () => {
  const module = await load()
  const ctx = await context(module, fakeStorage())
  const actions = module.default.actions

  await actions.karaokeAdd(ctx, { videoId: 'aaaaaaaaaaa', title: 'One' })
  const before = JSON.stringify(ctx.state.items)
  const commits = ctx.committed.length

  const code = await actions.karaokeVote(ctx, { id: 'k_gone', singerId: 's1' })

  assert.equal(code, 'E_NOT_QUEUED')
  assert.equal(JSON.stringify(ctx.state.items), before)
  assert.equal(ctx.committed.length, commits, 'a refusal commits nothing')
  assert.equal(module.default.getters.getKaraokeTopVotedId(ctx.state), null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "tests/karaoke-store.test.cjs"`
Expected: FAIL — `[vuex] unknown action type: karaokeVote` / `getKaraokeVoteCount is not a function`.

- [ ] **Step 3: Add the action and the getters**

In `src/renderer/store/modules/karaoke.js`, extend the import list with `itemVotes`-free names only
(`toggleVote`, `topVoted`, `voteCount`) and add the getters after `getKaraokePriorityCount`:

```js
    getKaraokeVoteCount: state => id => voteCount(state.items.find(item => item.id === id)),
    getKaraokeTopVotedId: state => topVoted(state)?.id ?? null,
    // The frame's `itemId -> voter ids` map, built in one place so the TV's badge and the
    // phone's map can never disagree about what a count means.
    getKaraokeVotes: state => {
      const votes = {}
      for (const item of state.items) {
        const voters = itemVotes(item)
        if (voters.length > 0) votes[item.id] = [...voters]
      }
      if (state.current && itemVotes(state.current).length > 0) votes[state.current.id] = [...itemVotes(state.current)]
      return votes
    }
```

and the action after `karaokePromote`:

```js
    /**
     * The voter is the singer the sending phone claimed, resolved by the caller: a refusal
     * commits nothing, so a phone cannot make a rejected vote look applied.
     *
     * @param {object} context
     * @param {object} context.state
     * @param {object} context.commit
     * @param {{id: string, singerId: string}} payload
     * @returns {string|null}
     */
    karaokeVote({ state, commit }, payload) {
      const { queue, code } = toggleVote(snapshot(state), payload?.id, payload?.singerId)

      if (code === null) {
        commit('setKaraokeQueue', queue)
        persist(queue)
      }

      return code
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "tests/karaoke-store.test.cjs"`
Expected: PASS (existing cases plus the two new ones).

- [ ] **Step 5: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"`
Expected: **165 pass / 0 fail**.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/modules/karaoke.js tests/karaoke-store.test.cjs
git commit -m "feat(karaoke): the vote action, its getters and persistence"
```

---

### Task 3: The wire — a `vote` command and the frame's `votes` map

**Files:**
- Modify: `src/renderer/remote/agent.js`, `src/renderer/remote/karaoke-actions.js`
- Test: `tests/remote-karaoke.test.cjs`

**Interfaces:**
- Consumes: `getSingerByPhone` (P2), `karaokeVote` (Task 2), the frame builder `buildQueueFrame`.
- Produces: `KARAOKE_COMMANDS` gains `'vote'`; the queue frame gains `votes: {itemId: string[]}`;
  the action `vote`.

- [ ] **Step 1: Write the failing tests**

```js
test('the queue frame carries the votes map, and only for rows that have one', async () => {
  const agent = await load()
  const frame = agent.buildQueueFrame(
    {
      active: true,
      rotation: 'fifo',
      lastSingerId: null,
      current: { id: 'k_now', videoId: 'aaaaaaaaaaa', title: 'Now', votes: [] },
      items: [
        { id: 'k_one', videoId: 'bbbbbbbbbbb', title: 'One', votes: ['s1'] },
        { id: 'k_two', videoId: 'ccccccccccc', title: 'Two' }
      ],
      played: [],
      settings: {}
    },
    []
  )

  assert.deepEqual(frame.votes, { k_one: ['s1'] })
})

test('a vote command names the row with itemId and never the bridge id', async () => {
  const { createKaraokeActions } = await loadActions()
  const seen = []
  const store = {
    dispatch: (type, payload) => {
      seen.push([type, payload])
      return Promise.resolve(null)
    },
    getters: { getSingerByPhone: phoneId => (phoneId === 'ph_1' ? { id: 's1' } : null) }
  }
  const actions = createKaraokeActions(store)

  const code = await actions.vote({ cmd: 'vote', itemId: 'k_one', id: 7, from: 'ph_1' })

  assert.equal(code, null)
  assert.deepEqual(seen, [['karaokeVote', { id: 'k_one', singerId: 's1' }]])
})

test('a phone that has claimed no name cannot vote, and dispatches nothing', async () => {
  const { createKaraokeActions } = await loadActions()
  const seen = []
  const store = {
    dispatch: (type, payload) => {
      seen.push([type, payload])
      return Promise.resolve(null)
    },
    getters: { getSingerByPhone: () => null }
  }
  const actions = createKaraokeActions(store)

  assert.equal(await actions.vote({ cmd: 'vote', itemId: 'k_one', from: 'ph_9' }), 'E_NO_SINGER')
  assert.deepEqual(seen, [])
})

test('a vote from the phone is acked ok:true and republishes a queue frame with the vote in it', async () => {
  // The file's own harness: FakeSocket + createRemoteAgent over the REAL action map and store.
  const { createRemoteAgent } = await load()
  const { createKaraokeActions } = await import('../src/renderer/remote/karaoke-actions.js')
  const store = (await import('../src/renderer/store/modules/karaoke.js')).default
  const roster = (await loadRoster()).claimSinger((await loadRoster()).createRoster(), {
    name: 'Ada', phoneId: 'ph_1'
  }).roster

  const state = store.state()
  const commit = (type, payload) => store.mutations[type](state, payload)
  const dispatch = (type, payload) => store.actions[type]({ state, commit }, payload)
  const singer = roster[0]
  const karaokeActions = createKaraokeActions({
    dispatch,
    getters: { getSingerByPhone: phoneId => roster.find(row => row.phoneId === phoneId) ?? null }
  })

  // Two rows so the move is observable in the republished frame.
  await dispatch('karaokeAdd', { videoId: 'aaaaaaaaaaa', title: 'One' })
  await dispatch('karaokeAdd', { videoId: 'bbbbbbbbbbb', title: 'Two' })
  const target = state.items[1].id

  const video = new EventTarget()
  Object.assign(video, { paused: true, currentTime: 0, duration: 100, volume: 1, muted: false, playbackRate: 1 })
  FakeSocket.instances = []
  const agent = createRemoteAgent({
    url: 'wss://example/ws',
    deviceKey: 'k',
    getVideo: () => video,
    getMeta: () => ({ videoId: 'abc', title: 'T', channel: 'C', thumbnail: '' }),
    getKaraoke: () => state,
    getSingers: () => roster,
    getKaraokeActions: () => karaokeActions,
    WebSocketImpl: FakeSocket,
    now: () => 1000,
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => {}
  })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0

  socket.receive({ t: 'cmd', id: 9, cmd: 'vote', itemId: target, from: 'ph_1' })
  await flush()

  assert.ok(socket.sent.some(m => m.t === 'ack' && m.id === 9 && m.ok === true), 'the vote is acked ok')
  const frame = socket.sent.filter(m => m.t === 'queue').at(-1)
  assert.deepEqual(frame.karaoke.votes, { [target]: [singer.id] })
  assert.equal(frame.karaoke.upcoming[0].id, target, 'the voted row is now first')
  agent.stop()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "tests/remote-karaoke.test.cjs"`
Expected: FAIL — `frame.votes` is `undefined`; `actions.vote is not a function`; `applyKaraokeCommand`
answers `E_UNKNOWN_CMD` for `vote`.

- [ ] **Step 3: Extend the command set, the frame and the action map**

`src/renderer/remote/agent.js` — add `'vote'` to `KARAOKE_COMMANDS` and the map to the frame:

```js
/**
 * `itemId -> voter ids`, for the rows this frame carries and only when a row has a vote at
 * all: an empty array per row would ride every queue change for nothing. The map, not a
 * per-row count, is what a phone needs — it has to know whether the vote is *its*.
 *
 * @param {object} karaoke
 * @returns {object}
 */
function votesForWire(karaoke) {
  const rows = [karaoke.current, ...(Array.isArray(karaoke.items) ? karaoke.items : [])]
  const votes = {}

  for (const row of rows) {
    if (row && Array.isArray(row.votes) && row.votes.length > 0) {
      votes[row.id] = [...row.votes]
    }
  }

  return votes
}
```

and in `buildQueueFrame`'s returned object, after `playedCount`:

```js
    votes: votesForWire(karaoke),
```

`src/renderer/remote/karaoke-actions.js` — add to the map, after `queueMove`:

```js
    // One upvote per singer per song, so the voter is the sender's claimed roster row and
    // never anything the payload says. An unclaimed phone is refused rather than voting as
    // its `from` hash: re-pairing changes that hash, which would buy the same human a
    // second vote — exactly what §5 forbids.
    vote: payload => {
      const singer = store.getters?.getSingerByPhone?.(payload?.from) ?? null

      if (!singer) return 'E_NO_SINGER'

      return store.dispatch('karaokeVote', { id: payload?.itemId, singerId: singer.id })
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "tests/remote-karaoke.test.cjs"`
Expected: PASS, including the pre-existing exact-key-set assertion on the state frame (the map rides the
queue frame only).

- [ ] **Step 5: Run the whole renderer suite, then prove the bundle compiles**

Run: `node --test "tests/*.test.cjs"` → **169 pass / 0 fail**.
Then confirm the dev server compiled the change: the log must show a fresh `compiled successfully` line
after the edit (`~/developer/freetube-devweb/logs/dev-web.log`), read from the raw tail rather than a
filtered summary.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/remote/agent.js src/renderer/remote/karaoke-actions.js tests/remote-karaoke.test.cjs
git commit -m "feat(karaoke): a vote command over the wire and votes on the queue frame"
```

---

### Task 4: The TV shows the counts, and a badge on the leader

**Files:**
- Modify: `src/renderer/components/FtKaraokeQueue/FtKaraokeQueue.vue`,
  `src/renderer/components/FtKaraokeQueue/FtKaraokeQueue.css`, `static/locales/en-US.yaml`

**Interfaces:**
- Consumes: `getKaraokeVoteCount`, `getKaraokeTopVotedId` (Task 2).
- Produces: the rendered classes `.karaokeQueueVotes` (per row) and `.karaokeQueueBadge.topVoted`;
  locale keys `Karaoke.Top Voted`.

- [ ] **Step 1: Add the count and the badge to the row markup**

Inside the `v-for` row `<li>`, after the priority badge:

```html
        <span
          v-if="voteCount(item.id) > 0"
          class="karaokeQueueVotes"
          :title="t('Karaoke.Votes')"
        >
          ▲ {{ voteCount(item.id) }}
        </span>
        <span
          v-if="topVotedId === item.id"
          class="karaokeQueueBadge topVoted"
        >
          {{ t('Karaoke.Top Voted') }}
        </span>
```

On the current-song line, so the song on screen shows its count too:

```html
      <span
        v-if="currentVotes > 0"
        class="karaokeQueueVotes"
      >
        ▲ {{ currentVotes }}
      </span>
```

and in `<script setup>`:

```js
const topVotedId = computed(() => store.getters.getKaraokeTopVotedId)
const currentVotes = computed(() => store.getters.getKaraokeVoteCount(current.value?.id))

/**
 * @param {string} id
 * @returns {number}
 */
function voteCount(id) {
  return store.getters.getKaraokeVoteCount(id)
}
```

- [ ] **Step 2: Style them**

In `FtKaraokeQueue.css`, next to the existing `.karaokeQueueBadge` rules:

```css
.karaokeQueueVotes {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  white-space: nowrap;
}

.karaokeQueueBadge.topVoted {
  /* Distinct from the priority badge: a vote is a suggestion, priority is a jump. */
  outline: 1px solid currentColor;
}
```

- [ ] **Step 3: Add the locale keys**

In `static/locales/en-US.yaml` under `Karaoke:`:

```yaml
  Votes: Votes
  Top Voted: Top voted
```

- [ ] **Step 4: Verify it compiles and serves**

`systemctl --user restart freetube-web` (locale keys are compiled at build time), then require a fresh
`compiled successfully` line in the raw log tail and a `200` from `http://100.77.173.63:9080/`.

- [ ] **Step 5: Prove it in the live DOM**

In the browser (CDP), on `#/karaoke` with a queue holding one voted row: the row carries
`.karaokeQueueVotes` with the count as its text, and the leader (`getKaraokeTopVotedId`) carries
`.karaokeQueueBadge.topVoted`. Read the classes and text out of the DOM; a screenshot is not evidence.
Copy the exact strings into the reply.

- [ ] **Step 6: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"` → **169 pass / 0 fail** (no JS test harness covers an SFC).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/FtKaraokeQueue static/locales/en-US.yaml
git commit -m "feat(karaoke): vote counts and a top-voted badge on the TV queue"
```

---

### Task 5: The phone votes

**Files:**
- Modify: `freetube-remote` `web/karaoke.js`, `web/app.js`, `web/app.css`, `web/index.html`
- Test: `freetube-remote` `tests-web/karaoke.test.mjs`

**Interfaces:**
- Consumes: the frame's `votes` map (Task 3), `itemCommand` and `findSingerId` (P2), `karaokeCommand`
  (P2's `app.js` helper), the ack handler's single-outstanding discipline.
- Produces: `voteInfo(votes, rowId, mySingerId) -> {count, mine}`, `voteFailure(code) -> string`, the
  phone's `vote` command, the `#queue-error` line, and `state.votePending`.

- [ ] **Step 1: Write the failing tests**

```js
import { voteInfo, voteFailure } from './karaoke.js'

test('voteInfo counts the voters and says whether one of them is you', () => {
  const votes = { k_one: ['s1', 's2'] }

  assert.deepEqual(voteInfo(votes, 'k_one', 's2'), { count: 2, mine: true })
  assert.deepEqual(voteInfo(votes, 'k_one', 's9'), { count: 2, mine: false })
  assert.deepEqual(voteInfo(votes, 'k_two', 's1'), { count: 0, mine: false })
  // A frame from a TV that did not carry the map at all must not throw.
  assert.deepEqual(voteInfo(undefined, 'k_one', 's1'), { count: 0, mine: false })
  // No claimed name: nothing may ever read as "your vote".
  assert.deepEqual(voteInfo(votes, 'k_one', null), { count: 2, mine: false })
})

test('a refused vote reads as a sentence, not a code', () => {
  assert.equal(voteFailure('E_NO_SINGER'), 'Claim a name before voting.')
  assert.equal(voteFailure('E_NOT_QUEUED'), 'That song is not in the queue any more.')
  assert.match(voteFailure('E_WHATEVER'), /E_WHATEVER/)
})

test('a vote command carries itemId and is refused without a row id', () => {
  assert.deepEqual(itemCommand('vote', { id: 'k_one' }), { cmd: 'vote', itemId: 'k_one' })
  assert.equal(itemCommand('vote', {}), null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "tests-web/*.test.mjs"` (from `~/developer/freetube-remote`)
Expected: FAIL — `voteInfo`/`voteFailure` are not exported.

- [ ] **Step 3: Write the pure helpers**

In `web/karaoke.js`, after `itemCommand`:

```js
/**
 * What a row's vote button shows for this phone: how many singers voted, and whether one of
 * them is this phone's singer. The frame carries voters as ids, so a phone that never learns
 * which phone voted — the P2 roster rule — can still tell whether the vote is its own. A
 * frame with no `votes` map at all (an older TV) counts as no votes.
 *
 * @param {object} votes the frame's `itemId -> singer ids` map
 * @param {string} rowId
 * @param {string|null} mySingerId
 * @returns {{count: number, mine: boolean}}
 */
export function voteInfo(votes, rowId, mySingerId) {
  const voters = Array.isArray(votes?.[rowId]) ? votes[rowId] : []

  return { count: voters.length, mine: Boolean(mySingerId) && voters.includes(mySingerId) }
}

/**
 * A refused vote, as something a human can read.
 *
 * @param {string} [code]
 * @returns {string}
 */
export function voteFailure(code) {
  const known = {
    E_NO_SINGER: 'Claim a name before voting.',
    E_NOT_QUEUED: 'That song is not in the queue any more.',
    E_OFFLINE: 'The TV is offline.',
    E_TOO_MANY: 'Slow down a moment — the TV is refusing commands.'
  }

  return known[code] ?? `The TV refused that vote (${code ?? 'unknown'}).`
}
```

- [ ] **Step 4: Wire the button and the ack**

In `web/app.js`:
1. add `'vote'` to the phone's `KARAOKE_COMMANDS` set;
2. in `queueRow(row)`, before the promote/remove buttons:

```js
  const info = voteInfo(state.queue?.votes, row.id, state.mySingerId)
  const vote = document.createElement('button')
  vote.type = 'button'
  vote.className = info.mine ? 'vote voted' : 'vote'
  vote.textContent = info.count > 0 ? `▲ ${info.count}` : '▲'
  vote.setAttribute('aria-label', info.mine ? 'Remove your vote' : 'Vote for this song')
  if (state.mySingerId) {
    vote.addEventListener('click', () => sendVote(row))
  } else {
    // A vote is a singer's, and this phone has no name yet: offering a button that can only
    // be refused teaches the wrong thing, so it is visibly inert until a name is claimed.
    vote.disabled = true
    vote.title = 'Claim a name to vote'
  }
```

3. next to `sendClaim`, the sender and the gate:

```js
function sendVote(row) {
  $('queue-error').textContent = ''
  const mapped = itemCommand('vote', row)

  if (!mapped || !state.mySingerId) {
    $('queue-error').textContent = 'That row cannot be voted on.'
    return
  }
  if (state.socket?.readyState !== 1) {
    $('queue-error').textContent = 'The TV is offline.'
    return
  }
  // Acks carry the bridge's id, never ours, so at most one command may be in flight: a vote
  // sent while a claim or an open is unanswered would let that command's ack be read as this
  // vote's (and vice versa — sendClaim/requestOpen refuse while a vote is pending).
  if (state.claimPending || state.openPending) return
  state.votePending = true
  karaokeCommand(mapped.cmd, { itemId: mapped.itemId })
}
```

4. in the ack handler, between the claim branch and `if (!state.openPending) return`:

```js
      if (state.votePending) {
        // A vote is optimistic in the UI already (the TV republishes the frame), so only a
        // refusal is worth showing.
        state.votePending = false
        if (!message.ok) $('queue-error').textContent = voteFailure(message.code)
        return
      }
```

5. clear `state.votePending` in `socket.onclose` alongside the other pending flags, and in the
   `sendClaim` / `requestOpen` single-outstanding guards (`if (state.votePending) return` is NOT
   wanted there — a vote is small and self-healing; instead make `sendVote` wait, as above, and leave
   claim/open untouched).

6. add `<p id="queue-error" class="error" role="alert"></p>` under the `Up next` list in
   `web/index.html`, import `voteInfo`/`voteFailure` in `app.js`'s import line, and add `.vote` /
   `.vote.voted` rules to `web/app.css` (a voted row's button reads as pressed).

- [ ] **Step 5: Run the tests to verify they pass, and the page is served**

Run: `node --test "tests-web/*.test.mjs"` → **19 pass / 0 fail**.
Then `systemctl --user restart freetube-remote` and require `200` on the funnel origin
(`https://nextcloud.taild1347f.ts.net:10000/remote/`) plus the served `app.js` carrying `sendVote`.

- [ ] **Step 6: Commit**

```bash
git add web/karaoke.js web/app.js web/app.css web/index.html tests-web/karaoke.test.mjs
git commit -m "feat(karaoke): the phone votes, and says so when the TV refuses"
```

---

### Task 6: The bridge limits a phone's command rate

**Files:**
- Modify: `freetube-remote` `app/hub.py`
- Test: `freetube-remote` `tests/test_hub.py`

**Interfaces:**
- Consumes: `AttemptLimiter` (`app/limits.py`), the hub's `phone()` relay.
- Produces: `Hub(rooms, public_base, auth_timeout=..., command_limiter=None)`; constants
  `COMMAND_LIMIT = 30`, `COMMAND_WINDOW_S = 10.0`; a refusal `{t:'ack', ok:false, code:'E_TOO_MANY'}`
  that is never relayed.

- [ ] **Step 1: Write the failing tests**

```python
def test_a_flood_of_phone_commands_is_refused_without_reaching_the_player(tmp_path):
    rooms = Rooms(tmp_path / "state.json")
    # A limiter that never forgets, so the test does not depend on wall-clock timing.
    hub = Hub(rooms, BASE, command_limiter=AttemptLimiter(limit=2, window_s=10.0))
    player_id = rooms.register_player("k1")
    _, token = rooms.claim(rooms.open_pairing(player_id))

    async def scenario():
        player, phone = FakeWS(), FakeWS()
        player.push(auth_player("k1"))
        phone.push({"t": "auth", "role": "phone", "token": token})
        player_task = asyncio.create_task(hub.session(player))
        phone_task = asyncio.create_task(hub.session(phone))
        await until(lambda: player.sent and phone.sent)

        for command_id in (1, 2, 3):
            phone.push({"t": "cmd", "cmd": "vote", "id": command_id, "itemId": "k_one"})
        await until(lambda: phone.sent[-1].get("t") == "ack" and not phone.sent[-1]["ok"])

        relayed = [m for m in player.sent if m.get("t") == "cmd"]
        assert len(relayed) == 2, "only the first two commands are relayed"
        assert phone.sent[-1] == {"t": "ack", "id": 3, "ok": False, "code": "E_TOO_MANY"}

        player.stop()
        phone.stop()
        await asyncio.gather(player_task, phone_task)

    asyncio.run(scenario())


def test_the_command_limit_is_per_phone(tmp_path):
    rooms = Rooms(tmp_path / "state.json")
    hub = Hub(rooms, BASE, command_limiter=AttemptLimiter(limit=1, window_s=10.0))
    player_id = rooms.register_player("k1")
    _, token = rooms.claim(rooms.open_pairing(player_id))
    # A second paired phone of the same player: identity is per phone, so its own budget is full.
    _, other_token = rooms.claim(rooms.open_pairing(player_id))

    async def scenario():
        player, first, second = FakeWS(), FakeWS(), FakeWS()
        player.push(auth_player("k1"))
        first.push({"t": "auth", "role": "phone", "token": token})
        second.push({"t": "auth", "role": "phone", "token": other_token})
        tasks = [asyncio.create_task(hub.session(ws)) for ws in (player, first, second)]
        await until(lambda: player.sent and first.sent and second.sent)

        first.push({"t": "cmd", "cmd": "vote", "id": 1, "itemId": "k_one"})
        first.push({"t": "cmd", "cmd": "vote", "id": 2, "itemId": "k_one"})
        second.push({"t": "cmd", "cmd": "vote", "id": 3, "itemId": "k_one"})
        await until(lambda: len([m for m in player.sent if m.get("t") == "cmd"]) == 2)

        assert [m.get("code") for m in first.sent if m.get("t") == "ack"] == [None, "E_TOO_MANY"]
        # ^ CORRECTED IN IMPLEMENTATION: a relayed command is acked by the PLAYER, so the only
        # ack a phone gets from the bridge is a refusal. The landed assertion is
        # `== [{"t":"ack","id":2,"ok":False,"code":"E_TOO_MANY"}]` plus a check that the relayed
        # commands carry one `from` per phone. The plan's original line encoded a wrong model.
        # The other phone is untouched: its command was relayed, not refused.
        assert second.sent[-1].get("code") is None

        for ws in (player, first, second):
            ws.stop()
        await asyncio.gather(*tasks)

    asyncio.run(scenario())
```

(`FakeWS`, `until`, `auth_player` and `BASE` are this file's existing helpers; import `AttemptLimiter` from
`app.limits`. Keep the existing `make()` helper working by leaving `command_limiter` defaulted — the
default is built from `COMMAND_LIMIT`/`COMMAND_WINDOW_S`, so a test that sends three commands is not
limited.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_hub.py -q`
Expected: FAIL — `Hub.__init__() got an unexpected keyword argument 'command_limiter'`.

- [ ] **Step 3: Limit the relay**

In `app/hub.py`:

```python
from .limits import AttemptLimiter
from .rooms import PAIR_TTL_S, Rooms

AUTH_TIMEOUT_S = 5.0
MAX_SOCKETS = 64
#: Per phone, not per socket and not global: queue ops are cheap and the vote button is the
#: spam surface (§10). 30 in 10 s is far above a human tapping a phone and far below a loop.
COMMAND_LIMIT = 30
COMMAND_WINDOW_S = 10.0
```

```python
    def __init__(
        self,
        rooms: Rooms,
        public_base: str,
        auth_timeout: float = AUTH_TIMEOUT_S,
        command_limiter: AttemptLimiter | None = None,
    ) -> None:
        ...
        self.command_limiter = command_limiter or AttemptLimiter(
            limit=COMMAND_LIMIT, window_s=COMMAND_WINDOW_S
        )
```

and inside `phone()`'s loop, right after the `kind != "cmd"` check and BEFORE the offline branch (a
refused command costs nothing and deserves the same answer whether or not the player is online):

```python
                key = phone_id or "phone"
                if not self.command_limiter.allow(key):
                    await ws.send_json(
                        {"t": "ack", "id": message.get("id"), "ok": False, "code": "E_TOO_MANY"}
                    )
                    continue
                self.command_limiter.record(key)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests -q` → **45 passed** (43 + 2).

- [ ] **Step 5: Commit**

```bash
git add app/hub.py tests/test_hub.py
git commit -m "feat(karaoke): a per-phone command limit on the relay"
```

---

### Task 7: End-to-end evidence, and the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-11-10-karaoke-night-design.md` (the Status line)

- [ ] **Step 1: Full suites, from the raw output**

```bash
cd ~/developer/freetube && node --test "tests/*.test.cjs" | tail -6
cd ~/developer/freetube-remote && uv run pytest tests -q | tail -3 && node --test "tests-web/*.test.mjs" | tail -6
```

Record the three counts as printed. Read them from the run, never from this plan.

- [ ] **Step 2: A vote moves a song on the TV — against the real bridge**

With the app open on `#/karaoke` and two queues' worth of rows: from the phone, tap ▲ on the last row;
read the TV's DOM back and show the row's new position, its `.karaokeQueueVotes` text, and the
`.karaokeQueueBadge.topVoted` on the leader. Then tap ▲ again and show the count drop.

- [ ] **Step 3: One vote per singer, across a re-pair**

Re-pair the phone (the bridge mints a new `from`), claim the SAME roster name again, tap ▲ on the same
song, and show the count did NOT move: the voter is the roster row, so re-pairing buys nothing. This is
P3's own "proves" line.

- [ ] **Step 4: The refusals are visible**

Vote on a song that has started playing (the `E_NOT_QUEUED` path) and confirm the phone shows
"That song is not in the queue any more." A refusal that only appears in a log is not done.

- [ ] **Step 5: Update the spec status line, and commit**

```markdown
**Status:** P1 BUILT — `00cbeab51`; P2 BUILT — renderer `3058b745e`, bridge/phone `ff68c80`;
P3 BUILT — renderer `<sha>`, bridge/phone `<sha>`; renderer <N> tests, bridge <N> + <N> phone.
```

```bash
git add docs/superpowers/specs/2026-11-10-karaoke-night-design.md
git commit -m "docs(karaoke): P3 status and measured evidence"
```

---

## Self-review notes (kept in the plan on purpose)

- **Spec coverage.** §5 upvote-only, one per singer, toggleable → Task 1 (`toggleVote`). §5 "votes order
  the normal tier… priority items display counts but do not move" → Task 1 (`votePosition`'s priority
  branch, verified by its own test). §5 "phone: ▲ with count on each queued row / TV: count plus a
  top-voted badge" → Tasks 4 and 5. §5 `E_NOT_QUEUED` after play → Task 1. §3's `pick()` is untouched:
  a vote reorders `items`, and `pickNext` already reads `items[0]` under `fifo`. §10's `vote` command and
  its `votes` map → Task 3; §10's per-phone command limit → Task 6. §11's storage rule "queue and mode
  flag: a single localStorage key, not a datastore" → Task 2 (no new datastore).
- **Two rulings this plan makes, and their cost if wrong.**
  (1) *An unvote does not re-sort.* The spec defines movement for a vote, not an unvote; re-sorting on
  removal would jump a 0-vote row to the head of its lane — a visible teleport the user never asked for.
  If wrong, the cost is a tier that is only sorted among voted rows until the next vote, which is
  cosmetic, not money or data.
  (2) *The top-voted badge ignores priority rows.* They already carry the priority badge, and a vote
  cannot move them (§5); if wrong, the cost is one row showing two badges in an unusual order.
- **`stats.votesCast` is deliberately not written.** The roster's record shape has it (§4) but nothing in
  P3 displays it, and P6's leaderboard is where it becomes visible; writing a counter no surface reads
  would be untested state. Task 1's votes are party state on the queue row, exactly as §8 says.
- **No schema bump.** `votes` is an optional field on a persisted row: an old payload loads with no
  votes, a new payload read by old code ignores them harmlessly. `deserializeQueue` hardens the field
  because localStorage is writable by anything on the origin.
- **The single-outstanding hazard is real and is Task 5's design.** The phone correlates acks by having
  at most one command in flight (the bridge stamps acks with its own id); a vote in flight while a claim
  is unanswered would let one ack be read as the other, which is how a rejected name gets adopted.
  `sendVote` therefore refuses while a claim or open is pending, and the ack handler consumes the vote
  flag before the open branch.
- **What P3 does not do.** Drag reordering (P4), saved playlists (P5), scoring (P6), downvotes (out of
  scope in the spec), and any TV-side vote button — the TV is display-only for votes per §5.

---

## Evidence recorded 2026-11-11 (Task 7, as executed)

**Step 1 — the three suites, read from the raw runs (not from this plan):**

| suite | command | tests | pass | fail |
|---|---|---|---|---|
| renderer | `node --test "tests/*.test.cjs"` (freetube) | 170 | 170 | 0 |
| bridge | `uv run pytest tests -q` (freetube-remote) | — | 45 | 0 |
| phone web | `node --test "tests-web/*.test.mjs"` | 19 | 19 | 0 |

The plan predicted 12 new vote tests; Task 1 landed 13 (164 after T1, 166 after T2, 170 after T3).

**Step 2 — a vote moves a song on the TV, against the real bridge. DONE.**
TV = the dev web build (`http://100.77.173.63:9080/#/karaoke`) on branch `karaoke-night-p3`; phone = the
real PWA (`https://nextcloud.taild1347f.ts.net:10000/remote/`) paired with a code minted on the TV.
Queue seeded Alpha/Bravo/Charlie, all unvoted. The phone tapped ▲ on the LAST row (Charlie):

- phone read back: `Charlie "▲ 1" class="vote voted"`, then `Alpha`, then `Bravo`
- TV DOM read back: `{"title":"Charlie","votes":"▲ 1","badges":["Top voted [topVoted]"]}`, Alpha and
  Bravo with `votes: null` and no badges
- TV's persisted queue: `items.map(i => [i.title, i.votes])` →
  `[["Charlie",["s_mwcgzi48_5zlq"]],["Alpha",[]],["Bravo",[]]]`

A second tap on the same row dropped it: phone `"▲" class="vote"`, TV DOM `votes: null`, badges `[]`,
stored `[["Charlie",[]], ...]`. A third tap returned it to `"▲ 1"`.

**Step 3 — one vote per singer, across a re-pair. DONE, with a deviation.**
The phone's storage was cleared, the TV minted a second code, and the phone paired again (the bridge
minted a new `from`). The plan's next move — "claim the SAME roster name again" — is refused by P2's
name-taken rule: `"Someone already has that name. Pick another."`, twice, with the roster row visible
on the TV as `Ada · host` and still live. So a re-paired phone cannot silently re-bind to the same
roster row while that row is active.

What the spec's §5 actually asserts is the stronger invariant — "the roster row, not the device, is
the voter" — and that was measured: after re-pairing and claiming a *different* name (`Bo`), Charlie's
row still read `"▲ 1"` with class `vote`, NOT `voted`. The re-paired device did not own Ada's vote.
Re-pairing therefore buys nothing: the count is a function of roster rows, not of sockets.

**Step 4 — the refusals are visible. NOT ACHIEVED LIVE; the plan's step as written is unreachable.**
The phone's list is built from the frame's `upcoming` only (`orderOwn(karaoke?.upcoming ?? [], …)`), so
a song that has started playing is not on the phone and has no ▲ to tap. The `E_NOT_QUEUED` guard is
reachable only by a stale frame — a millisecond race between the tap and the republish — or by a
synthetic ack. The two messages the phone can print are unit-tested
(`voteFailure('E_NOT_QUEUED')` → "That song is not in the queue any more.",
`voteFailure('E_TOO_MANY')` → "Slow down a moment — the TV is refusing commands."),
and the phone's ack branch that prints them is `state.votePending` → `voteFailure`. To make this
step testable, the ack branch needs to move out of `app.js` into a pure helper with its own test;
that is a follow-up, not something this phase claimed.

**Step 5 — this file, and the spec's status line. DONE.**

**Environment change made to run Step 2, and it is reversible:** the TV page's origin was refused
4403 by the bridge's origin check, so `http://100.77.173.63:9080` was appended to
`FREETUBE_REMOTE_ALLOWED_ORIGINS` in `~/.config/systemd/user/freetube-remote.service` (the same
precedent as adding `app://bundle`, design spec §"Evidence"), then `systemctl --user daemon-reload`
and restart. Remove that entry to undo.
