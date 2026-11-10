# Karaoke Night P1 (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A karaoke mode in FreeTube that searches karaoke only, holds a priority queue owned by the
renderer, and advances it automatically as songs end — with the bridge relaying queue state to the
phone.

**Architecture:** Pure logic lives in two Node-testable helpers (`helpers/karaoke.js`,
`helpers/karaoke-queue.js`). A thin Vuex module (`store/modules/karaoke.js`) owns state and
persistence. The `/karaoke` view searches and enqueues; `Watch.js` is the only place playback order
changes. The remote agent publishes a `queue` frame and accepts queue commands; the bridge stamps
`from` on relayed commands and relays the frame.

**Tech Stack:** Vue 3 + Vuex 4 + webpack (renderer), vanilla JS (`src/renderer/...`), Node `node:test`
for renderer tests, FastAPI + Starlette (bridge), pytest.

**Spec:** `docs/superpowers/specs/2026-11-10-karaoke-night-design.md` (read §1–§3, §7, §10, §11 for
this plan; §4–§6 and §8–§9 are P2–P6 and must NOT be built here).

## Global Constraints

- **Scope:** P1 only — mode, karaoke search, queue with priority + cap, Watch wiring, remote
  commands and the `queue` frame, bridge `from` stamp + `queue` relay, localStorage persistence.
  No singers, no rotation, no voting, no drag, no playlist save/load, no scoring.
- Priority means: a priority item plays before any normal item; FIFO inside the priority tier.
  Cap: 2 outstanding priority items per requester (`E_PRIORITY_CAP`, the item is added as normal).
- Karaoke search: append ` karaoke` when the query has no karaoke token; keep videos only whose
  title or channel matches `KARAOKE_TITLE_PATTERN` and whose duration is 90–720 s (unknown duration
  passes) ; fetch up to 3 pages until 8 kept results.
- Queue state shape (exact): `{ active, rotation, current, items, played, settings }` where
  `current` is an item or `null` and is NOT in `items`; `played` holds item snapshots, LIFO, max 50;
  `settings` is `{ filterOn, minSeconds, maxSeconds, priorityCap }`.
- Storage key: `freetube-karaoke` (one key, not per profile).
- Locale keys go in `static/locales/en-US.yaml`; a new key needs
  `systemctl --user restart freetube-web` before the page renders it (compiled at build time).
- eslint/stylelint run under Node 24 (`devEngines.runtime`); a commit needing `--no-verify` is a
  finding to report, not a step to take.
- Test commands: renderer `node --test "tests/*.test.cjs"` (64 passing before this plan); bridge
  `uv run pytest tests` (38 passing) and `node --test "tests-web/*.test.mjs"` (3 passing).
- The new route renders its component directly — never inside `<Transition mode="out-in">` (a hidden
  window never fires `transitionend` and the route freezes with no error).

---

### Task 1: Karaoke search helpers

**Files:**
- Create: `src/renderer/helpers/karaoke.js`
- Create: `tests/fixtures/karaoke-titles.json`
- Test: `tests/karaoke-helpers.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `KARAOKE_QUERY_TOKENS: string[]`, `KARAOKE_TITLE_PATTERN: RegExp`,
  `DEFAULT_MIN_SECONDS = 90`, `DEFAULT_MAX_SECONDS = 720`, `TARGET_RESULTS = 8`, `MAX_PAGES = 3`,
  `buildKaraokeQuery(input: string): string`,
  `videoSeconds(video: object): number|null`,
  `isKaraokeVideo(video: object, bounds?: {minSeconds?: number, maxSeconds?: number}): boolean`,
  `filterKaraokeResults(results: object[], bounds?): object[]`,
  `needsAnotherPage(keptCount: number, pagesFetched: number): boolean`.

- [ ] **Step 1: Write the shared fixture**

Create `tests/fixtures/karaoke-titles.json` (the phone PWA runs this same file in P2/P3, so it is the
one place the rules are pinned):

```json
{
  "queries": [
    { "input": "", "expected": "" },
    { "input": "   ", "expected": "" },
    { "input": "bohemian rhapsody", "expected": "bohemian rhapsody karaoke" },
    { "input": "  Bohemian   Rhapsody  ", "expected": "Bohemian Rhapsody karaoke" },
    { "input": "adele karaoke", "expected": "adele karaoke" },
    { "input": "adele KARAOKE version", "expected": "adele KARAOKE version" },
    { "input": "hello instrumental", "expected": "hello instrumental" },
    { "input": "hello backing track", "expected": "hello backing track" },
    { "input": "hello sing along", "expected": "hello sing along" },
    { "input": "hello minus one", "expected": "hello minus one" },
    { "input": "hello lyrics", "expected": "hello lyrics karaoke" }
  ],
  "videos": [
    { "type": "video", "title": "Bohemian Rhapsody Karaoke (Instrumental)", "author": "Sing King", "lengthSeconds": 355, "karaoke": true },
    { "type": "video", "title": "Bohemian Rhapsody (Official Video)", "author": "Queen Official", "lengthSeconds": 355, "karaoke": false },
    { "type": "video", "title": "Bohemian Rhapsody", "author": "Karaoke Channel", "lengthSeconds": 355, "karaoke": true },
    { "type": "video", "title": "Hello - Backing Track", "author": "Music Minus One", "lengthSeconds": 300, "karaoke": true },
    { "type": "video", "title": "KTV 1080P 王菲 我愿意", "author": "KTV", "lengthSeconds": 240, "karaoke": true },
    { "type": "video", "title": "Adele - Hello (Karaoke Version)", "author": "Too Short", "lengthSeconds": 30, "karaoke": false },
    { "type": "video", "title": "Adele Hello karaoke", "author": "Too Long", "lengthSeconds": 900, "karaoke": false },
    { "type": "video", "title": "Mystery Karaoke", "author": "Unknown Length", "lengthSeconds": null, "karaoke": true },
    { "type": "video", "title": "Mystery Song", "author": "Unknown Length", "lengthSeconds": null, "karaoke": false },
    { "type": "playlist", "title": "Karaoke hits playlist", "author": "Someone", "lengthSeconds": null, "karaoke": false }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/karaoke-helpers.test.cjs`:

```js
// tests/karaoke-helpers.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/renderer/helpers/karaoke.js')
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'karaoke-titles.json'), 'utf8'))

test('every fixture query is rewritten as the fixture expects', async () => {
  const { buildKaraokeQuery } = await load()

  for (const entry of fixture.queries) {
    assert.equal(buildKaraokeQuery(entry.input), entry.expected, JSON.stringify(entry.input))
  }
})

test('every fixture video is kept or dropped as the fixture expects', async () => {
  const { isKaraokeVideo } = await load()

  for (const video of fixture.videos) {
    assert.equal(isKaraokeVideo(video), video.karaoke, `${video.title} (${video.author})`)
  }
})

test('filterKaraokeResults keeps exactly the flagged videos, in order', async () => {
  const { filterKaraokeResults } = await load()

  const kept = filterKaraokeResults(fixture.videos)
  const expected = fixture.videos.filter(video => video.karaoke).map(video => video.title)

  assert.deepEqual(kept.map(video => video.title), expected)
})

test('the duration bounds are adjustable', async () => {
  const { filterKaraokeResults } = await load()

  const long = { type: 'video', title: 'Karaoke marathon', author: 'X', lengthSeconds: 1800 }

  assert.equal(filterKaraokeResults([long]).length, 0)
  assert.equal(filterKaraokeResults([long], { maxSeconds: 3600 }).length, 1)
})

test('paging stops at eight results or three pages', async () => {
  const { needsAnotherPage } = await load()

  assert.equal(needsAnotherPage(0, 1), true)
  assert.equal(needsAnotherPage(7, 2), true)
  assert.equal(needsAnotherPage(8, 1), false)
  assert.equal(needsAnotherPage(2, 3), false)
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test "tests/karaoke-helpers.test.cjs"`
Expected: FAIL — `Cannot find module .../src/renderer/helpers/karaoke.js`.

- [ ] **Step 4: Write the helper**

Create `src/renderer/helpers/karaoke.js`:

```js
// Karaoke-only search: query rewriting, result filtering and the paging rule.
//
// Pure on purpose: no Vue, no Electron, no window. `tests/karaoke-helpers.test.cjs`
// runs this in node, and the phone PWA carries an equivalent matcher pinned to the
// same fixture file (tests/fixtures/karaoke-titles.json).

export const KARAOKE_QUERY_TOKENS = [
  'karaoke',
  'instrumental',
  'backing track',
  'backing-track',
  'sing along',
  'sing-along',
  'minus one',
  'off vocal',
  'off-vocal',
  'ktv'
]

export const KARAOKE_TITLE_PATTERN = /\bkaraoke\b|instrumental|backing[\s-]?track|sing[\s-]?along|minus[\s-]?one|off[\s-]?vocal|\bktv\b|\blyrics?\b/i

export const DEFAULT_MIN_SECONDS = 90
export const DEFAULT_MAX_SECONDS = 720
export const TARGET_RESULTS = 8
export const MAX_PAGES = 3

/**
 * Appends the karaoke token so YouTube's ranking does the heavy lifting, unless the
 * user already asked for something karaoke-shaped.
 *
 * @param {string} input
 * @returns {string}
 */
export function buildKaraokeQuery(input) {
  const query = String(input ?? '').trim().replace(/\s+/g, ' ')

  if (query === '') {
    return ''
  }

  const lower = query.toLowerCase()
  if (KARAOKE_QUERY_TOKENS.some(token => lower.includes(token))) {
    return query
  }

  return `${query} karaoke`
}

/**
 * @param {object} video
 * @returns {number|null} seconds, or null when the API did not say
 */
export function videoSeconds(video) {
  const value = Number(video?.lengthSeconds ?? video?.durationSeconds)

  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * @param {object} video
 * @param {{minSeconds?: number, maxSeconds?: number}} [bounds]
 * @returns {boolean}
 */
export function isKaraokeVideo(video, bounds = {}) {
  if (!video || video.type !== 'video') {
    return false
  }

  const min = Number.isFinite(bounds.minSeconds) ? bounds.minSeconds : DEFAULT_MIN_SECONDS
  const max = Number.isFinite(bounds.maxSeconds) ? bounds.maxSeconds : DEFAULT_MAX_SECONDS
  const seconds = videoSeconds(video)

  // A duration the API did not state cannot be judged; dropping those would hide
  // real karaoke tracks behind an API quirk.
  if (seconds !== null && (seconds < min || seconds > max)) {
    return false
  }

  return KARAOKE_TITLE_PATTERN.test(`${video.title ?? ''} ${video.author ?? video.channelName ?? ''}`)
}

/**
 * @param {object[]} results
 * @param {{minSeconds?: number, maxSeconds?: number}} [bounds]
 * @returns {object[]}
 */
export function filterKaraokeResults(results, bounds = {}) {
  return (results ?? []).filter(item => isKaraokeVideo(item, bounds))
}

/**
 * @param {number} keptCount
 * @param {number} pagesFetched
 * @returns {boolean}
 */
export function needsAnotherPage(keptCount, pagesFetched) {
  return keptCount < TARGET_RESULTS && pagesFetched < MAX_PAGES
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test "tests/karaoke-helpers.test.cjs"`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/helpers/karaoke.js tests/karaoke-helpers.test.cjs tests/fixtures/karaoke-titles.json
git commit -m "feat(karaoke): karaoke-only query rewrite and result filter"
```

---

### Task 2: The queue reducer

**Files:**
- Create: `src/renderer/helpers/karaoke-queue.js`
- Test: `tests/karaoke-queue.test.cjs`

**Interfaces:**
- Consumes: nothing (independent of Task 1).
- Produces: `VIDEO_ID: RegExp`, `PLAYED_LIMIT = 50`, `PRIORITY_CAP = 2`,
  `CODES = { BAD_VIDEO_ID, DUPLICATE, PRIORITY_CAP, NOT_FOUND, BAD_INDEX }`,
  `defaultSettings(): {filterOn, minSeconds, maxSeconds, priorityCap}`,
  `createQueue(): Queue`, and every mutator as `(queue, ...args) => { queue: Queue, code: string|null }`:
  `addItem(queue, item, requester?)`, `removeItem(queue, id)`, `clearQueue(queue)`,
  `promoteItem(queue, id, {force}?)`, `moveItem(queue, id, toIndex)`, `startItem(queue, id)`,
  `completeCurrent(queue)`, `previous(queue)`, `setActive(queue, active)`, `setSettings(queue, partial)`;
  reads: `pickNext(queue)`, `priorityCount(queue, requester)`;
  persistence: `serializeQueue(queue)`, `deserializeQueue(json)`.

- [ ] **Step 1: Write the failing test**

Create `tests/karaoke-queue.test.cjs`:

```js
// tests/karaoke-queue.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/helpers/karaoke-queue.js')

const A = { videoId: 'aaaaaaaaaaa', title: 'A' }
const B = { videoId: 'bbbbbbbbbbb', title: 'B' }
const C = { videoId: 'ccccccccccc', title: 'C' }
const D = { videoId: 'ddddddddddd', title: 'D' }

function ids(queue) {
  return queue.items.map(item => item.title)
}

test('a normal add appends and a priority add jumps ahead of it', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, B).queue
  queue = addItem(queue, C).queue

  const withPriority = addItem(queue, { ...A, priority: true }, 'ph_1')
  assert.equal(withPriority.code, null)
  assert.deepEqual(ids(withPriority.queue), ['A', 'B', 'C'])
})

test('priority keeps FIFO order inside its own tier', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, { ...A, priority: true }, 'ph_1').queue
  queue = addItem(queue, { ...B, priority: true }, 'ph_1').queue
  queue = addItem(queue, C).queue

  assert.deepEqual(ids(queue), ['A', 'B', 'C'])
})

test('the third priority request from one requester is demoted to normal', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, { ...A, priority: true }, 'ph_1').queue
  queue = addItem(queue, { ...B, priority: true }, 'ph_1').queue
  const third = addItem(queue, { ...C, priority: true }, 'ph_1')

  assert.equal(third.code, 'E_PRIORITY_CAP')
  assert.equal(third.queue.items.find(item => item.title === 'C').priority, false)

  // another requester still has their own two
  const other = addItem(third.queue, { ...D, priority: true }, 'ph_2')
  assert.equal(other.code, null)
  assert.equal(other.queue.items.find(item => item.title === 'D').priority, true)
})

test('the same video cannot be queued twice, another one can', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, A, 'ph_1').queue

  assert.equal(addItem(queue, A, 'ph_2').code, 'E_DUPLICATE')
  assert.equal(addItem(queue, { ...A, title: 'A again', priority: true }, 'ph_2').code, 'E_DUPLICATE')

  const second = addItem(queue, B, 'ph_1')
  assert.equal(second.code, null)
  assert.equal(second.queue.items.length, 2)
})

test('a video id that is not eleven url-safe characters is refused', async () => {
  const { addItem, createQueue } = await load()

  assert.equal(addItem(createQueue(), { videoId: 'short' }).code, 'E_BAD_VIDEO_ID')
  assert.equal(addItem(createQueue(), { videoId: 'has space!!' }).code, 'E_BAD_VIDEO_ID')
  assert.equal(addItem(createQueue(), { videoId: 'dQw4w9WgXcQ' }).code, null)
})

test('promote moves an item to the front of the priority tier and respects the cap', async () => {
  const { addItem, createQueue, promoteItem } = await load()

  let queue = createQueue()
  queue = addItem(queue, A, 'ph_1').queue
  queue = addItem(queue, B, 'ph_1').queue
  queue = addItem(queue, C, 'ph_1').queue

  const promoted = promoteItem(queue, queue.items[2].id)
  assert.equal(promoted.code, null)
  assert.deepEqual(ids(promoted.queue), ['C', 'A', 'B'])

  // ph_1 already holds one priority; the cap is two, so a second promote works and a
  // third is refused with the cap code.
  const second = promoteItem(promoted.queue, promoted.queue.items.find(i => i.title === 'A').id)
  assert.equal(second.code, null)
  const third = promoteItem(second.queue, second.queue.items.find(i => i.title === 'B').id)
  assert.equal(third.code, 'E_PRIORITY_CAP')
  assert.deepEqual(ids(third.queue), ['C', 'A', 'B'])
})

test('remove and clear report what they could not find', async () => {
  const { addItem, clearQueue, createQueue, removeItem } = await load()

  let queue = addItem(createQueue(), A).queue
  assert.equal(removeItem(queue, 'nope').code, 'E_NOT_FOUND')

  queue = removeItem(queue, queue.items[0].id).queue
  assert.deepEqual(ids(queue), [])

  queue = addItem(queue, A).queue
  assert.deepEqual(ids(clearQueue(queue).queue), [])
})

test('moveItem re-orders, and dropping inside the priority run promotes', async () => {
  const { addItem, createQueue, moveItem } = await load()

  let queue = createQueue()
  queue = addItem(queue, A).queue
  queue = addItem(queue, B).queue
  queue = addItem(queue, C).queue
  queue = addItem(queue, { ...D, priority: true }, 'ph_1').queue

  assert.deepEqual(ids(queue), ['D', 'A', 'B', 'C'])

  // dropped into the leading priority run, so it is promoted
  const promoted = moveItem(queue, queue.items.find(item => item.title === 'C').id, 0)
  assert.equal(promoted.code, null)
  assert.deepEqual(ids(promoted.queue), ['C', 'D', 'A', 'B'])
  assert.equal(promoted.queue.items[0].priority, true)

  // dropped out of the run, so it is demoted and D stays the only priority row
  const demoted = moveItem(promoted.queue, promoted.queue.items[0].id, 3)
  assert.deepEqual(ids(demoted.queue), ['D', 'A', 'B', 'C'])
  assert.equal(demoted.queue.items.every(item => item.priority === (item.title === 'D')), true)

  assert.equal(moveItem(queue, queue.items[0].id, 9).code, 'E_BAD_INDEX')
})

test('pickNext prefers the priority tier in array order', async () => {
  const { addItem, createQueue, pickNext } = await load()

  let queue = createQueue()
  queue = addItem(queue, A).queue
  queue = addItem(queue, { ...B, priority: true }, 'ph_1').queue

  assert.equal(pickNext(queue).title, 'B')
  assert.equal(pickNext(addItem(createQueue(), A).queue).title, 'A')
  assert.equal(pickNext(createQueue()), null)
})

test('playing, completing and going back is an identity', async () => {
  const { addItem, completeCurrent, createQueue, pickNext, previous, startItem } = await load()

  let queue = createQueue()
  queue = addItem(queue, A).queue
  queue = addItem(queue, B).queue
  queue = addItem(queue, C).queue

  const first = startItem(queue, pickNext(queue).id)
  assert.equal(first.code, null)
  assert.equal(first.queue.current.title, 'A')
  assert.deepEqual(ids(first.queue), ['B', 'C'])

  queue = completeCurrent(first.queue).queue
  assert.equal(queue.played.length, 1)

  queue = startItem(queue, pickNext(queue).id).queue
  assert.equal(queue.current.title, 'B')

  const back = previous(queue)
  assert.equal(back.code, null)
  assert.equal(back.queue.current.title, 'A')
  assert.deepEqual(ids(back.queue), ['B', 'C'])
  assert.deepEqual(back.queue.played, [])

  const afterEnd = completeCurrent(back.queue).queue
  const forward = startItem(afterEnd, pickNext(afterEnd).id)
  assert.equal(forward.queue.current.title, 'B')
  assert.deepEqual(ids(forward.queue), ['C'])
})

test('previous with nothing played reports it', async () => {
  const { createQueue, previous } = await load()

  assert.equal(previous(createQueue()).code, 'E_NOT_FOUND')
})

test('the played stack is capped', async () => {
  const { addItem, completeCurrent, createQueue, startItem, PLAYED_LIMIT } = await load()

  let queue = createQueue()
  for (let i = 0; i < PLAYED_LIMIT + 5; i++) {
    queue = addItem(queue, { videoId: `v${String(i).padStart(10, '0')}`, title: `t${i}` }).queue
    queue = startItem(queue, queue.items[0].id).queue
    queue = completeCurrent(queue).queue
  }

  assert.equal(queue.played.length, PLAYED_LIMIT)
})

test('serialization round-trips and refuses another schema', async () => {
  const { addItem, createQueue, deserializeQueue, serializeQueue, setActive } = await load()

  const queue = setActive(addItem(createQueue(), A).queue, true).queue
  const restored = deserializeQueue(serializeQueue(queue))

  assert.equal(restored.active, true)
  assert.equal(restored.items[0].videoId, A.videoId)
  assert.equal(deserializeQueue('not json'), null)
  assert.equal(deserializeQueue(JSON.stringify({ v: 99, items: [] })), null)
  assert.equal(deserializeQueue(null), null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "tests/karaoke-queue.test.cjs"`
Expected: FAIL — `Cannot find module .../src/renderer/helpers/karaoke-queue.js`.

- [ ] **Step 3: Write the reducer**

Create `src/renderer/helpers/karaoke-queue.js`:

```js
// The karaoke queue: pending order, the priority tier, and the played stack.
//
// Pure and immutable — every mutator returns { queue, code } and never touches its
// input, so the Vuex module, the remote agent and the tests all run this one
// implementation. `current` is deliberately NOT part of `items`: the song on screen
// cannot be reordered, removed or dragged by accident.

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
export const PLAYED_LIMIT = 50
export const PRIORITY_CAP = 2

export const CODES = {
  BAD_VIDEO_ID: 'E_BAD_VIDEO_ID',
  DUPLICATE: 'E_DUPLICATE',
  PRIORITY_CAP: 'E_PRIORITY_CAP',
  NOT_FOUND: 'E_NOT_FOUND',
  BAD_INDEX: 'E_BAD_INDEX'
}

const SCHEMA = 1

/** @returns {{filterOn: boolean, minSeconds: number, maxSeconds: number, priorityCap: number}} */
export function defaultSettings() {
  return { filterOn: true, minSeconds: 90, maxSeconds: 720, priorityCap: PRIORITY_CAP }
}

/** @returns {object} a fresh queue */
export function createQueue() {
  return {
    active: false,
    rotation: 'fifo',
    current: null,
    items: [],
    played: [],
    settings: defaultSettings()
  }
}

/**
 * How many leading items are priority items.
 *
 * @param {object[]} items
 * @returns {number}
 */
function priorityRunLength(items) {
  let at = 0
  while (at < items.length && items[at].priority) {
    at += 1
  }
  return at
}

/**
 * @param {object} queue
 * @param {string} requester
 * @returns {number}
 */
export function priorityCount(queue, requester) {
  return queue.items.filter(item => item.priority && item.requester === requester).length
}

/**
 * @param {object} queue
 * @param {object} item
 * @param {string} [requester]
 * @returns {{queue: object, code: string|null}}
 */
export function addItem(queue, item, requester = 'local') {
  const videoId = String(item?.videoId ?? '')

  if (!VIDEO_ID.test(videoId)) {
    return { queue, code: CODES.BAD_VIDEO_ID }
  }

  if (queue.items.some(existing => existing.videoId === videoId)) {
    return { queue, code: CODES.DUPLICATE }
  }

  const entry = {
    id: item.id ?? `k_${videoId}_${queue.items.length}_${Date.now().toString(36)}`,
    videoId,
    title: String(item.title ?? ''),
    channel: String(item.channel ?? ''),
    durationSeconds: Number.isFinite(item.durationSeconds) ? item.durationSeconds : null,
    thumbnail: String(item.thumbnail ?? ''),
    requester: item.requester ?? requester,
    priority: Boolean(item.priority),
    addedAt: Date.now()
  }

  let code = null

  if (entry.priority && priorityCount(queue, entry.requester) >= queue.settings.priorityCap) {
    entry.priority = false
    code = CODES.PRIORITY_CAP
  }

  const items = queue.items.slice()
  items.splice(entry.priority ? priorityRunLength(items) : items.length, 0, entry)

  return { queue: { ...queue, items }, code }
}

/**
 * @param {object} queue
 * @param {string} id
 * @returns {{queue: object, code: string|null}}
 */
export function removeItem(queue, id) {
  if (!queue.items.some(item => item.id === id)) {
    return { queue, code: CODES.NOT_FOUND }
  }

  return { queue: { ...queue, items: queue.items.filter(item => item.id !== id) }, code: null }
}

/**
 * @param {object} queue
 * @returns {{queue: object, code: string|null}}
 */
export function clearQueue(queue) {
  return { queue: { ...queue, items: [], current: null }, code: null }
}

/**
 * @param {object} queue
 * @param {string} id
 * @param {{force?: boolean}} [options]
 * @returns {{queue: object, code: string|null}}
 */
export function promoteItem(queue, id, options = {}) {
  const item = queue.items.find(entry => entry.id === id)

  if (!item) {
    return { queue, code: CODES.NOT_FOUND }
  }

  if (!options.force && priorityCount(queue, item.requester) >= queue.settings.priorityCap) {
    return { queue, code: CODES.PRIORITY_CAP }
  }

  const rest = queue.items.filter(entry => entry.id !== id)
  rest.splice(priorityRunLength(rest), 0, { ...item, priority: true })

  return { queue: { ...queue, items: rest }, code: null }
}

/**
 * @param {object} queue
 * @param {string} id
 * @param {number} toIndex
 * @returns {{queue: object, code: string|null}}
 */
export function moveItem(queue, id, toIndex) {
  const from = queue.items.findIndex(item => item.id === id)

  if (from === -1) {
    return { queue, code: CODES.NOT_FOUND }
  }

  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= queue.items.length) {
    return { queue, code: CODES.BAD_INDEX }
  }

  const rest = queue.items.filter(item => item.id !== id)
  // The tier comes from where the row landed: inside the leading priority run of the
  // rows that stayed put means priority.
  const boundary = priorityRunLength(rest)
  const moved = { ...queue.items[from], priority: toIndex < boundary }
  rest.splice(toIndex, 0, moved)

  return { queue: { ...queue, items: rest }, code: null }
}

/**
 * @param {object} queue
 * @returns {object|null} the item that should play next
 */
export function pickNext(queue) {
  const priority = queue.items.find(item => item.priority)

  return priority ?? queue.items[0] ?? null
}

/**
 * @param {object} queue
 * @param {string} id
 * @returns {{queue: object, code: string|null}}
 */
export function startItem(queue, id) {
  const item = queue.items.find(entry => entry.id === id)

  if (!item) {
    return { queue, code: CODES.NOT_FOUND }
  }

  return {
    queue: { ...queue, current: item, items: queue.items.filter(entry => entry.id !== id) },
    code: null
  }
}

/**
 * @param {object} queue
 * @returns {{queue: object, code: string|null}}
 */
export function completeCurrent(queue) {
  if (!queue.current) {
    return { queue, code: null }
  }

  return {
    queue: { ...queue, current: null, played: [...queue.played, queue.current].slice(-PLAYED_LIMIT) },
    code: null
  }
}

/**
 * @param {object} queue
 * @returns {{queue: object, code: string|null}}
 */
export function previous(queue) {
  const played = queue.played.slice()
  const restored = played.pop()

  if (!restored) {
    return { queue, code: CODES.NOT_FOUND }
  }

  const items = queue.items.slice()

  if (queue.current) {
    // The song that was playing goes back to the front of the normal tier, so
    // prev-then-next lands on the same song again.
    items.splice(priorityRunLength(items), 0, { ...queue.current, priority: false })
  }

  return { queue: { ...queue, current: { ...restored, priority: false }, items, played }, code: null }
}

/**
 * @param {object} queue
 * @param {boolean} active
 * @returns {{queue: object, code: string|null}}
 */
export function setActive(queue, active) {
  return { queue: { ...queue, active: Boolean(active) }, code: null }
}

/**
 * @param {object} queue
 * @param {object} partial
 * @returns {{queue: object, code: string|null}}
 */
export function setSettings(queue, partial) {
  return { queue: { ...queue, settings: { ...queue.settings, ...partial } }, code: null }
}

/**
 * @param {object} queue
 * @returns {string}
 */
export function serializeQueue(queue) {
  return JSON.stringify({
    v: SCHEMA,
    active: queue.active,
    rotation: queue.rotation,
    current: queue.current,
    items: queue.items,
    played: queue.played,
    settings: queue.settings
  })
}

/**
 * @param {string|null|undefined} json
 * @returns {object|null} a queue, or null when the payload is unusable
 */
export function deserializeQueue(json) {
  try {
    const raw = JSON.parse(json)

    if (!raw || raw.v !== SCHEMA) {
      return null
    }

    const { v, ...rest } = raw

    return { ...createQueue(), ...rest, settings: { ...defaultSettings(), ...rest.settings } }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test "tests/karaoke-queue.test.cjs"`
Expected: PASS — 13 tests.

- [ ] **Step 5: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS — 82 tests (64 before, 5 + 13 added).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/helpers/karaoke-queue.js tests/karaoke-queue.test.cjs
git commit -m "feat(karaoke): pure queue reducer with a priority tier and a played stack"
```

---

### Task 3: The karaoke Vuex module

**Files:**
- Create: `src/renderer/store/modules/karaoke.js`
- Modify: `src/renderer/store/index.js` (import + register)
- Test: `tests/karaoke-store.test.cjs`

**Interfaces:**
- Consumes: everything Task 2 produces.
- Produces: default export Vuex module with `state()`, `getters`
  (`getKaraokeActive`, `getKaraokeCurrent`, `getKaraokeUpcoming`, `getKaraokeQueue`,
  `getKaraokeNext`, `getKaraokePriorityCount`), `mutations` (`setKaraokeActive`,
  `setKaraokeQueue`, `setKaraokeSettings`), and actions returning `string|null`:
  `karaokeSetActive(active)`, `karaokeAdd(payload)`, `karaokePromote(id)`, `karaokeRemove(id)`,
  `karaokeClear()`, `karaokeMove({id, toIndex})`, `karaokeStart(id)`, `karaokeComplete()`,
  `karaokePrevious()` (returns the restored item or `null`), `karaokeSetSettings(partial)`;
  plus `KARAOKE_STORAGE_KEY = 'freetube-karaoke'`, `loadPersisted(storage?)`, `persist(queue, storage?)`.

- [ ] **Step 1: Write the failing test**

Create `tests/karaoke-store.test.cjs`:

```js
// tests/karaoke-store.test.cjs
const { afterEach, test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/store/modules/karaoke.js')

function fakeStorage(initial = {}) {
  const data = { ...initial }

  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
    removeItem: key => { delete data[key] },
    dump: () => data
  }
}

/** A stand-in for the Vuex context: state plus a commit that runs the real mutation. */
async function context(module, storage) {
  globalThis.localStorage = storage
  const state = module.default.state()
  const committed = []

  return {
    state,
    committed,
    commit(type, payload) {
      committed.push(type)
      module.default.mutations[type](state, payload)
    }
  }
}

afterEach(() => {
  delete globalThis.localStorage
})

test('a queue add lands in the queue and is persisted', async () => {
  const module = await load()
  const storage = fakeStorage()
  const ctx = await context(module, storage)

  const code = await module.default.actions.karaokeAdd(ctx, {
    videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channel: 'Karaoke', durationSeconds: 213, priority: true
  })

  assert.equal(code, null)
  assert.equal(ctx.state.items.length, 1)
  assert.equal(ctx.state.items[0].priority, true)
  assert.equal(ctx.committed[0], 'setKaraokeQueue')

  const saved = JSON.parse(storage.dump()['freetube-karaoke'])
  assert.equal(saved.items[0].videoId, 'dQw4w9WgXcQ')
})

test('the cap code comes back and the item is stored as normal', async () => {
  const module = await load()
  const ctx = await context(module, fakeStorage())
  const item = (videoId, title) => ({ videoId, title, priority: true, requester: 'ph_1' })

  await module.default.actions.karaokeAdd(ctx, item('aaaaaaaaaaa', 'A'))
  await module.default.actions.karaokeAdd(ctx, item('bbbbbbbbbbb', 'B'))
  const code = await module.default.actions.karaokeAdd(ctx, item('ccccccccccc', 'C'))

  assert.equal(code, 'E_PRIORITY_CAP')
  assert.equal(ctx.state.items.find(entry => entry.title === 'C').priority, false)
})

test('start, complete and previous walk the queue', async () => {
  const module = await load()
  const ctx = await context(module, fakeStorage())
  const actions = module.default.actions

  await actions.karaokeAdd(ctx, { videoId: 'aaaaaaaaaaa', title: 'A' })
  await actions.karaokeAdd(ctx, { videoId: 'bbbbbbbbbbb', title: 'B' })

  const first = ctx.state.items[0].id
  assert.equal(await actions.karaokeStart(ctx, first), null)
  assert.equal(ctx.state.current.title, 'A')
  assert.equal(ctx.state.items.length, 1)

  assert.equal(await actions.karaokeComplete(ctx), null)
  assert.equal(ctx.state.current, null)
  assert.equal(ctx.state.played.length, 1)

  await actions.karaokeStart(ctx, ctx.state.items[0].id)
  const restored = await actions.karaokePrevious(ctx)
  assert.equal(restored.title, 'A')
  assert.equal(ctx.state.current.title, 'A')
  assert.equal(ctx.state.items[0].title, 'B')
})

test('settings and mode are persisted with the queue', async () => {
  const module = await load()
  const storage = fakeStorage()
  const ctx = await context(module, storage)

  assert.equal(await module.default.actions.karaokeSetSettings(ctx, { minSeconds: 120 }), null)
  assert.equal(await module.default.actions.karaokeSetActive(ctx, true), null)

  const saved = JSON.parse(storage.dump()['freetube-karaoke'])
  assert.equal(saved.settings.minSeconds, 120)
  assert.equal(saved.active, true)
})

test('a persisted queue is restored, and a corrupt one is ignored', async () => {
  const module = await load()
  const storage = fakeStorage({ 'freetube-karaoke': 'not json' })

  globalThis.localStorage = storage
  assert.deepEqual(module.default.state().items, [])
  assert.equal(module.default.getters.getKaraokeActive(module.default.state()), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "tests/karaoke-store.test.cjs"`
Expected: FAIL — `Cannot find module .../src/renderer/store/modules/karaoke.js`.

- [ ] **Step 3: Write the module**

Create `src/renderer/store/modules/karaoke.js`:

```js
import {
  addItem,
  clearQueue,
  completeCurrent,
  createQueue,
  deserializeQueue,
  moveItem,
  pickNext,
  previous,
  promoteItem,
  removeItem,
  serializeQueue,
  setActive,
  setSettings,
  startItem
} from '../../helpers/karaoke-queue.js'

// One key, not one per profile: a party queue that disappears because the TV profile
// changed is a worse failure than two profiles sharing it.
export const KARAOKE_STORAGE_KEY = 'freetube-karaoke'

/**
 * @param {Storage} [storage]
 * @returns {object|null}
 */
export function loadPersisted(storage = globalThis.localStorage) {
  try {
    return deserializeQueue(storage?.getItem(KARAOKE_STORAGE_KEY))
  } catch {
    return null
  }
}

/**
 * @param {object} queue
 * @param {Storage} [storage]
 */
export function persist(queue, storage = globalThis.localStorage) {
  try {
    storage?.setItem(KARAOKE_STORAGE_KEY, serializeQueue(queue))
  } catch {
    // Private mode or a full quota: the queue then lives for this session only,
    // which is exactly what happened before persistence existed.
  }
}

/**
 * The queue-shaped slice of the module state, so the pure reducer can be reused
 * without knowing about Vuex.
 *
 * @param {object} state
 * @returns {object}
 */
function snapshot(state) {
  return {
    active: state.active,
    rotation: state.rotation,
    current: state.current,
    items: state.items,
    played: state.played,
    settings: state.settings
  }
}

export default {
  state: () => (loadPersisted() ?? createQueue()),
  getters: {
    getKaraokeActive: state => state.active,
    getKaraokeCurrent: state => state.current,
    getKaraokeUpcoming: state => state.items,
    getKaraokeQueue: state => snapshot(state),
    getKaraokeNext: state => pickNext(state),
    getKaraokePriorityCount: state => state.items.filter(item => item.priority).length
  },
  mutations: {
    /**
     * @param {object} state
     * @param {boolean} active
     */
    setKaraokeActive(state, active) {
      state.active = Boolean(active)
    },
    /**
     * @param {object} state
     * @param {object} queue
     */
    setKaraokeQueue(state, queue) {
      state.active = queue.active
      state.rotation = queue.rotation
      state.current = queue.current
      state.items = queue.items
      state.played = queue.played
      state.settings = queue.settings
    },
    /**
     * @param {object} state
     * @param {object} partial
     */
    setKaraokeSettings(state, partial) {
      state.settings = { ...state.settings, ...partial }
    }
  },
  actions: {
    /**
     * @param {object} context
     * @param {boolean} active
     * @returns {string|null}
     */
    karaokeSetActive({ state, commit }, active) {
      const { queue, code } = setActive(snapshot(state), active)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} a CODES value, or null when the item was queued */
    karaokeAdd({ state, commit }, payload) {
      const { queue, code } = addItem(snapshot(state), payload, payload?.requester ?? 'local')
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokePromote({ state, commit }, payload) {
      const id = typeof payload === 'string' ? payload : payload?.id
      const { queue, code } = promoteItem(snapshot(state), id, { force: payload?.force === true })
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeRemove({ state, commit }, payload) {
      const id = typeof payload === 'string' ? payload : payload?.id
      const { queue, code } = removeItem(snapshot(state), id)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeClear({ state, commit }) {
      const { queue, code } = clearQueue(snapshot(state))
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeMove({ state, commit }, payload) {
      const { queue, code } = moveItem(snapshot(state), payload?.id, payload?.toIndex)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeStart({ state, commit }, payload) {
      const id = typeof payload === 'string' ? payload : payload?.id
      const { queue, code } = startItem(snapshot(state), id)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeComplete({ state, commit }) {
      const { queue, code } = completeCurrent(snapshot(state))
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /**
     * @returns {object|null} the song that is playing again, or null when nothing has played
     */
    karaokePrevious({ state, commit }) {
      const { queue, code } = previous(snapshot(state))

      if (code !== null) {
        return null
      }

      commit('setKaraokeQueue', queue)
      persist(queue)
      return queue.current
    },
    /** @returns {string|null} */
    karaokeSetSettings({ state, commit }, partial) {
      const { queue, code } = setSettings(snapshot(state), partial ?? {})
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    }
  }
}
```

- [ ] **Step 4: Register the module**

In `src/renderer/store/index.js`, add the import after `import history from './modules/history'`:

```js
import karaoke from './modules/karaoke'
```

and add `karaoke,` to the `modules` object (after `history,`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test "tests/karaoke-store.test.cjs"`
Expected: PASS — 5 tests.

Run: `node --test "tests/*.test.cjs"`
Expected: PASS — 87 tests.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/modules/karaoke.js src/renderer/store/index.js tests/karaoke-store.test.cjs
git commit -m "feat(karaoke): karaoke store module with localStorage persistence"
```

---

### Task 4: The queue component

**Files:**
- Create: `src/renderer/components/FtKaraokeQueue/FtKaraokeQueue.vue`
- Create: `src/renderer/components/FtKaraokeQueue/FtKaraokeQueue.css`

**Interfaces:**
- Consumes: the store (Task 3) — `getKaraokeCurrent`, `getKaraokeUpcoming`, `getKaraokePriorityCount`
  and actions `karaokePromote`, `karaokeRemove`, `karaokeClear`, `karaokeStart`.
- Produces: a component with one prop, `compact?: boolean` (default `false`); renders
  `.karaokeQueue` with `.karaokeQueueRow` per pending song (`.isPriority` on priority rows),
  `.karaokeQueueCurrent`, and `.karaokeQueueEmpty`. Emits `play` with the item when the user presses
  play on a queued row.

- [ ] **Step 1: Write the component**

Create `src/renderer/components/FtKaraokeQueue/FtKaraokeQueue.vue`:

```vue
<template>
  <div class="karaokeQueue">
    <div
      v-if="current"
      class="karaokeQueueCurrent"
    >
      <span class="karaokeQueueLabel">{{ t('Karaoke.Now Singing') }}</span>
      <span class="karaokeQueueTitle">{{ current.title }}</span>
    </div>

    <div
      v-if="upcoming.length === 0"
      class="karaokeQueueEmpty"
    >
      {{ t('Karaoke.Queue Empty') }}
    </div>

    <ol
      v-else
      class="karaokeQueueList"
    >
      <li
        v-for="(item, index) in shown"
        :key="item.id"
        class="karaokeQueueRow"
        :class="{ isPriority: item.priority }"
      >
        <span class="karaokeQueuePosition">{{ index + 1 }}</span>
        <span class="karaokeQueueTitle">{{ item.title }}</span>
        <span
          v-if="item.priority"
          class="karaokeQueueBadge"
        >
          {{ t('Karaoke.Priority') }}
        </span>
        <template v-if="!compact">
          <button
            class="karaokeQueueButton"
            type="button"
            @click="play(item)"
          >
            {{ t('Karaoke.Play Now') }}
          </button>
          <button
            class="karaokeQueueButton"
            type="button"
            @click="$store.dispatch('karaokePromote', item.id)"
          >
            {{ t('Karaoke.Play Next') }}
          </button>
          <button
            class="karaokeQueueButton"
            type="button"
            @click="$store.dispatch('karaokeRemove', item.id)"
          >
            {{ t('Karaoke.Remove') }}
          </button>
        </template>
      </li>
    </ol>

    <button
      v-if="!compact && upcoming.length > 0"
      class="karaokeQueueButton clear"
      type="button"
      @click="$store.dispatch('karaokeClear')"
    >
      {{ t('Karaoke.Clear Queue') }}
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStore } from 'vuex'

const props = defineProps({
  compact: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['play'])

const { t } = useI18n()
const store = useStore()

const current = computed(() => store.getters.getKaraokeCurrent)
const upcoming = computed(() => store.getters.getKaraokeUpcoming)
// The bar on the watch page shows what is next, not the whole night.
const shown = computed(() => (props.compact ? upcoming.value.slice(0, 3) : upcoming.value))

/** @param {object} item */
function play(item) {
  emit('play', item)
}
</script>

<style scoped src="./FtKaraokeQueue.css" />
```

- [ ] **Step 2: Write the stylesheet**

Create `src/renderer/components/FtKaraokeQueue/FtKaraokeQueue.css`:

```css
.karaokeQueue {
  inline-size: 100%;
  margin-block-start: 12px;
}

.karaokeQueueCurrent {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding-block: 6px;
}

.karaokeQueueLabel {
  font-size: 12px;
  opacity: 0.7;
  text-transform: uppercase;
}

.karaokeQueueList {
  margin: 0;
  padding-inline-start: 0;
  list-style: none;
}

.karaokeQueueRow {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-block: 6px;
  border-block-end: 1px solid var(--card-bg-color, rgb(0 0 0 / 10%));
}

.karaokeQueueRow.isPriority {
  font-weight: bold;
}

.karaokeQueuePosition {
  min-inline-size: 1.5em;
  opacity: 0.6;
}

.karaokeQueueTitle {
  flex: 1;
}

.karaokeQueueBadge {
  font-size: 11px;
  padding-inline: 6px;
  border-radius: 8px;
  background-color: var(--primary-color, #4054b2);
  color: var(--primary-color-text, #fff);
}

.karaokeQueueButton {
  cursor: pointer;
}

.karaokeQueueEmpty {
  opacity: 0.7;
  padding-block: 8px;
}
```

- [ ] **Step 3: Verify the component compiles**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS — 87 tests (unchanged; `.vue` files are not collected by `node --test`, which is why
the UI check below is the real gate).

Run: `pnpm run lint:style` (or `pnpm exec stylelint "src/renderer/components/FtKaraokeQueue/*.css"`)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/FtKaraokeQueue
git commit -m "feat(karaoke): queue panel component"
```

---

### Task 5: The karaoke route, view and navigation

**Files:**
- Create: `src/renderer/views/Karaoke/Karaoke.vue`
- Create: `src/renderer/views/Karaoke/Karaoke.css`
- Modify: `src/renderer/router/index.js` (import + route after the `/search/:query` route)
- Modify: `src/renderer/components/SideNav/SideNav.vue` (a `/karaoke` router-link)
- Modify: `static/locales/en-US.yaml` (a `Karaoke:` block)

**Interfaces:**
- Consumes: `buildKaraokeQuery`, `filterKaraokeResults`, `videoSeconds`, `needsAnotherPage`
  (Task 1); `FtKaraokeQueue` (Task 4); store actions from Task 3.
- Produces: route name `/karaoke` with `meta.title = 'Karaoke'`; DOM contract used by Task 8's
  verification — `.karaokeSearchInput`, `.karaokeSearchButton`, `.karaokeResult`,
  `.karaokeResultQueue`, `.karaokeResultPriority`, `.karaokeUnfiltered`, `.karaokeMinSeconds`,
  `.karaokeMaxSeconds`, `.karaokeLeave`.

- [ ] **Step 1: Add the locale keys**

Append to `static/locales/en-US.yaml` (top level, two-space indented children):

```yaml
Karaoke:
  Karaoke: Karaoke
  Karaoke Mode: Karaoke Mode
  Search Karaoke: Search karaoke
  Now Singing: Now singing
  Queue: Queue
  Queue Empty: Queue empty
  Add To Queue: Add to queue
  Play Now: Play now
  Play Next: Play next
  Priority: Priority
  Remove: Remove
  Clear Queue: Clear queue
  Leave Karaoke Mode: Leave karaoke mode
  Show Unfiltered Results: Show unfiltered results
  Min Duration: Minimum length (seconds)
  Max Duration: Maximum length (seconds)
  Already Queued: Already in the queue
  Priority Limit Reached: Priority limit reached - added to the normal queue
  Cannot Queue: That video cannot be queued
  No Karaoke Results: No karaoke results - try "Show unfiltered results"
  Karaoke Search Failed: Karaoke search failed
```

- [ ] **Step 2: Write the view**

Create `src/renderer/views/Karaoke/Karaoke.vue`:

```vue
<template>
  <div class="karaoke">
    <h2>
      <FontAwesomeIcon :icon="['fas', 'music']" />
      {{ t('Karaoke.Karaoke Mode') }}
    </h2>

    <div class="karaokeSearchRow">
      <input
        v-model="query"
        class="karaokeSearchInput"
        type="text"
        :placeholder="t('Karaoke.Search Karaoke')"
        @keydown.enter="search"
      >
      <button
        class="karaokeSearchButton"
        type="button"
        @click="search"
      >
        {{ t('Karaoke.Search Karaoke') }}
      </button>
    </div>

    <div class="karaokeOptions">
      <label>
        <input
          v-model="filterOn"
          class="karaokeUnfiltered"
          type="checkbox"
        >
        {{ t('Karaoke.Show Unfiltered Results') }}
      </label>
      <label>
        {{ t('Karaoke.Min Duration') }}
        <input
          v-model.number="minSeconds"
          class="karaokeMinSeconds"
          type="number"
          min="1"
        >
      </label>
      <label>
        {{ t('Karaoke.Max Duration') }}
        <input
          v-model.number="maxSeconds"
          class="karaokeMaxSeconds"
          type="number"
          min="1"
        >
      </label>
      <button
        class="karaokeLeave"
        type="button"
        @click="leave"
      >
        {{ t('Karaoke.Leave Karaoke Mode') }}
      </button>
    </div>

    <FtLoader v-if="isLoading" />

    <p
      v-else-if="results.length === 0 && searched"
      class="karaokeNoResults"
    >
      {{ t('Karaoke.No Karaoke Results') }}
    </p>

    <div
      v-else
      class="karaokeResults"
    >
      <div
        v-for="video in results"
        :key="video.videoId"
        class="karaokeResult"
      >
        <img
          class="karaokeResultThumbnail"
          :src="thumbnailOf(video)"
          alt=""
        >
        <div class="karaokeResultMeta">
          <p class="karaokeResultTitle">
            {{ video.title }}
          </p>
          <p class="karaokeResultChannel">
            {{ video.author ?? video.channelName }}
          </p>
        </div>
        <button
          class="karaokeResultQueue"
          type="button"
          @click="queue(video, false)"
        >
          {{ t('Karaoke.Add To Queue') }}
        </button>
        <button
          class="karaokeResultPriority"
          type="button"
          @click="queue(video, true)"
        >
          {{ t('Karaoke.Play Next') }}
        </button>
      </div>
    </div>

    <FtKaraokeQueue @play="play" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtKaraokeQueue from '../../components/FtKaraokeQueue/FtKaraokeQueue.vue'

import store from '../../store'

import { showToast } from '../../helpers/utils'
import {
  buildKaraokeQuery,
  filterKaraokeResults,
  needsAnotherPage,
  videoSeconds
} from '../../helpers/karaoke.js'
import { getLocalSearchResults } from '../../helpers/api/local'
import { getInvidiousSearchResults } from '../../helpers/api/invidious'

const { t } = useI18n()
const router = useRouter()

const query = ref('')
const results = ref([])
const isLoading = ref(false)
const searched = ref(false)

const backendPreference = computed(() => store.getters.getBackendPreference)
const showFamilyFriendlyOnly = computed(() => store.getters.getShowFamilyFriendlyOnly)
const settings = computed(() => store.state.karaoke.settings)

const filterOn = computed({
  get: () => settings.value.filterOn,
  set: value => store.dispatch('karaokeSetSettings', { filterOn: value })
})

const minSeconds = computed({
  get: () => settings.value.minSeconds,
  set: value => store.dispatch('karaokeSetSettings', { minSeconds: Number(value) || 90 })
})

const maxSeconds = computed({
  get: () => settings.value.maxSeconds,
  set: value => store.dispatch('karaokeSetSettings', { maxSeconds: Number(value) || 720 })
})

/** The filters YouTube itself takes; the karaoke rules are ours, above them. */
function searchSettings() {
  return { prioritize: 'relevance', time: '', type: 'video', duration: '', features: [] }
}

/**
 * @param {object} video
 * @returns {string}
 */
function thumbnailOf(video) {
  return video.videoThumbnails?.[0]?.url ?? video.thumbnail ?? ''
}

async function search() {
  const text = buildKaraokeQuery(query.value)

  if (text === '') {
    return
  }

  isLoading.value = true
  results.value = []
  searched.value = true

  const bounds = { minSeconds: settings.value.minSeconds, maxSeconds: settings.value.maxSeconds }

  try {
    let kept = []
    let page = 1

    while (true) {
      const batch = backendPreference.value === 'local'
        ? (await getLocalSearchResults(text, searchSettings(), showFamilyFriendlyOnly.value)).results
        : await getInvidiousSearchResults(text, page, searchSettings())

      const usable = (batch ?? []).filter(video => video.type === 'video')
      kept = kept.concat(filterOn.value ? filterKaraokeResults(usable, bounds) : usable)

      if (!needsAnotherPage(kept.length, page)) {
        break
      }

      page += 1
    }

    results.value = kept
  } catch (error) {
    console.error(error)
    showToast(t('Karaoke.Karaoke Search Failed'))
  } finally {
    isLoading.value = false
  }
}

/**
 * @param {object} video
 * @param {boolean} priority
 */
async function queue(video, priority) {
  const code = await store.dispatch('karaokeAdd', {
    videoId: video.videoId,
    title: video.title,
    channel: video.author ?? video.channelName ?? '',
    durationSeconds: videoSeconds(video),
    thumbnail: thumbnailOf(video),
    priority
  })

  if (code === 'E_DUPLICATE') {
    showToast(t('Karaoke.Already Queued'))
  } else if (code === 'E_PRIORITY_CAP') {
    showToast(t('Karaoke.Priority Limit Reached'))
  } else if (code !== null) {
    showToast(t('Karaoke.Cannot Queue'))
  }
}

/**
 * @param {object} item
 */
async function play(item) {
  await store.dispatch('karaokeStart', item.id)
  router.push({ path: `/watch/${item.videoId}` })
}

async function leave() {
  await store.dispatch('karaokeSetActive', false)
  router.push({ path: '/' })
}

onMounted(() => {
  store.dispatch('karaokeSetActive', true)
  store.commit('setAppTitle', t('Karaoke.Karaoke'))
})
</script>

<style scoped src="./Karaoke.css" />
```

- [ ] **Step 3: Write the view stylesheet**

Create `src/renderer/views/Karaoke/Karaoke.css`:

```css
.karaoke {
  inline-size: 100%;
}

.karaokeSearchRow {
  display: flex;
  gap: 8px;
  margin-block: 12px;
}

.karaokeSearchInput {
  flex: 1;
}

.karaokeOptions {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  margin-block-end: 12px;
}

.karaokeResult {
  display: flex;
  gap: 12px;
  align-items: center;
  padding-block: 8px;
  border-block-end: 1px solid var(--card-bg-color, rgb(0 0 0 / 10%));
}

.karaokeResultThumbnail {
  inline-size: 120px;
  block-size: auto;
}

.karaokeResultMeta {
  flex: 1;
}

.karaokeResultTitle {
  margin: 0;
  font-weight: bold;
}

.karaokeResultChannel {
  margin: 0;
  font-size: 13px;
  opacity: 0.75;
}
```

- [ ] **Step 4: Add the route**

In `src/renderer/router/index.js`, add next to the other `import SearchPage from ...` lines:

```js
import Karaoke from '../views/Karaoke/Karaoke.vue'
```

and add this entry immediately after the `/search/:query` route object:

```js
    {
      path: '/karaoke',
      meta: {
        title: 'Karaoke'
      },
      component: Karaoke
    },
```

- [ ] **Step 5: Add the side-nav entry**

In `src/renderer/components/SideNav/SideNav.vue`, add after the `/popular` router-link closes:

```vue
      <router-link
        class="navOption mobileHidden"
        role="button"
        to="/karaoke"
        :title="$t('Karaoke.Karaoke')"
      >
        <div
          class="thumbnailContainer"
        >
          <FontAwesomeIcon
            :icon="['fas', 'music']"
            class="navIcon"
            :class="applyNavIconExpand"
          />
        </div>
        <p
          class="navLabel"
        >
          {{ $t("Karaoke.Karaoke") }}
        </p>
      </router-link>
```

- [ ] **Step 6: Verify it builds and renders**

Run: `systemctl --user restart freetube-web` (locale keys are compiled at build time)
Run: `systemctl --user is-active freetube-web && curl -s -o /dev/null -w '%{http_code}\n' http://100.77.173.63:9080/`
Expected: `active`, then `200`.

Then load `http://100.77.173.63:9080/#/karaoke` in a browser (the browser tool in this workspace) and
assert in the console:

```js
document.querySelector('.karaoke') !== null && document.querySelector('.karaokeSearchInput') !== null
```

Expected: `true`, and the page shows the mode heading with no raw `Karaoke.` keys anywhere.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/views/Karaoke src/renderer/router/index.js src/renderer/components/SideNav/SideNav.vue static/locales/en-US.yaml
git commit -m "feat(karaoke): karaoke mode route, search view and side-nav entry"
```

---

### Task 6: Playback wiring in Watch

**Files:**
- Modify: `src/renderer/views/Watch/Watch.js` (`handleVideoEnded` at ~`:1742`, `handleSkipToNext` at
  ~`:1807`, `handleSkipToPrev` at ~`:1819`, plus computed getters)
- Modify: `src/renderer/views/Watch/Watch.vue` (a compact queue bar under the player)

**Interfaces:**
- Consumes: store getters/actions from Task 3, `FtKaraokeQueue` from Task 4.
- Produces: `karaokeOwnsOrder()` (computed), `karaokeAdvance(): Promise<boolean>`,
  `karaokeGoBack(): Promise<boolean>`, `playKaraokeItem(item)` in `Watch.js`; the DOM contract
  `.karaokeQueueBar` on the watch page.

- [ ] **Step 1: Add the getters and methods to Watch.js**

Add to the `computed` block (next to `autoplayEnabled`):

```js
    karaokeActive: function () {
      return this.$store.getters.getKaraokeActive
    },

    karaokeUpcoming: function () {
      return this.$store.getters.getKaraokeUpcoming
    },

    // Karaoke owns the order only while there is something in the queue: an empty
    // queue must not swallow the normal skip buttons.
    karaokeOwnsOrder: function () {
      return this.karaokeActive && (this.karaokeUpcoming.length > 0 || this.$store.getters.getKaraokeCurrent !== null)
    },
```

Add to the `methods` block (above `handleSkipToNext`):

```js
    /**
     * Play a queue item now, marking it current so "next" knows where it was.
     *
     * @param {object} item
     */
    playKaraokeItem: function (item) {
      this.$store.dispatch('karaokeStart', item.id)
      this.$router.push({ path: `/watch/${item.videoId}` })
    },

    /**
     * Move to the next queued song. An empty queue deliberately stops instead of
     * falling back to recommended videos.
     *
     * @returns {Promise<boolean>} whether a song was started
     */
    karaokeAdvance: async function () {
      await this.$store.dispatch('karaokeComplete')

      const next = this.$store.getters.getKaraokeNext

      if (!next) {
        showToast(this.t('Karaoke.Queue Empty'))
        return false
      }

      this.playKaraokeItem(next)
      return true
    },

    /**
     * @returns {Promise<boolean>} whether something was restored
     */
    karaokeGoBack: async function () {
      const restored = await this.$store.dispatch('karaokePrevious')

      if (!restored) {
        showToast(this.t('Karaoke.Queue Empty'))
        return false
      }

      this.$router.push({ path: `/watch/${restored.videoId}` })
      return true
    },
```

Change `handleVideoEnded` so the queue is consulted first, right after the progress save:

```js
    handleVideoEnded: async function () {
      this.handleWatchProgressAutoSaveWhenProgressEnabled()

      if (this.karaokeOwnsOrder && await this.karaokeAdvance()) {
        return
      }

      if (!this.autoplayEnabled) {
        return
      }
```

(everything below that line stays exactly as it is)

Change the first lines of both skip handlers:

```js
    handleSkipToNext: function () {
      if (this.karaokeOwnsOrder) {
        this.karaokeAdvance()
        return
      }

      if (this.watchingPlaylist) {
```

```js
    handleSkipToPrev: function () {
      if (this.karaokeOwnsOrder) {
        this.karaokeGoBack()
        return
      }

      this.$refs.watchVideoPlaylist?.playPreviousVideo()
    },
```

- [ ] **Step 2: Add the bar to Watch.vue**

In `src/renderer/views/Watch/Watch.vue`, immediately after the `<ft-shaka-video-player ... />` element
closes (line ~63), add:

```vue
        <FtKaraokeQueue
          v-if="karaokeActive"
          class="karaokeQueueBar"
          compact
          @play="playKaraokeItem"
        />
```

and add to that file's imports:

```js
import FtKaraokeQueue from '../../components/FtKaraokeQueue/FtKaraokeQueue.vue'
```

- [ ] **Step 3: Verify in the running app**

Run: `systemctl --user restart freetube-web`, then drive the dev server with the browser tool:
open `#/karaoke`, search `bohemian rhapsody`, press `Add to queue` on two results, then open
`#/watch/<first id>` and assert:

```js
document.querySelector('.karaokeQueueBar') !== null
  && document.querySelectorAll('.karaokeQueueBar .karaokeQueueRow').length >= 1
```

Expected: `true`.

Then in the console call the skip path the phone uses and assert the queue moved:

```js
document.querySelector('video').dispatchEvent(new Event('ended'))
```

Expected: within a second the hash becomes the second queued video's `#/watch/<id>`, and the bar's
row count drops by one. Record the observed hash in the task notes.

- [ ] **Step 4: Run the renderer suites**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS — 87 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/views/Watch/Watch.js src/renderer/views/Watch/Watch.vue
git commit -m "feat(karaoke): the queue owns next/prev and auto-advances when a song ends"
```

---

### Task 7: Remote protocol — queue frame and queue commands

**Files:**
- Modify: `src/renderer/remote/agent.js` (frame builder, new commands, options)
- Modify: `src/renderer/remote/index.js` (`registerKaraoke` / `unregisterKaraoke`)
- Modify: `src/renderer/App.vue` (register the karaoke snapshot and the action map)
- Test: `tests/remote-karaoke.test.cjs`

**Interfaces:**
- Consumes: the store (Task 3).
- Produces: `UPCOMING_LIMIT = 20`, `KARAOKE_COMMANDS: Set<string>`,
  `buildQueueFrame(karaoke: object): object` and `queueItemForWire(item)` exported from
  `agent.js`; `createRemoteAgent` gains `getKaraoke?: () => object|null` and
  `getKaraokeActions?: () => object|null`; its returned object gains `publishQueue()`;
  `remote/index.js` exports `registerKaraoke(snapshot, actions)` and `unregisterKaraoke()`.

- [ ] **Step 1: Write the failing test**

Create `tests/remote-karaoke.test.cjs`:

```js
// tests/remote-karaoke.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/remote/agent.js')

function karaokeState(overrides = {}) {
  const item = (id, videoId, title, priority) => ({
    id, videoId, title, channel: 'c', durationSeconds: 200, thumbnail: 't', priority, requester: 'ph_1', addedAt: 1
  })

  return {
    active: true,
    rotation: 'fifo',
    current: item('c1', 'ccccccccccc', 'Current', false),
    items: [item('a1', 'aaaaaaaaaaa', 'Next up', true), item('b1', 'bbbbbbbbbbb', 'Later', false)],
    played: [item('p1', 'ppppppppppp', 'Played', false)],
    settings: { filterOn: true, minSeconds: 90, maxSeconds: 720, priorityCap: 2 },
    ...overrides
  }
}

test('the queue frame carries the current song, the upcoming ones and the counts', async () => {
  const { buildQueueFrame } = await load()

  const frame = buildQueueFrame(karaokeState())

  assert.equal(frame.active, true)
  assert.equal(frame.rotation, 'fifo')
  assert.equal(frame.current.title, 'Current')
  assert.deepEqual(frame.upcoming.map(item => item.title), ['Next up', 'Later'])
  assert.equal(frame.priorityCount, 1)
  assert.equal(frame.playedCount, 1)
})

test('the frame is capped and strips fields the phone has no use for', async () => {
  const { buildQueueFrame, UPCOMING_LIMIT } = await load()

  const items = []
  for (let i = 0; i < UPCOMING_LIMIT + 5; i++) {
    items.push({ id: `i${i}`, videoId: `v${String(i).padStart(10, '0')}`, title: `t${i}`, priority: false, addedAt: i, extra: 'drop me' })
  }

  const frame = buildQueueFrame(karaokeState({ items, current: null }))

  assert.equal(frame.upcoming.length, UPCOMING_LIMIT)
  assert.equal(frame.upcoming[0].title, 't0')
  assert.equal('extra' in frame.upcoming[0], false)
  assert.equal(frame.current, null)
})

test('a queue with no item is still a frame', async () => {
  const { buildQueueFrame } = await load()

  const frame = buildQueueFrame(karaokeState({ items: [], current: null, played: [] }))

  assert.deepEqual(frame.upcoming, [])
  assert.equal(frame.current, null)
  assert.equal(frame.priorityCount, 0)
})

test('queue commands reach the karaoke actions and a missing handler is refused', async () => {
  const { applyKaraokeCommand } = await load()

  const seen = []
  const actions = {
    queueAdd: message => {
      seen.push(message)
      return 'E_DUPLICATE'
    },
    queueClear: () => null
  }

  assert.equal(await applyKaraokeCommand({ cmd: 'queueAdd', videoId: 'aaaaaaaaaaa' }, () => actions), 'E_DUPLICATE')
  assert.equal(seen[0].videoId, 'aaaaaaaaaaa')
  assert.equal(await applyKaraokeCommand({ cmd: 'queueClear' }, () => actions), null)
  assert.equal(await applyKaraokeCommand({ cmd: 'queueClear' }, () => null), 'E_NO_KARAOKE')
  assert.equal(await applyKaraokeCommand({ cmd: 'notAKaraokeCommand' }, () => actions), 'E_UNKNOWN_CMD')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "tests/remote-karaoke.test.cjs"`
Expected: FAIL — `buildQueueFrame` is not exported / `applyKaraokeCommand` is undefined.

- [ ] **Step 3: Add the frame builder and command dispatcher to agent.js**

In `src/renderer/remote/agent.js`, after `buildState`, add:

```js
export const UPCOMING_LIMIT = 20

export const KARAOKE_COMMANDS = new Set([
  'karaokeSet',
  'queueAdd',
  'queuePromote',
  'queueRemove',
  'queueClear',
  'queueMove'
])

/**
 * The fields a phone screen actually needs — a queue frame rides every queue change,
 * so search-only metadata is dropped on the way out.
 *
 * @param {object} item
 * @returns {object}
 */
export function queueItemForWire(item) {
  return {
    id: item.id,
    videoId: item.videoId,
    title: item.title,
    channel: item.channel,
    durationSeconds: item.durationSeconds,
    thumbnail: item.thumbnail,
    priority: Boolean(item.priority),
    requester: item.requester
  }
}

/**
 * @param {object|null} karaoke the store's karaoke state
 * @returns {object|null}
 */
export function buildQueueFrame(karaoke) {
  if (!karaoke) return null

  const items = Array.isArray(karaoke.items) ? karaoke.items : []

  return {
    active: Boolean(karaoke.active),
    rotation: karaoke.rotation ?? 'fifo',
    current: karaoke.current ? queueItemForWire(karaoke.current) : null,
    upcoming: items.slice(0, UPCOMING_LIMIT).map(queueItemForWire),
    priorityCount: items.filter(item => item.priority).length,
    playedCount: Array.isArray(karaoke.played) ? karaoke.played.length : 0
  }
}

/**
 * @param {{cmd: string, [key: string]: any}} command
 * @param {() => object|null} getKaraokeActions
 * @returns {Promise<string|null>} an error code, or null when the command was applied
 */
export async function applyKaraokeCommand(command, getKaraokeActions) {
  if (!KARAOKE_COMMANDS.has(command.cmd)) return 'E_UNKNOWN_CMD'

  const action = getKaraokeActions?.()?.[command.cmd]

  if (typeof action !== 'function') return 'E_NO_KARAOKE'

  const result = await action(command)

  return typeof result === 'string' ? result : null
}
```

- [ ] **Step 4: Wire the options and the queue frame into the agent**

In `createRemoteAgent`'s destructured options, after `getActions = () => null,` add:

```js
    getKaraoke = () => null,
    getKaraokeActions = () => null,
```

Replace `publish` with:

```js
  function publish() {
    const video = getVideo()
    if (video) {
      const karaoke = getKaraoke()
      send({
        t: 'state',
        state: { ...buildState(getMeta(), video, now()), karaokeActive: Boolean(karaoke?.active) }
      })
    }
  }

  function publishQueue() {
    const frame = buildQueueFrame(getKaraoke())
    if (frame) send({ t: 'queue', karaoke: frame })
  }
```

In `onCommand`, before the `const video = getVideo()` line, add:

```js
    if (KARAOKE_COMMANDS.has(message.cmd)) {
      const code = await applyKaraokeCommand(message, getKaraokeActions)
      send({ t: 'ack', id: message.id, ok: code === null, ...(code ? { code } : {}) })
      publishQueue()
      publish()
      return
    }
```

In `next.onopen`, after `publish()` add `publishQueue()`, and expose it:

```js
    publish,
    publishQueue,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test "tests/remote-karaoke.test.cjs"`
Expected: PASS — 4 tests.

Run: `node --test "tests/*.test.cjs"`
Expected: PASS — 91 tests. (`tests/remote-agent.test.cjs` builds its own state objects through
`buildState`, so the added `karaokeActive` key does not touch it; if it does fail, the assertion is
about the state frame's shape and `karaokeActive` belongs in it — update that assertion.)

- [ ] **Step 6: Register the snapshot and the actions in remote/index.js**

In `src/renderer/remote/index.js`, add near the other module-level refs:

```js
let karaokeRef = null
let karaokeActionsRef = null
```

add:

```js
export function registerKaraoke(snapshot, actions) {
  karaokeRef = snapshot
  karaokeActionsRef = actions
  agent?.publishQueue()
}

export function unregisterKaraoke() {
  karaokeRef = null
  karaokeActionsRef = null
}
```

and pass both into `createRemoteAgent` (after `getActions: () => actionsRef,`):

```js
    getKaraoke: () => karaokeRef,
    getKaraokeActions: () => karaokeActionsRef,
```

- [ ] **Step 7: Register from App.vue**

In `src/renderer/App.vue`, extend the remote import:

```js
import {
  registerKaraoke,
  start as startRemoteControl,
  stop as stopRemoteControl
} from './remote/index.js'
```

and add, next to the existing `onMounted` block:

```js
/** The handlers a paired phone's queue commands land on. Each returns a code or null. */
const karaokeActions = {
  karaokeSet: payload => store.dispatch('karaokeSetActive', Boolean(payload?.active)),
  queueAdd: payload => store.dispatch('karaokeAdd', payload),
  queuePromote: payload => store.dispatch('karaokePromote', payload?.id),
  queueRemove: payload => store.dispatch('karaokeRemove', payload?.id),
  queueClear: () => store.dispatch('karaokeClear'),
  queueMove: payload => store.dispatch('karaokeMove', { id: payload?.id, toIndex: payload?.toIndex })
}

watch(() => store.state.karaoke, karaoke => registerKaraoke(karaoke, karaokeActions), { deep: true, immediate: true })
```

- [ ] **Step 8: Verify against the running dev server**

Run: `systemctl --user restart freetube-web`, open `#/karaoke` in the browser tool, queue one song,
then in the console assert the frame the agent would send:

```js
import('/web.js').then(() => null).catch(() => null)
```

is not needed — instead read the store directly:

```js
JSON.stringify(store.state.karaoke.items.map(i => i.title))
```

Expected: the queued title. Then confirm no console errors mentioning `karaoke` appear in the dev
server log: `journalctl --user -u freetube-web -n 50 | grep -i karaoke`.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/remote/agent.js src/renderer/remote/index.js src/renderer/App.vue tests/remote-karaoke.test.cjs
git commit -m "feat(karaoke): the remote publishes the queue frame and accepts queue commands"
```

---

### Task 8: Bridge — phone identity on commands and queue relay

**Files:**
- Modify: `../freetube-remote/app/rooms.py` (`lookup_phone`, `queue`, `set_queue`)
- Modify: `../freetube-remote/app/hub.py` (`from` stamp, `queue` relay, `queue` in hello)
- Test: `../freetube-remote/tests/test_rooms.py`, `../freetube-remote/tests/test_hub.py`

**Interfaces:**
- Consumes: nothing from the renderer; the wire shapes from the spec's §10.
- Produces: `Rooms.lookup_phone(token) -> tuple[str, str] | None`,
  `Rooms.queue(player_id) -> dict | None`, `Rooms.set_queue(player_id, karaoke) -> None`;
  `Hub.session` auth now passes the phone id into `Hub.phone(player_id, ws, phone_id)`;
  relayed commands carry `from`.

- [ ] **Step 1: Write the failing rooms test**

Append to `tests/test_rooms.py`:

```python
def test_a_phone_id_lookup_returns_the_player_and_the_phone(tmp_path):
    rooms = make_rooms(tmp_path)
    player_id = rooms.register_player("k")
    _, token = rooms.claim(rooms.open_pairing(player_id))

    assert rooms.lookup_phone(token) == (player_id, next(iter(rooms.data["players"][player_id]["phones"])))
    assert rooms.lookup_phone("nope") is None


def test_a_queue_is_cached_in_memory_and_never_written_to_disk(tmp_path):
    rooms = make_rooms(tmp_path)
    player_id = rooms.register_player("k")
    karaoke = {"active": True, "upcoming": [{"videoId": "aaaaaaaaaaa"}], "priorityCount": 0}

    rooms.set_queue(player_id, karaoke)

    assert rooms.queue(player_id) == karaoke
    assert "aaaaaaaaaaa" not in (tmp_path / "state.json").read_text()
    assert make_rooms(tmp_path).queue(player_id) is None
```

- [ ] **Step 2: Run the rooms tests to verify they fail**

Run: `cd ~/developer/freetube-remote && uv run pytest tests/test_rooms.py -q`
Expected: FAIL — `AttributeError: 'Rooms' object has no attribute 'lookup_phone'`.

- [ ] **Step 3: Implement the rooms changes**

In `app/rooms.py`, add `self.queues: dict[str, dict] = {}` next to `self.states`, and replace
`lookup_token` with:

```python
    def lookup_phone(self, token: str) -> tuple[str, str] | None:
        """The player and the phone a token belongs to, or None.

        The phone id is the identity every relayed command carries: it is stable for
        the life of a pairing and reveals nothing about the token.
        """
        if not token:
            return None
        token_hash = _hash(token)
        for player_id, player in self.data["players"].items():
            for phone_id, phone in player["phones"].items():
                if secrets.compare_digest(phone["tokenHash"], token_hash):
                    return player_id, phone_id
        return None

    def lookup_token(self, token: str) -> str | None:
        found = self.lookup_phone(token)
        return found[0] if found else None

    def queue(self, player_id: str) -> dict | None:
        return self.queues.get(player_id)

    def set_queue(self, player_id: str, karaoke: dict | None) -> None:
        self.queues[player_id] = karaoke
```

- [ ] **Step 4: Run the rooms tests to verify they pass**

Run: `cd ~/developer/freetube-remote && uv run pytest tests/test_rooms.py -q`
Expected: PASS — 8 tests.

- [ ] **Step 5: Write the failing hub tests**

Append to `tests/test_hub.py`:

```python
def test_a_relayed_command_carries_the_sending_phones_id(tmp_path):
    rooms, hub = make(tmp_path)
    player_id = rooms.register_player("k1")
    _, token = rooms.claim(rooms.open_pairing(player_id))
    phone_id = next(iter(rooms.data["players"][player_id]["phones"]))

    async def scenario():
        player, phone = FakeWS(), FakeWS()
        player.push(auth_player("k1"))
        phone.push({"t": "auth", "role": "phone", "token": token})
        player_task = asyncio.create_task(hub.session(player))
        phone_task = asyncio.create_task(hub.session(phone))
        await until(lambda: player.sent and phone.sent)

        phone.push({"t": "cmd", "cmd": "queueAdd", "videoId": "aaaaaaaaaaa"})
        await until(lambda: any(m.get("cmd") == "queueAdd" for m in player.sent))
        forwarded = [m for m in player.sent if m.get("cmd") == "queueAdd"][0]
        assert forwarded["from"] == phone_id
        assert token not in json.dumps(forwarded)

        player.stop()
        phone.stop()
        await asyncio.gather(player_task, phone_task)

    asyncio.run(scenario())


def test_a_queue_frame_from_the_player_reaches_the_phone_and_the_next_hello(tmp_path):
    rooms, hub = make(tmp_path)
    player_id = rooms.register_player("k1")
    _, token = rooms.claim(rooms.open_pairing(player_id))
    karaoke = {"active": True, "upcoming": [{"videoId": "aaaaaaaaaaa"}], "priorityCount": 1}

    async def scenario():
        player, phone = FakeWS(), FakeWS()
        player.push(auth_player("k1"))
        phone.push({"t": "auth", "role": "phone", "token": token})
        player_task = asyncio.create_task(hub.session(player))
        phone_task = asyncio.create_task(hub.session(phone))
        await until(lambda: player.sent and phone.sent)

        player.push({"t": "queue", "karaoke": karaoke})
        await until(lambda: any(m.get("t") == "queue" for m in phone.sent))
        assert [m for m in phone.sent if m.get("t") == "queue"][0] == {"t": "queue", "karaoke": karaoke}

        # a phone that connects later gets the queue in its hello
        late = FakeWS()
        late.push({"t": "auth", "role": "phone", "token": token})
        late.stop()
        await hub.session(late)
        assert late.sent[0]["queue"] == karaoke

        player.stop()
        phone.stop()
        await asyncio.gather(player_task, phone_task)

    asyncio.run(scenario())
```

Add `import json` to the imports at the top of `tests/test_hub.py`.

- [ ] **Step 6: Run the hub tests to verify they fail**

Run: `cd ~/developer/freetube-remote && uv run pytest tests/test_hub.py -q`
Expected: FAIL — `KeyError: 'from'` / no `queue` frame.

- [ ] **Step 7: Implement the hub changes**

In `app/hub.py`:

- `session()`: replace the phone branch with

```python
        elif role == "phone":
            found = self.rooms.lookup_phone(str(first.get("token") or ""))
            if found is None:
                await ws.close(code=4403)
                return
            await self.phone(found[0], ws, found[1])
```

- `phone()`: change the signature to
  `async def phone(self, player_id: str, ws: WebSocket, phone_id: str | None = None) -> None:`
  and add `"queue": self.rooms.queue(player_id),` to the hello payload.
- `phone()`: stamp the sender on the relayed command:

```python
                await target.send_json(
                    {"t": "cmd", "id": command_id, "from": phone_id,
                     **{k: v for k, v in message.items() if k != "t"}}
                )
```

- `player()`: handle the new frame inside the receive loop, next to the `state` branch:

```python
                elif kind == "queue":
                    self.rooms.set_queue(player_id, message.get("karaoke"))
                    await self._to_phones(
                        player_id, {"t": "queue", "karaoke": message.get("karaoke")}
                    )
```

- [ ] **Step 8: Run the bridge suites to verify they pass**

Run: `cd ~/developer/freetube-remote && uv run pytest tests -q`
Expected: PASS — 42 tests.

Run: `cd ~/developer/freetube-remote && node --test "tests-web/*.test.mjs"`
Expected: PASS — 3 tests (the phone client is unchanged in P1).

- [ ] **Step 9: Commit**

```bash
cd ~/developer/freetube-remote
git add app/rooms.py app/hub.py tests/test_rooms.py tests/test_hub.py
git commit -m "feat(karaoke): stamp the sending phone on relayed commands and relay the queue frame"
```

---

### Task 9: End-to-end evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-11-10-karaoke-night-design.md` (mark P1 status + measured
  evidence, in the style of the remote spec's "Status" line)

**Interfaces:**
- Consumes: everything above.
- Produces: measured evidence in the spec; no new code.

- [ ] **Step 1: Full suites**

```bash
cd ~/developer/freetube && node --test "tests/*.test.cjs"
cd ~/developer/freetube-remote && uv run pytest tests -q && node --test "tests-web/*.test.mjs"
```

Expected: renderer 91 pass, bridge 42 pass, phone 3 pass. Record the numbers.

- [ ] **Step 2: Real playback, packaged build**

```bash
cd ~/developer/freetube && pnpm run pack
xvfb-run -a ./node_modules/.bin/electron . --no-sandbox --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/home/joefox/.hermes/cache/scratch/karaoke-p1
```

Drive `ws://127.0.0.1:9222/devtools/page/<id>` (the bridge venv has `websockets`) to: enable karaoke
mode from the side nav, queue two songs from a real search, let the first finish, and confirm the
second starts on its own (`readyState 4` on a real stream). Record the two video ids and the time
between end and start.

- [ ] **Step 3: Queue survives a reload**

In the dev-server page: queue two songs, reload, then assert

```js
JSON.parse(localStorage.getItem('freetube-karaoke')).items.length
```

Expected: `2`.

- [ ] **Step 4: Phone side over the funnel**

```bash
curl -s https://nextcloud.taild1347f.ts.net:10000/remote/health
```

Expected: a healthy payload. The phone UI itself is P2; in P1 the evidence is the bridge suites plus
a paired phone seeing `t:'queue'` frames — if a phone is available, pair it and watch the frame
arrive in its console.

- [ ] **Step 5: Update the spec and commit**

Add to the spec's header:

```markdown
**Status:** P1 BUILT — `<commit>`; renderer `<n>` tests, bridge `<n>` + `<n>`; evidence in the
plan's Task 9.
```

```bash
git add docs/superpowers/specs/2026-11-10-karaoke-night-design.md
git commit -m "docs(karaoke): P1 status and measured evidence"
```

---

## Self-review notes (kept in the plan on purpose)

- Spec coverage: §1 (mode/route/nav) → Tasks 3–5; §2 (karaoke search) → Task 1, used in Task 5;
  §3 (queue, priority, cap, persistence) → Tasks 2–3; §7 (playback wiring) → Task 6; §10 (protocol)
  → Tasks 7–8; §11 (storage) → Task 3. §4–§6, §8, §9 are P2–P6 and deliberately absent.
- Type consistency: `{ queue, code }` is the only mutator return shape; `code` is a `CODES` value or
  `null` everywhere (store actions included); `items` never contains `current`; `played` holds item
  snapshots.
- Names used across tasks that must not drift: `karaokeAdd`, `karaokeStart`, `karaokeComplete`,
  `karaokePrevious`, `karaokeSetActive`, `getKaraokeNext`, `FtKaraokeQueue` (prop `compact`),
  `buildQueueFrame`, `applyKaraokeCommand`, `registerKaraoke`, `Rooms.lookup_phone`,
  `freetube-karaoke`.
