# Karaoke Night P2 — singers and rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a karaoke party named singers — a persistent roster, phones that claim a name, fair
`round_robin` rotation, per-singer priority fairness, and host powers on the TV.

**Architecture:** A pure roster helper holds every rule (claim, rename, release, host, colours,
stats); a new `karaoke.db` nedb datastore persists it per profile because a roster is a record, not
churn. The queue reducer stays pure and gains a rotation-aware `pickNext` plus the singer the
current song belonged to. Identity already arrives from the bridge as `from` (P1); P2 binds that
phone id to a roster row, and from then on the item's `singerId` — not the phone id — is what the
priority cap and the display use.

**Tech Stack:** Vue 3 + Vuex (renderer), `@seald-io/nedb` datastores, `node:test` suites, the Flask
bridge (`~/developer/freetube-remote`) and its plain-JS phone PWA.

**Spec:** `docs/superpowers/specs/2026-11-10-karaoke-night-design.md` — §4 (singers, rotation,
identity on the wire), §3 (the cap's requester), §10 (protocol), §11 (storage), §12 (surfaces),
Stages → P2. The spec is the binding authority; if this plan and the spec disagree, the spec wins
and the disagreement is a ruling for the controller.

## Global Constraints

- **P1 is merged.** `freetube-remote` @ `3a09b7886` already has karaoke mode, the queue reducer,
  the store, the `/karaoke` view, the Watch wiring, the remote surface and the `from` stamp.
  Branch `karaoke-night-p2` off `freetube-remote` (renderer) and off `master` (bridge, `33f9257`).
- Work in-place on the branches, not in a worktree: `freetube-web.service` serves these exact paths
  on :9080 and `freetube-remote.service` on 127.0.0.1:9098, and several steps verify against them.
- **No new dependencies.** The roster store uses the existing nedb datastores; the TV drag-free
  strip uses plain Vue; the phone uses plain JS.
- **Never `git commit --no-verify`.** When a hook rejects a construct, change the construct:
  `String.prototype.replaceAll` instead of `replace` with a global regex (`unicorn/prefer-string-replace-all`),
  nested `@param context.state` / `@param context.commit` instead of one `@param context`
  (`jsdoc/check-param-names`). The pre-commit eslint glob is `*.{js,vue}`, so `.cjs` test files are
  not linted — their `Parsing error: Unexpected token import` is pre-existing noise.
- **Suites must stay green:** renderer `node --test "tests/*.test.cjs"` = **99 pass / 0 fail**;
  bridge `uv run pytest tests -q` = **43 passed**; phone `node --test "tests-web/*.test.mjs"` = **3 pass**.
  Every brief's arithmetic predates the branch — trust the live run, not a number in this plan.
- **The wire rules from P1 hold.** The bridge owns the envelope keys `t`/`cmd`/`from`/`id`;
  `from` is the phone's opaque room id and is the only identity a command may carry into the store;
  a row target travels as `itemId`; the queue rides its own `{t:'queue', karaoke:{...}}` frame and
  **never** the 1 s state frame (the renderer asserts the state frame's exact key set).
- **Identity precedence (the P2 rule):** an item's `requester` — the key the priority cap counts —
  is `singerId` when the sending phone has claimed a singer, else the bridge's `from`, else
  `'local'`. A phone must never be able to name a singer it has not claimed.
- **Locale keys** live in `static/locales/en-US.yaml` under the existing `Karaoke:` block; a new key
  needs `systemctl --user restart freetube-web` before it renders.
- **Verification honesty:** the controller owns the browser, the live bridge and the packaged
  Electron app. An implementer never claims a DOM, pairing or playback check it did not run.

---

### Task 1: The roster's rules, as a pure helper

Every singer decision lives here so the UI, the store and the tests share one implementation.
Nothing in this file touches Vuex, the datastore or the DOM.

**Files:**
- Create: `src/renderer/helpers/karaoke-roster.js`
- Test: `tests/karaoke-roster.test.cjs`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (all used by Tasks 4–7):
  - `SINGER_COLORS` — the palette array of 8 CSS colours.
  - `HOST_DEFAULT_NAME = 'Host'`.
  - `createRoster()` → `[]`
  - `normalizeName(name)` → `string` (trimmed, collapsed whitespace, max 24 chars)
  - `findByName(roster, name)` → singer | null (case-insensitive)
  - `findByPhone(roster, phoneId)` → singer | null
  - `claimSinger(roster, { name, phoneId })` → `{ roster, singer, code }`
    codes: `null` | `E_NAME_TAKEN` | `E_BAD_NAME` | `E_NO_PHONE` | `E_ALREADY_CLAIMED`
    (a phone that already holds a row gets that row back with `E_ALREADY_CLAIMED`, so one device
    cannot hold two names and vote twice)
  - `renameSinger(roster, { singerId, name })` → `{ roster, code }`
  - `releaseSinger(roster, { singerId })` → `{ roster, code }` (clears `phoneId`, keeps the row)
  - `setSingerActive(roster, { singerId, active })` → `{ roster, code }`
  - `setHost(roster, { singerId })` → `{ roster, code }` (exactly one `host: true`)
  - `nextColor(roster)` → `string`
  - `recordSong(roster, { singerId, score })` → `{ roster, code }` (stats: `songsSung`,
    `totalScore`, `bestScore`, `votesCast` untouched)
  - `nextSingerId(roster, { lastSingerId, pendingSingerIds })` → `string|null`
    (roster order, one step past `lastSingerId`, skipping singers with nothing pending;
    `pendingSingerIds` are the singerIds that still have a queued song)

- [ ] **Step 1: Write the failing tests**

Create `tests/karaoke-roster.test.cjs`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createRoster, normalizeName, findByName, findByPhone, claimSinger, renameSinger,
  releaseSinger, setSingerActive, setHost, recordSong, nextSingerId, SINGER_COLORS
} = require('../src/renderer/helpers/karaoke-roster.js')

test('the first claimed name becomes the host', () => {
  const { roster, singer, code } = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })

  assert.equal(code, null)
  assert.equal(singer.name, 'Ada')
  assert.equal(singer.host, true)
  assert.equal(singer.source, 'phone')
  assert.equal(singer.phoneId, 'ph_a')
  assert.equal(roster.length, 1)
})

test('a second claim is not the host and gets the next colour', () => {
  const first = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const second = claimSinger(first.roster, { name: 'Grace', phoneId: 'ph_b' })

  assert.equal(second.singer.host, false)
  assert.equal(second.singer.color, SINGER_COLORS[1])
})

test('names are trimmed, whitespace-collapsed and case-insensitively unique', () => {
  const first = claimSinger(createRoster(), { name: '  Ada   Lovelace ', phoneId: 'ph_a' })

  assert.equal(first.singer.name, 'Ada Lovelace')
  assert.equal(claimSinger(first.roster, { name: 'ada lovelace', phoneId: 'ph_b' }).code, 'E_NAME_TAKEN')
  assert.equal(findByName(first.roster, 'ADA LOVELACE').id, first.singer.id)
})

test('a claim needs a name and a phone id', () => {
  assert.equal(claimSinger(createRoster(), { name: '   ', phoneId: 'ph_a' }).code, 'E_BAD_NAME')
  assert.equal(claimSinger(createRoster(), { name: 'Ada' }).code, 'E_NO_PHONE')
})

test('name normalization caps the length at 24 characters', () => {
  assert.equal(normalizeName('x'.repeat(40)).length, 24)
})

test('a phone that already claimed keeps its row and cannot claim a second', () => {
  const first = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const again = claimSinger(first.roster, { name: 'Grace', phoneId: 'ph_a' })

  assert.equal(again.code, 'E_ALREADY_CLAIMED')
  assert.equal(again.roster.length, 1)
  assert.equal(findByPhone(again.roster, 'ph_a').name, 'Ada')
})

test('renaming is refused onto a name another singer holds, and allowed onto your own', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })

  assert.equal(renameSinger(grace.roster, { singerId: grace.singer.id, name: 'Ada' }).code, 'E_NAME_TAKEN')
  assert.equal(renameSinger(grace.roster, { singerId: grace.singer.id, name: 'Grace' }).code, null)

  const renamed = renameSinger(grace.roster, { singerId: grace.singer.id, name: 'Grace Hopper' })
  assert.equal(findByPhone(renamed.roster, 'ph_b').name, 'Grace Hopper')
})

test('releasing a name keeps the row but frees the phone', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const released = releaseSinger(ada.roster, { singerId: ada.singer.id })

  assert.equal(released.code, null)
  assert.equal(released.roster.length, 1)
  assert.equal(findByPhone(released.roster, 'ph_a'), null)
  assert.equal(released.roster[0].active, true)
})

test('a released name can be claimed by another phone', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const released = releaseSinger(ada.roster, { singerId: ada.singer.id })
  const taken = claimSinger(released.roster, { name: 'Ada', phoneId: 'ph_b' })

  assert.equal(taken.code, null)
  assert.equal(taken.roster.length, 1)
  assert.equal(taken.singer.phoneId, 'ph_b')
})

test('exactly one singer is the host at a time', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  const moved = setHost(grace.roster, { singerId: grace.singer.id })

  assert.equal(moved.roster.filter(singer => singer.host).length, 1)
  assert.equal(findByPhone(moved.roster, 'ph_b').host, true)
  assert.equal(findByPhone(moved.roster, 'ph_a').host, false)
})

test('a claim is refused when another singer already holds the host, and setHost moves it', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })

  assert.equal(grace.singer.host, false)
  assert.equal(grace.roster.filter(singer => singer.host).map(singer => singer.name).join(), 'Ada')
})

test('setHost on an unknown singer is refused', () => {
  assert.equal(setHost(createRoster(), { singerId: 's_nope' }).code, 'E_NOT_FOUND')
})

test('recording a song keeps the best score and totals', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const once = recordSong(ada.roster, { singerId: ada.singer.id, score: 70 })
  const twice = recordSong(once.roster, { singerId: ada.singer.id, score: 55 })

  assert.equal(twice.roster[0].stats.songsSung, 2)
  assert.equal(twice.roster[0].stats.totalScore, 125)
  assert.equal(twice.roster[0].stats.bestScore, 70)
})

test('rotation steps one singer past the last one, skipping singers with nothing pending', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  const linus = claimSinger(grace.roster, { name: 'Linus', phoneId: 'ph_c' })
  const roster = linus.roster
  const [a, g, l] = roster

  const everyone = [a.id, g.id, l.id]
  assert.equal(nextSingerId(roster, { lastSingerId: null, pendingSingerIds: everyone }), a.id)
  assert.equal(nextSingerId(roster, { lastSingerId: a.id, pendingSingerIds: everyone }), g.id)
  assert.equal(nextSingerId(roster, { lastSingerId: g.id, pendingSingerIds: everyone }), l.id)
  assert.equal(nextSingerId(roster, { lastSingerId: l.id, pendingSingerIds: everyone }), a.id)

  assert.equal(nextSingerId(roster, { lastSingerId: a.id, pendingSingerIds: [l.id] }), l.id)
  assert.equal(nextSingerId(roster, { lastSingerId: l.id, pendingSingerIds: [a.id] }), a.id)
})

test('rotation returns null when nobody has a pending song', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })

  assert.equal(nextSingerId(ada.roster, { lastSingerId: null, pendingSingerIds: [] }), null)
})

test('rotation ignores singers that are switched off', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  const off = setSingerActive(grace.roster, { singerId: grace.singer.id, active: false })
  const [a, g] = off.roster

  assert.equal(nextSingerId(off.roster, { lastSingerId: null, pendingSingerIds: [a.id, g.id] }), a.id)
  assert.equal(nextSingerId(off.roster, { lastSingerId: a.id, pendingSingerIds: [g.id] }), null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/karaoke-roster.test.cjs`
Expected: FAIL — `Cannot find module '../src/renderer/helpers/karaoke-roster.js'`

- [ ] **Step 3: Write the helper**

Create `src/renderer/helpers/karaoke-roster.js`:

```js
// The roster's rules, in one pure place: claim, rename, release, host, colours, stats, rotation
// order. No Vuex, no datastore, no DOM — the store module, the TV strip and the phone PWA all call
// these, and so do the tests.

export const SINGER_COLORS = [
  '#e4572e', '#17bebb', '#ffc914', '#2e86ab',
  '#a23b72', '#76b041', '#f18f01', '#4d4dff'
]

export const NAME_MAX = 24

/**
 * @param {string} name
 * @returns {string} trimmed, whitespace-collapsed, length-capped
 */
export function normalizeName(name) {
  return String(name ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

/** @returns {object[]} a fresh, empty roster */
export function createRoster() {
  return []
}

/**
 * @param {object[]} roster
 * @param {string} name
 * @returns {object|null}
 */
export function findByName(roster, name) {
  const wanted = normalizeName(name).toLowerCase()
  return roster.find(singer => singer.name.toLowerCase() === wanted) ?? null
}

/**
 * @param {object[]} roster
 * @param {string} phoneId
 * @returns {object|null}
 */
export function findByPhone(roster, phoneId) {
  if (!phoneId) return null
  return roster.find(singer => singer.phoneId === phoneId) ?? null
}

/**
 * @param {object[]} roster
 * @returns {string} the next colour in the palette, cycling
 */
export function nextColor(roster) {
  return SINGER_COLORS[roster.length % SINGER_COLORS.length]
}

/**
 * Claim a roster row for a phone. A phone that already holds a row is refused: identity is the
 * roster row, and a second row per phone would let one device vote or queue twice.
 *
 * @param {object[]} roster
 * @param {{name: string, phoneId?: string, source?: string}} payload
 * @returns {{roster: object[], singer: object|null, code: string|null}}
 */
export function claimSinger(roster, payload) {
  const name = normalizeName(payload?.name)
  const phoneId = payload?.phoneId ?? null

  if (name.length === 0) {
    return { roster, singer: null, code: 'E_BAD_NAME' }
  }

  if (!phoneId) {
    return { roster, singer: null, code: 'E_NO_PHONE' }
  }

  if (findByPhone(roster, phoneId)) {
    return { roster, singer: findByPhone(roster, phoneId), code: 'E_ALREADY_CLAIMED' }
  }

  if (findByName(roster, name)) {
    return { roster, singer: null, code: 'E_NAME_TAKEN' }
  }

  const singer = {
    id: `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1679616).toString(36)}`,
    name,
    color: nextColor(roster),
    source: payload?.source === 'roster' ? 'roster' : 'phone',
    phoneId,
    host: roster.every(existing => !existing.host),
    active: true,
    createdAt: Date.now(),
    stats: { songsSung: 0, totalScore: 0, bestScore: 0, votesCast: 0 }
  }

  return { roster: [...roster, singer], singer, code: null }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string, name: string}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function renameSinger(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  const name = normalizeName(payload?.name)

  if (name.length === 0) {
    return { roster, code: 'E_BAD_NAME' }
  }

  const holder = findByName(roster, name)

  if (holder && holder.id !== singer.id) {
    return { roster, code: 'E_NAME_TAKEN' }
  }

  return {
    roster: roster.map(entry => (entry.id === singer.id ? { ...entry, name } : entry)),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function releaseSinger(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  return {
    roster: roster.map(entry => (entry.id === singer.id ? { ...entry, phoneId: null } : entry)),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string, active: boolean}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function setSingerActive(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  return {
    roster: roster.map(entry => (entry.id === singer.id ? { ...entry, active: Boolean(payload.active) } : entry)),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function setHost(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  return {
    roster: roster.map(entry => ({ ...entry, host: entry.id === singer.id })),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string, score?: number}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function recordSong(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  const score = Number.isFinite(payload?.score) ? Number(payload.score) : null

  return {
    roster: roster.map(entry => {
      if (entry.id !== singer.id) return entry

      const stats = { ...entry.stats, songsSung: entry.stats.songsSung + 1 }

      if (score !== null) {
        stats.totalScore += score
        stats.bestScore = Math.max(stats.bestScore, score)
      }

      return { ...entry, stats }
    }),
    code: null
  }
}

/**
 * Whose turn is it next, in roster order, one step past the singer who just sang, skipping singer
 * rows that are switched off or hold nothing pending. Roster order is the rotation order; the
 * queue's own array order is untouched by it.
 *
 * @param {object[]} roster
 * @param {{lastSingerId?: string|null, pendingSingerIds?: string[]}} options
 * @returns {string|null} the next singerId, or null when nobody has a pending song
 */
export function nextSingerId(roster, options) {
  const pending = new Set(options?.pendingSingerIds ?? [])
  const eligible = roster.filter(singer => singer.active && pending.has(singer.id))

  if (eligible.length === 0) return null

  const lastSingerId = options?.lastSingerId ?? null
  const lastIndex = roster.findIndex(singer => singer.id === lastSingerId)

  for (let offset = 1; offset <= roster.length; offset += 1) {
    const candidate = roster[(lastIndex + offset + roster.length) % roster.length]

    if (candidate && eligible.some(singer => singer.id === candidate.id)) {
      return candidate.id
    }
  }

  return eligible[0].id
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/karaoke-roster.test.cjs`
Expected: PASS, 16 tests

- [ ] **Step 5: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS, 115 pass / 0 fail (99 before + 16 new)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/helpers/karaoke-roster.js tests/karaoke-roster.test.cjs
git commit -m "feat(karaoke): the roster's rules as a pure helper"
```

---

### Task 2: Rotation-aware picking, and the singer a song belonged to

`pickNext` becomes rotation-aware and the queue remembers who sang last. The queue stays pure: the
roster is passed in, never read from a store.

**Files:**
- Modify: `src/renderer/helpers/karaoke-queue.js`
- Test: `tests/karaoke-queue.test.cjs`

**Interfaces:**
- Consumes: `nextSingerId(roster, { lastSingerId, pendingSingerIds })`, `createRoster()` (Task 1).
- Produces:
  - `createQueue()` gains `lastSingerId: null` (the singer the last finished song belonged to).
  - `addItem(queue, item, requester = 'local')` — the stored entry gains `singerId: item.singerId ?? null`.
  - `pickNext(queue, options)` → item | null, where
    `options = { rotation?: 'fifo'|'round_robin', roster?: object[] }`.
    `fifo` (default) is unchanged: leading priority item, else the first item.
    `round_robin`: the priority tier still jumps the line; within the normal tier the next singer
    from `nextSingerId` gets their earliest pending song, and when no rotation answer exists the
    plain order is used.
  - `completeCurrent(queue)` sets `lastSingerId` to the finished song's `singerId` when it has one.
  - `serializeQueue`/`deserializeQueue` carry `lastSingerId` (default `null`).
  - `setRotation(queue, rotation)` → `{queue, code}` (`E_BAD_ROTATION` for anything but the two modes).

- [ ] **Step 1: Write the failing tests**

Append to `tests/karaoke-queue.test.cjs` (keep the existing imports; add `pickNext`, `setRotation`,
`startItem`, `completeCurrent` to the destructured require if they are not already there):

```js
const { createRoster, claimSinger } = require('../src/renderer/helpers/karaoke-roster.js')

function twoSingerRoster() {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  return { ada: ada.singer.id, grace: grace.singer.id, roster: grace.roster }
}

function queueWith(rows) {
  return rows.reduce((queue, row) => {
    const added = addItem(queue, {
      videoId: row.videoId,
      title: row.title,
      singerId: row.singerId ?? null
    }, row.requester)

    return added.queue
  }, createQueue())
}

test('a fifo queue ignores rotation and takes the plain order', () => {
  const { ada, grace } = twoSingerRoster()
  const queue = queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A', requester: ada, singerId: ada },
    { videoId: 'bbbbbbbbbbb', title: 'B', requester: grace, singerId: grace }
  ])

  assert.equal(pickNext(queue, { rotation: 'fifo' }).videoId, 'aaaaaaaaaaa')
})

test('round robin gives the next singer their earliest pending song', () => {
  const { ada, grace, roster } = twoSingerRoster()
  const queue = { ...queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A1', requester: ada, singerId: ada },
    { videoId: 'bbbbbbbbbbb', title: 'B1', requester: grace, singerId: grace },
    { videoId: 'ccccccccccc', title: 'A2', requester: ada, singerId: ada }
  ]), lastSingerId: ada }

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'bbbbbbbbbbb')
})

test('round robin skips a singer with nothing pending instead of going silent', () => {
  const { ada, grace, roster } = twoSingerRoster()
  const queue = { ...queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A1', requester: ada, singerId: ada },
    { videoId: 'ccccccccccc', title: 'A2', requester: ada, singerId: ada }
  ]), lastSingerId: grace }

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'aaaaaaaaaaa')
})

test('round robin still lets a priority item jump the line', () => {
  const { ada, grace, roster } = twoSingerRoster()
  const promoted = queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A1', requester: ada, singerId: ada },
    { videoId: 'bbbbbbbbbbb', title: 'B1', requester: grace, singerId: grace }
  ])
  const queue = { ...promoteItem(promoted, promoted.items[1].id).queue, lastSingerId: ada }

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'bbbbbbbbbbb')
})

test('round robin falls back to the plain order when nothing can be rotated', () => {
  const { roster } = twoSingerRoster()
  const queue = queueWith([{ videoId: 'aaaaaaaaaaa', title: 'A', requester: 'local', singerId: null }])

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'aaaaaaaaaaa')
})

test('finishing a song records which singer it belonged to', () => {
  const { ada } = twoSingerRoster()
  const queue = queueWith([{ videoId: 'aaaaaaaaaaa', title: 'A', requester: ada, singerId: ada }])
  const started = startItem(queue, queue.items[0].id).queue
  const done = completeCurrent(started).queue

  assert.equal(done.lastSingerId, ada)
  assert.equal(done.current, null)
})

test('an item with no singer leaves the rotation cursor alone', () => {
  const queue = queueWith([{ videoId: 'aaaaaaaaaaa', title: 'A', requester: 'local', singerId: null }])
  const started = startItem(queue, queue.items[0].id).queue

  assert.equal(completeCurrent(started).queue.lastSingerId, null)
})

test('setRotation accepts the two modes and refuses anything else', () => {
  const queue = createQueue()

  assert.equal(setRotation(queue, 'round_robin').queue.rotation, 'round_robin')
  assert.equal(setRotation(queue, 'fifo').queue.rotation, 'fifo')
  assert.equal(setRotation(queue, 'random').code, 'E_BAD_ROTATION')
})

test('a round-robin cursor survives a serialize round trip', () => {
  const { ada } = twoSingerRoster()
  const queue = { ...createQueue(), lastSingerId: ada }
  const restored = deserializeQueue(serializeQueue(queue))

  assert.equal(restored.lastSingerId, ada)
})

test('a persisted queue without a cursor restores it as null', () => {
  const queue = { ...createQueue(), lastSingerId: 's_old' }
  const json = JSON.parse(serializeQueue(queue))
  delete json.lastSingerId
  const restored = deserializeQueue(JSON.stringify(json))

  assert.equal(restored.lastSingerId, null)
  assert.equal(restored.rotation, 'fifo')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/karaoke-queue.test.cjs`
Expected: FAIL — `pickNext` takes no options (the round-robin cases fail), `setRotation is not a function`

- [ ] **Step 3: Implement the reducer changes**

In `src/renderer/helpers/karaoke-queue.js`:

```js
import { nextSingerId } from './karaoke-roster'

export const ROTATIONS = ['fifo', 'round_robin']
```

`CODES` gains the rotation code, so every mutator still returns a `CODES` value or `null`:

```js
export const CODES = {
  BAD_VIDEO_ID: 'E_BAD_VIDEO_ID',
  DUPLICATE: 'E_DUPLICATE',
  NOT_FOUND: 'E_NOT_FOUND',
  PRIORITY_CAP: 'E_PRIORITY_CAP',
  BAD_INDEX: 'E_BAD_INDEX',
  BAD_ROTATION: 'E_BAD_ROTATION'
}
```

`createQueue()` gains the cursor:

```js
export function createQueue() {
  return {
    active: false,
    rotation: 'fifo',
    lastSingerId: null,
    current: null,
    items: [],
    played: [],
    settings: defaultSettings()
  }
}
```

`addItem`'s stored entry gains attribution (one added line inside the `entry` object literal):

```js
  const entry = {
    id: `k_${Date.now().toString(36)}_${Math.floor(Math.random() * 1679616).toString(36)}`,
    videoId,
    title: String(item?.title ?? ''),
    channel: String(item?.channel ?? ''),
    durationSeconds: Number.isFinite(item?.durationSeconds) ? Number(item.durationSeconds) : null,
    thumbnail: item?.thumbnail ?? null,
    requester,
    singerId: item?.singerId ?? null,
    priority: false,
    addedAt: Date.now()
  }
```

`pickNext` becomes:

```js
/**
 * @param {object} queue
 * @param {{rotation?: string, roster?: object[]}} [options]
 * @returns {object|null} the item that should play next
 */
export function pickNext(queue, options) {
  const priority = queue.items.find(item => item.priority)

  if (priority) return priority

  const rotation = options?.rotation ?? queue.rotation

  if (rotation === 'round_robin') {
    const pending = queue.items.map(item => item.singerId).filter(singerId => singerId !== null)
    const singerId = nextSingerId(options?.roster ?? [], {
      lastSingerId: queue.lastSingerId,
      pendingSingerIds: pending
    })

    if (singerId) {
      return queue.items.find(item => item.singerId === singerId) ?? queue.items[0] ?? null
    }
  }

  return queue.items[0] ?? null
}
```

`completeCurrent` records the singer:

```js
export function completeCurrent(queue) {
  if (!queue.current) {
    return { queue, code: null }
  }

  return {
    queue: {
      ...queue,
      current: null,
      lastSingerId: queue.current.singerId ?? queue.lastSingerId,
      played: [...queue.played, queue.current].slice(-PLAYED_LIMIT)
    },
    code: null
  }
}
```

New mutator, placed beside `setSettings`:

```js
/**
 * @param {object} queue
 * @param {string} rotation
 * @returns {{queue: object, code: string|null}}
 */
export function setRotation(queue, rotation) {
  if (!ROTATIONS.includes(rotation)) {
    return { queue, code: CODES.BAD_ROTATION }
  }

  return { queue: { ...queue, rotation }, code: null }
}
```

`serializeQueue` writes the cursor and `deserializeQueue` restores it with a default:

```js
// in serializeQueue's payload object, beside `rotation`:
      lastSingerId: queue.lastSingerId ?? null,
```

```js
// in deserializeQueue's returned object, beside `rotation`:
    lastSingerId: typeof parsed.lastSingerId === 'string' ? parsed.lastSingerId : null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/karaoke-queue.test.cjs`
Expected: PASS, 27 tests (17 existing + 10 new)

- [ ] **Step 5: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS, 125 pass / 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/renderer/helpers/karaoke-queue.js tests/karaoke-queue.test.cjs
git commit -m "feat(karaoke): rotation-aware picking and per-song singer attribution"
```

---

### Task 3: The roster's datastore

A roster is a record, not churn: it gets its own `karaoke.db` nedb datastore alongside the existing
six, per the spec's §11. This task is the storage plumbing only — nothing reads it until Task 4.

**Files:**
- Modify: `src/datastores/index.js`
- Modify: `src/datastores/handlers/base.js`
- Modify: `src/datastores/handlers/index.js`
- Modify: `src/datastores/handlers/web.js`
- Modify: `src/datastores/handlers/electron.js`

**Interfaces:**
- Consumes: the pure roster helper (Task 1) for id/normalization defaults.
- Produces: `DBKaraokeHandlers` — the datastore handler the store module in Task 4 imports, with
  `find()`, `upsert(record)`, `remove(_id)`, `removeAll()`. `window.ftElectron.dbKaraoke` exists in
  Electron builds with the same four methods.

- [ ] **Step 1: Register the datastore**

In `src/datastores/index.js`, beside the existing `createDatastore` exports:

```js
export const karaoke = createDatastore('karaoke')
```

- [ ] **Step 2: Write the base handler**

In `src/datastores/handlers/base.js`, add a class in the same style as the existing ones:

```js
class Karaoke {
  static find() {
    return db.karaoke.findAsync({})
  }

  static upsert(record) {
    return db.karaoke.upsertAsync({ _id: record._id }, { ...record })
  }

  static remove(_id) {
    return db.karaoke.removeAsync({ _id }, {})
  }

  static removeAll() {
    return db.karaoke.removeAsync({}, { multi: true })
  }
}

export { Karaoke as karaoke }
```

Match the surrounding file's actual export style — if the other classes in `base.js` are exported at
the bottom of the file rather than inline, put `karaoke` in that bottom export list instead.

- [ ] **Step 3: Export it from the handler index**

`src/datastores/handlers/index.js`:

```js
export {
  settings as DBSettingHandlers,
  history as DBHistoryHandlers,
  profiles as DBProfileHandlers,
  playlists as DBPlaylistHandlers,
  searchHistory as DBSearchHistoryHandlers,
  subscriptionCache as DBSubscriptionCacheHandlers,
  karaoke as DBKaraokeHandlers,
} from 'DB_HANDLERS_ELECTRON_RENDERER_OR_WEB'
```

- [ ] **Step 4: Export it from both environments**

`src/datastores/handlers/web.js` — add `karaoke` to the as-is export list:

```js
export { history, profiles, playlists, searchHistory, subscriptionCache, karaoke } from './base'
```

`src/datastores/handlers/electron.js` — the roster needs no main-process wrapper, so follow the
`.db` handler class pattern the file already uses for `profiles`/`playlists`: add a `Karaoke` class
delegating to `window.ftElectron.dbKaraoke` with the four methods, and export it:

```js
class Karaoke {
  static find() {
    return window.ftElectron.dbKaraoke(DBActions.GENERAL.FIND)
  }

  static upsert(record) {
    return window.ftElectron.dbKaraoke(DBActions.GENERAL.UPSERT, record)
  }

  static remove(_id) {
    return window.ftElectron.dbKaraoke(DBActions.GENERAL.DELETE, _id)
  }

  static removeAll() {
    return window.ftElectron.dbKaraoke(DBActions.GENERAL.DELETE_ALL)
  }
}
```

and add `Karaoke as karaoke,` to the file's bottom `export { ... }` block.

- [ ] **Step 5: Confirm the build resolves the new datastore**

Run: `systemctl --user restart freetube-web && sleep 20 && journalctl --user -u freetube-web -n 40 --no-pager | grep -i "compiled\|error" | tail -5`
Expected: `webpack ... compiled successfully` and no module-resolution error for `DB_HANDLERS_ELECTRON_RENDERER_OR_WEB`; then `curl -s -o /dev/null -w "%{http_code}\n" http://100.77.173.63:9080/` prints `200`.

- [ ] **Step 6: Run the whole renderer suite (nothing may regress)**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS, 128 pass / 0 fail

- [ ] **Step 7: Commit**

```bash
git add src/datastores/index.js src/datastores/handlers/base.js src/datastores/handlers/index.js src/datastores/handlers/web.js src/datastores/handlers/electron.js
git commit -m "feat(karaoke): a karaoke datastore for the singer roster"
```

---

### Task 4: The roster and rotation in the store

A Vuex module holds the roster, resolves `from` → singer on every add, and owns the rotation mode.
The module stays thin: every rule is a helper call.

**Files:**
- Create: `src/renderer/store/modules/singers.js`
- Modify: `src/renderer/store/modules/karaoke.js`
- Modify: `src/renderer/store/index.js`
- Test: `tests/karaoke-singers-store.test.cjs`

**Interfaces:**
- Consumes: `DBKaraokeHandlers` (Task 3), the roster helper (Task 1), the reducer's `setRotation`
  (Task 2).
- Produces:
  - `store/modules/singers.js` — state `{ roster: [] }`, getters
    `getSingers` (array), `getSingerById(id)`, `getSingerByPhone(phoneId)`,
    `getHostSinger`, `getActiveSingers`; mutations `setRoster`; actions
    `singersLoad`, `singerClaim`, `singerRename`, `singerRelease`, `singerSetActive`,
    `singerSetHost`, `singerRecordSong`, each persisting through the handler and returning a code.
  - `karaoke` module: getter `getKaraokeRotation`; actions
    `karaokeSetRotation(rotation)` (reducer `setRotation`), and `karaokeAdd` now takes
    `{ singerId, requester }` and passes `singerId` into `addItem`.
  - `helpers/karaoke-queue.js`'s `pickNext` is called with the roster by the getter `getKaraokeNext`.

- [ ] **Step 1: Write the failing tests**

Create `tests/karaoke-singers-store.test.cjs`. The store module's rules are pure helpers, so the test
drives the module's action bodies through the real reducer and a fake handler — the same shape P1's
store test used for localStorage:

```js
const test = require('node:test')
const assert = require('node:assert/strict')

const { createRoster, claimSinger } = require('../src/renderer/helpers/karaoke-roster.js')
const { createQueue, addItem, pickNext, setRotation } = require('../src/renderer/helpers/karaoke-queue.js')

test('an add that carries a singerId is attributed to that singer', () => {
  const { queue } = addItem(createQueue(), { videoId: 'aaaaaaaaaaa', title: 'A', singerId: 's_1' }, 's_1')

  assert.equal(queue.items[0].singerId, 's_1')
  assert.equal(queue.items[0].requester, 's_1')
})

test('the priority cap counts a claimed singer, not the phone that claimed it', () => {
  const { priorityCount } = require('../src/renderer/helpers/karaoke-queue.js')
  let queue = createQueue()

  // the same singer, two different phones (a re-pair must not buy a second allowance)
  queue = addItem(queue, { videoId: 'aaaaaaaaaaa', title: 'A' }, 's_1').queue
  queue = { ...queue, items: queue.items.map(item => ({ ...item, priority: true })) }
  queue = addItem(queue, { videoId: 'bbbbbbbbbbb', title: 'B' }, 's_1').queue
  queue = { ...queue, items: queue.items.map(item => ({ ...item, priority: true })) }

  assert.equal(priorityCount(queue, 's_1'), 2)
  assert.equal(priorityCount(queue, 'ph_other'), 0)
})

test('the rotation mode the store sets is the mode the picker uses', () => {
  const { roster } = (() => {
    const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
    return claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  })()
  const [ada, grace] = roster
  let queue = createQueue()

  queue = addItem(queue, { videoId: 'aaaaaaaaaaa', title: 'A1' }, ada.id).queue
  queue = addItem(queue, { videoId: 'bbbbbbbbbbb', title: 'B1' }, grace.id).queue
  queue = { ...queue, items: queue.items.map(item => ({ ...item, singerId: item.requester })) }
  queue = setRotation(queue, 'round_robin').queue
  queue = { ...queue, lastSingerId: ada.id }

  assert.equal(pickNext(queue, { rotation: queue.rotation, roster }).videoId, 'bbbbbbbbbbb')
})

test('setRotation refuses an unknown mode', () => {
  assert.equal(setRotation(createQueue(), 'shuffle').code, 'E_BAD_ROTATION')
})
```

- [ ] **Step 2: Run the tests**

Run: `node --test tests/karaoke-singers-store.test.cjs`
Expected: PASS (4 tests) — these are reducer-level and they pass as soon as Task 2 lands. Be clear-eyed
about that: the store module itself cannot be imported by a `node:test` file (its import chain runs
through the `DB_HANDLERS_ELECTRON_RENDERER_OR_WEB` webpack alias into nedb), so this task's own gates
are the whole suite staying green plus the compile/bundle check in Step 6 — the same shape as P1's
Task 4 ruling. Write the reducer-level tests red first by running them at the end of Task 1 if you
want the cycle; the point of this file is that the contract Task 4 must satisfy is pinned before the
module is written.

- [ ] **Step 3: Write the singers store module**

Create `src/renderer/store/modules/singers.js`, following the shape of
`src/renderer/store/modules/playlists.js` (async actions over handler calls, `deepCopy` from
`helpers/utils` before mutating):

```js
import { DBKaraokeHandlers } from '../../../datastores/handlers/index'
import {
  createRoster, claimSinger, renameSinger, releaseSinger, setSingerActive, setHost, recordSong
} from '../../helpers/karaoke-roster'

const state = {
  roster: []
}

const getters = {
  getSingers: state => state.roster,
  getSingerById: state => id => state.roster.find(singer => singer.id === id) ?? null,
  getSingerByPhone: state => phoneId => state.roster.find(singer => singer.phoneId === phoneId) ?? null,
  getHostSinger: state => state.roster.find(singer => singer.host) ?? null,
  getActiveSingers: state => state.roster.filter(singer => singer.active)
}

const mutations = {
  /**
   * @param {object} state
   * @param {object[]} roster
   */
  setRoster(state, roster) {
    state.roster = Array.isArray(roster) ? roster : []
  }
}

/**
 * The roster is stored one row per singer, so a rename is an upsert of that row and a release is an
 * upsert with `phoneId: null` — the row itself is the record, and deleting it would lose the stats.
 *
 * @param {object} context
 * @param {object} context.commit
 * @param {object} roster
 * @param {object|null} changed
 */
async function persistRoster({ commit }, roster, changed = null) {
  commit('setRoster', roster)

  if (changed) {
    await DBKaraokeHandlers.upsert(changed)
  }
}

const actions = {
  /**
   * @param {object} context
   * @param {object} context.commit
   */
  async singersLoad({ commit }) {
    const rows = await DBKaraokeHandlers.find()
    commit('setRoster', rows ?? [])
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{name: string, phoneId: string, source?: string}} payload
   * @returns {Promise<{singer: object|null, code: string|null}>}
   */
  async singerClaim({ state, commit }, payload) {
    const { roster, singer, code } = claimSinger(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, singer)
    } else if (singer) {
      commit('setRoster', roster)
    }

    return { singer, code }
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string, name: string}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerRename({ state, commit }, payload) {
    const { roster, code } = renameSinger(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerRelease({ state, commit }, payload) {
    const { roster, code } = releaseSinger(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string, active: boolean}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerSetActive({ state, commit }, payload) {
    const { roster, code } = setSingerActive(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerSetHost({ state, commit }, payload) {
    const { roster, code } = setHost(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster)

      for (const singer of roster) {
        await DBKaraokeHandlers.upsert(singer)
      }
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string, score?: number}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerRecordSong({ state, commit }, payload) {
    const { roster, code } = recordSong(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  }
}

export default { state, getters, mutations, actions }
```

- [ ] **Step 4: Register the module**

`src/renderer/store/index.js`: add the import beside the karaoke module's and add `singers` to the
`modules` object.

- [ ] **Step 5: Teach the karaoke module about singers and rotation**

`src/renderer/store/modules/karaoke.js`:

```js
// getter, beside getKaraokePriorityCount
getKaraokeRotation: state => state.rotation,
```

```js
// the next-song getter passes the roster and the mode the queue carries
getKaraokeNext: (state, getters, rootState, rootGetters) =>
  pickNext(state, { rotation: state.rotation, roster: rootGetters.getSingers }),
```

```js
// action, beside karaokeSetSettings
/**
 * @param {object} context
 * @param {object} context.state
 * @param {object} context.commit
 * @param {string} rotation
 * @returns {string|null} a code or null
 */
karaokeSetRotation({ state, commit }, rotation) {
  const { queue, code } = setRotation(state, rotation)

  if (code === null) {
    commit('setKaraokeQueue', queue)
    persist(queue)
  }

  return code
},
```

```js
// the add action now carries singer attribution through to the reducer
karaokeAdd({ state, commit }, payload) {
  const requester = payload?.singerId ?? payload?.requester ?? 'local'
  const { queue, code } = addItem(state, payload, requester)

  if (code === null) {
    commit('setKaraokeQueue', queue)
    persist(queue)
  }

  return code
},
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/karaoke-singers-store.test.cjs`
Expected: PASS, 4 tests

- [ ] **Step 7: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS, 129 pass / 0 fail (125 after Task 2, plus this task's 4)

- [ ] **Step 8: Commit**

```bash
git add src/renderer/store/modules/singers.js src/renderer/store/modules/karaoke.js src/renderer/store/index.js tests/karaoke-singers-store.test.cjs
git commit -m "feat(karaoke): a roster store module, and adds that carry their singer"
```

---

### Task 5: The wire — a claim command, singers in the frame

The phone claims a name, the frame carries the roster and each row's singer, and every add resolves
its requester the same way the TV does.

**Files:**
- Modify: `src/renderer/remote/karaoke-actions.js`
- Modify: `src/renderer/remote/agent.js`
- Modify: `src/renderer/App.vue` (only if the singers module needs a load on mount)
- Test: `tests/remote-karaoke.test.cjs`

**Interfaces:**
- Consumes: `createKaraokeActions`'s existing map, the singers module's getters (Task 4).
- Produces:
  - `karaoke-actions.js`: the map gains `singerClaim: payload => store.dispatch('singerClaim', { name, phoneId: payload?.from })`,
    and `queueAdd` resolves `singerId` from the claim before dispatching:
    `requester: singerId ?? payload?.from`, with `singerId: singerId ?? null` on the item.
  - `agent.js`: `buildQueueFrame(karaoke, singers)` — the frame gains
    `singers: [{ id, name, color, host, active }]` and each row keeps its `id`, `videoId`, `title`,
    `requester`, `singerId`, `priority`, `addedAt`. `singers` is NOT added to the 1 s state frame
    (the state frame carries `karaokeActive` and nothing else — the existing exact-key-set test
    enforces this) and no singer data rides inside `queueItemForWire`'s whitelist beyond the two ids.

- [ ] **Step 1: Write the failing tests**

Append to `tests/remote-karaoke.test.cjs`:

```js
test('a singer claim binds the bridge phone id to a roster row', async () => {
  const roster = createRoster()
  const store = {
    state: { singers: { roster }, karaoke: createQueue() },
    dispatch: (type, payload) => {
      if (type === 'singerClaim') {
        const result = claimSinger(store.state.singers.roster, payload)
        store.state.singers.roster = result.roster
        return result
      }
      return null
    }
  }
  const actions = createKaraokeActions(store)

  await actions.singerClaim({ name: 'Ada', from: 'ph_a' })

  assert.equal(store.state.singers.roster[0].phoneId, 'ph_a')
  assert.equal(store.state.singers.roster[0].name, 'Ada')
})

test('an add from a claimed phone is attributed to the singer, not the phone', async () => {
  const roster = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' }).roster
  const calls = []
  const store = {
    state: { singers: { roster } },
    getters: { getSingerByPhone: phoneId => roster.find(singer => singer.phoneId === phoneId) ?? null },
    dispatch: (type, payload) => { calls.push({ type, payload }); return null }
  }
  const actions = createKaraokeActions(store)

  await actions.queueAdd({ videoId: 'aaaaaaaaaaa', title: 'A', from: 'ph_a' })

  assert.equal(calls[0].type, 'karaokeAdd')
  assert.equal(calls[0].payload.singerId, roster[0].id)
  assert.equal(calls[0].payload.requester, roster[0].id)
  assert.equal(calls[0].payload.id, undefined)
})

test('an add from an unclaimed phone falls back to the bridge phone id', async () => {
  const calls = []
  const store = {
    state: { singers: { roster: [] } },
    getters: { getSingerByPhone: () => null },
    dispatch: (type, payload) => { calls.push({ type, payload }); return null }
  }
  const actions = createKaraokeActions(store)

  await actions.queueAdd({ videoId: 'aaaaaaaaaaa', title: 'A', from: 'ph_z' })

  assert.equal(calls[0].payload.singerId, null)
  assert.equal(calls[0].payload.requester, 'ph_z')
})

test('the queue frame carries the roster but never inside the state frame', () => {
  const roster = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' }).roster
  const queue = { ...createQueue(), active: true }
  const frame = buildQueueFrame(queue, roster)
  const state = { ...buildState({ title: 'T', videoId: 'aaaaaaaaaaa' }, null, () => 0), karaokeActive: true }

  assert.equal(frame.singers.length, 1)
  assert.equal(frame.singers[0].name, 'Ada')
  assert.deepEqual(Object.keys(state).sort(), STATE_FRAME_KEYS)
})

test('a frame with no roster sends an empty singers list, not undefined', () => {
  assert.deepEqual(buildQueueFrame({ ...createQueue(), active: true }, undefined).singers, [])
})
```

Add to the test file's imports: `createRoster, claimSinger` from
`../src/renderer/helpers/karaoke-roster.js` and `createKaraokeActions` from
`../src/renderer/remote/karaoke-actions.js` if not already present.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/remote-karaoke.test.cjs`
Expected: FAIL — `singerClaim` is not a function on the map; `buildQueueFrame` ignores a roster;
`frame.singers` is undefined

- [ ] **Step 3: Extend the action map**

`src/renderer/remote/karaoke-actions.js`:

```js
    // The claim binds the bridge's phone id (the only identity a phone can prove) to a roster row.
    // The phone sends a name; the phone id comes from the bridge's `from`, never from the payload.
    singerClaim: payload => store.dispatch('singerClaim', {
      name: payload?.name,
      phoneId: payload?.from,
      source: 'phone'
    }),
    // Attribution: once the phone has claimed a singer, that singer is the requester — the priority
    // cap counts singers, so re-pairing a phone must not buy a second allowance. An unclaimed phone
    // keeps the P1 behaviour (its own `from`, else the reducer's default).
    queueAdd: payload => {
      const singer = store.getters?.getSingerByPhone?.(payload?.from) ?? null

      return store.dispatch('karaokeAdd', {
        ...queueCommandFields(payload),
        singerId: singer?.id ?? null,
        requester: singer?.id ?? payload?.from
      })
    },
```

Leave `singerRename`, `singerRelease`, `singerSetActive`, `singerSetHost` out of this task — the
phone's singer-management UI is P2's last screen and it is the TV that holds host power.

- [ ] **Step 4: Extend the frame builder**

`src/renderer/remote/agent.js`:

```js
/**
 * @param {object|null} karaoke the store's karaoke state
 * @param {object[]} [singers] the roster, for names and colours on the phone
 * @returns {object|null}
 */
export function buildQueueFrame(karaoke, singers) {
  if (!karaoke) return null

  const items = Array.isArray(karaoke.items) ? karaoke.items : []

  return {
    active: Boolean(karaoke.active),
    rotation: karaoke.rotation ?? 'fifo',
    lastSingerId: karaoke.lastSingerId ?? null,
    current: karaoke.current ? queueItemForWire(karaoke.current) : null,
    upcoming: items.slice(0, 20).map(queueItemForWire),
    priorityCount: items.filter(item => item.priority).length,
    playedCount: Array.isArray(karaoke.played) ? karaoke.played.length : 0,
    singers: (Array.isArray(singers) ? singers : []).map(singer => ({
      id: singer.id,
      name: singer.name,
      color: singer.color,
      host: Boolean(singer.host),
      active: Boolean(singer.active)
    }))
  }
}
```

`queueItemForWire` gains the attribution field:

```js
export function queueItemForWire(item) {
  return {
    id: item.id,
    videoId: item.videoId,
    title: item.title,
    channel: item.channel,
    durationSeconds: item.durationSeconds ?? null,
    thumbnail: item.thumbnail ?? null,
    requester: item.requester ?? null,
    singerId: item.singerId ?? null,
    priority: Boolean(item.priority),
    addedAt: item.addedAt ?? null
  }
}
```

The agent's publisher passes the roster:

```js
    if (frame) send({ t: 'queue', karaoke: frame })
```

becomes

```js
    const frame = buildQueueFrame(getKaraoke(), getSingers())

    if (frame) send({ t: 'queue', karaoke: frame })
```

with `getSingers` threaded through `createRemoteAgent`'s options the same way `getKaraoke` already is,
and `src/renderer/App.vue` passing `() => store.getters.getSingers`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/remote-karaoke.test.cjs`
Expected: PASS, 11 tests

- [ ] **Step 6: Run the whole renderer suite, then prove the bundle compiles**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS, 134 pass / 0 fail (129 after Task 4, plus this task's 5)

Then prove the new wiring reached the served bundle:
`systemctl --user restart freetube-web && sleep 20 && curl -s http://100.77.173.63:9080/web.js | grep -c "getSingers"` → `>= 1`

- [ ] **Step 7: Commit**

```bash
git add src/renderer/remote/karaoke-actions.js src/renderer/remote/agent.js src/renderer/App.vue tests/remote-karaoke.test.cjs
git commit -m "feat(karaoke): the phone claims a singer and the frame carries the roster"
```

---

### Task 6: The singers strip on the TV

The party's visible surface: who is singing, whose turn is next, who is the host, and the rotation
switch.

**Files:**
- Create: `src/renderer/components/FtKaraokeSingers/FtKaraokeSingers.vue`
- Create: `src/renderer/components/FtKaraokeSingers/FtKaraokeSingers.css`
- Modify: `src/renderer/views/Karaoke/Karaoke.vue`
- Modify: `src/renderer/views/Karaoke/Karaoke.css`
- Modify: `static/locales/en-US.yaml`

**Interfaces:**
- Consumes: the singers module's getters/actions (Task 4), the karaoke module's rotation getter and
  `karaokeSetRotation` (Task 4), `getKaraokeQueue` (P1).
- Produces: `<ft-karaoke-singers />` — no props. DOM contract:
  `.karaokeSingers` (root), `.karaokeSinger` per row, `.karaokeSingerName`,
  `.karaokeSingerColor`, `.isHost`, `.isActiveTurn`, `.karaokeSingerPending` (count),
  `.karaokeSingerRename`, `.karaokeSingerRelease`, `.karaokeSingerHost`,
  `.karaokeSingerToggle`, `.karaokeRotation` (the mode `<select>` with
  `.karaokeRotationFifo` / `.karaokeRotationRoundRobin` options), `.karaokeSingersEmpty`.
  Locale keys added: `Karaoke.Singers`, `Karaoke.Host`, `Karaoke.Your Turn`, `Karaoke.Pending`,
  `Karaoke.Rename`, `Karaoke.Release Name`, `Karaoke.Make Host`, `Karaoke.Rotation`,
  `Karaoke.Rotation Fifo`, `Karaoke.Rotation Round Robin`, `Karaoke.No Singers`.

- [ ] **Step 1: Write the component**

Create `FtKaraokeSingers.vue`:

```vue
<template>
  <div class="karaokeSingers">
    <div class="karaokeSingersHeader">
      <h3 class="karaokeSingersTitle">{{ t('Karaoke.Singers') }}</h3>
      <label class="karaokeRotationLabel">
        {{ t('Karaoke.Rotation') }}
        <select class="karaokeRotation" :value="rotation" @change="setRotation($event.target.value)">
          <option class="karaokeRotationFifo" value="fifo">{{ t('Karaoke.Rotation Fifo') }}</option>
          <option class="karaokeRotationRoundRobin" value="round_robin">{{ t('Karaoke.Rotation Round Robin') }}</option>
        </select>
      </label>
    </div>
    <p v-if="singers.length === 0" class="karaokeSingersEmpty">{{ t('Karaoke.No Singers') }}</p>
    <ul v-else class="karaokeSingersList">
      <li
        v-for="singer in singers"
        :key="singer.id"
        class="karaokeSinger"
        :class="{ isHost: singer.host, isActiveTurn: singer.id === nextSingerId }"
      >
        <span class="karaokeSingerColor" :style="{ backgroundColor: singer.color }" />
        <span class="karaokeSingerName">{{ singer.name }}</span>
        <span v-if="singer.host" class="karaokeSingerHost">{{ t('Karaoke.Host') }}</span>
        <span v-if="singer.id === nextSingerId" class="karaokeSingerTurn">{{ t('Karaoke.Your Turn') }}</span>
        <span class="karaokeSingerPending">{{ pendingFor(singer.id) }}</span>
        <button class="karaokeSingerRename" @click="rename(singer)">{{ t('Karaoke.Rename') }}</button>
        <button class="karaokeSingerRelease" @click="release(singer)">{{ t('Karaoke.Release Name') }}</button>
        <button class="karaokeSingerHost" @click="makeHost(singer)">{{ t('Karaoke.Make Host') }}</button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useStore } from 'vuex'
import { useI18n } from 'vue-i18n'

const store = useStore()
const { t } = useI18n()

const singers = computed(() => store.getters.getSingers)
const rotation = computed(() => store.getters.getKaraokeRotation)
const upcoming = computed(() => store.getters.getKaraokeUpcoming)

const nextSingerId = computed(() => {
  const first = upcoming.value.find(item => item.priority) ?? upcoming.value[0]

  return first?.singerId ?? null
})

/**
 * @param {string} singerId
 * @returns {number}
 */
function pendingFor(singerId) {
  return upcoming.value.filter(item => item.singerId === singerId).length
}

/**
 * @param {string} mode
 */
function setRotation(mode) {
  store.dispatch('karaokeSetRotation', mode)
}

/**
 * @param {object} singer
 */
async function rename(singer) {
  const name = window.prompt(t('Karaoke.Rename'), singer.name)

  if (name !== null) {
    await store.dispatch('singerRename', { singerId: singer.id, name })
  }
}

/**
 * @param {object} singer
 */
async function release(singer) {
  await store.dispatch('singerRelease', { singerId: singer.id })
}

/**
 * @param {object} singer
 */
async function makeHost(singer) {
  await store.dispatch('singerSetHost', { singerId: singer.id })
}
</script>

<style scoped src="./FtKaraokeSingers.css" />
```

Create `FtKaraokeSingers.css` with rules for each class above — a row of colour-chip + name +
badges + small buttons, `isActiveTurn` outlined in the singer's own colour via
`border-color: currentColor`, and a `flex-wrap: wrap` list so a party of eight still fits. Keep the
existing karaoke components' style conventions (no nesting, one selector per rule).

- [ ] **Step 2: Mount it in the karaoke view**

`src/renderer/views/Karaoke/Karaoke.vue`: import `FtKaraokeSingers`, render `<ft-karaoke-singers />`
between the options block and the results block, and load the roster once on mount:

```js
onMounted(() => {
  store.dispatch('singersLoad')
})
```

Keep the existing `karaokeSetActive(true)` mount call.

- [ ] **Step 3: Add the locale keys**

`static/locales/en-US.yaml`, inside the existing `Karaoke:` block, add the eleven keys from the DOM
contract above with these exact values:

```yaml
    Singers: Singers
    Host: Host
    Your Turn: Your turn
    Pending: Pending
    Rename: Rename
    Release Name: Release
    Make Host: Make host
    Rotation: Rotation
    Rotation Fifo: In the order they were added
    Rotation Round Robin: Take turns
    No Singers: No singers yet - pair a phone to claim a name
```

- [ ] **Step 4: Verify it compiles and serves**

Run: `systemctl --user restart freetube-web && sleep 20 && journalctl --user -u freetube-web -n 30 --no-pager | grep -i "compiled\|error" | tail -3`
Expected: `compiled successfully`, no error.
Then: `curl -s http://100.77.173.63:9080/web.js | grep -c "karaokeSingerName"` → `>= 1`

- [ ] **Step 5: Run the whole renderer suite**

Run: `node --test "tests/*.test.cjs"`
Expected: PASS, 134 pass / 0 fail (this task adds no tests — the repo has no SFC test harness; the
component is exercised by Task 8's live check, and the controller verifies the DOM)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/FtKaraokeSingers src/renderer/views/Karaoke static/locales/en-US.yaml
git commit -m "feat(karaoke): the singers strip and the rotation switch"
```

---

### Task 7: The phone's claim screen

The phone asks "Who are you?" once, claims a roster row, and shows the party's singers with its own
name first. Bridge repo.

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/app.css`
- Test: `tests-web/karaoke.test.mjs`

**Interfaces:**
- Consumes: the wire contract from Task 5 (`singerClaim { name }` with the phone's own `from`
  supplied by the bridge; `t:'queue'` frame's `singers` array and per-row `singerId`).
- Produces: `buildClaim(name)` → `{ cmd: 'singerClaim', name }` (pure, tested);
  `orderOwn(rows, mySingerId)` → rows with `mine: true` for the claimer's own songs
  (pure, tested); DOM ids `claim-screen`, `claim-name`, `claim-submit`, `claim-list`,
  `singers-strip`, `queue-mine`.

- [ ] **Step 1: Write the failing tests**

Create `tests-web/karaoke.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildClaim, orderOwn } from '../web/karaoke.js'

test('a name is trimmed before it is sent', () => {
  assert.deepEqual(buildClaim('  Ada  '), { cmd: 'singerClaim', name: 'Ada' })
})

test('an empty name is refused before the wire', () => {
  assert.equal(buildClaim('   '), null)
})

test('your own songs sort first and keep their order', () => {
  const rows = [
    { id: 'k1', title: 'A', singerId: 's_2' },
    { id: 'k2', title: 'B', singerId: 's_1' },
    { id: 'k3', title: 'C', singerId: 's_1' },
    { id: 'k4', title: 'D', singerId: null }
  ]
  const ordered = orderOwn(rows, 's_1')

  assert.deepEqual(ordered.map(row => row.id), ['k2', 'k3', 'k1', 'k4'])
  assert.deepEqual(ordered.map(row => Boolean(row.mine)), [true, true, false, false])
})

test('with no claim nothing is marked as yours', () => {
  const rows = [{ id: 'k1', title: 'A', singerId: 's_1' }]

  assert.deepEqual(orderOwn(rows, null).map(row => Boolean(row.mine)), [false])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "tests-web/*.test.mjs"`
Expected: FAIL — `Cannot find module '../web/karaoke.js'`

- [ ] **Step 3: Write the pure phone helper**

Create `web/karaoke.js` beside the existing `web/link.js` (the phone's other pure helper):

```js
// Pure phone-side helpers for karaoke. The DOM wiring lives in app.js; everything decidable without
// a document lives here so it can be tested without a browser.

/**
 * @param {string} raw the name the phone typed
 * @returns {{cmd: string, name: string}|null} the claim command, or null when there is no name
 */
export function buildClaim(raw) {
  const name = String(raw ?? '').replaceAll(/\s+/g, ' ').trim()

  return name.length === 0 ? null : { cmd: 'singerClaim', name }
}

/**
 * Your own songs first, then everyone else's, each group keeping the queue's order.
 *
 * @param {object[]} rows the frame's upcoming rows
 * @param {string|null} mySingerId
 * @returns {object[]} rows carrying a `mine` flag
 */
export function orderOwn(rows, mySingerId) {
  const mine = []
  const rest = []

  for (const row of Array.isArray(rows) ? rows : []) {
    if (mySingerId && row?.singerId === mySingerId) {
      mine.push({ ...row, mine: true })
    } else {
      rest.push({ ...row, mine: false })
    }
  }

  return [...mine, ...rest]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "tests-web/*.test.mjs"`
Expected: PASS, 7 tests (3 existing + 4 new)

- [ ] **Step 5: Add the claim screen to the phone UI**

`web/index.html`: a `#claim-screen` section with `#claim-name` (a text input), `#claim-submit`, and
`#claim-list` (the roster rows, each tappable to claim an existing name); a `#singers-strip` in the
remote view. Keep the existing screen-switching convention (`show(id)` hides all screens but one).

`web/app.js`:

- extend `state` with `mySingerId: null` and `claimPrompted: false`
- in `applyFrame`, when the frame carries `active: true` and `singers` and no claim is stored, show
  the claim screen once (`show('claim')`); render `#claim-list` from `frame.singers`
- `#claim-submit` sends `buildClaim(input.value)` through the existing `command(...)` path — the
  bridge stamps `from`, so the phone sends only a name; add the command to `command()`'s allowed set
  the same way the existing commands are listed
- store the claimed singer's id locally (`localStorage`) once the next `t:'queue'` frame contains a
  singer whose `name` matches, so a reload does not re-ask
- render the queue with `orderOwn(frame.upcoming, state.mySingerId)` and a `mine` class on your rows
- render `#singers-strip` from `frame.singers`, marking the host

`web/app.css`: styles for the claim screen and the strip, following the file's existing plain-class
conventions.

If `web/sw.js` precaches the phone's assets, add `karaoke.js` to that list — a missing precache entry
leaves the claim screen dead offline, which is exactly when a party needs it.

- [ ] **Step 6: Verify the phone page is served and the suite is green**

Run: `systemctl --user restart freetube-remote && sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9098/`
Expected: `200`
Then: `node --test "tests-web/*.test.mjs"` → PASS, 7 pass / 0 fail
Then: `uv run pytest tests -q` → still 43 passed

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/app.js web/app.css web/karaoke.js tests-web/karaoke.test.mjs
git commit -m "feat(karaoke): the phone claims a name and shows its own songs first"
```

---

### Task 8: End-to-end evidence, and the spec

The stage's proof, per the spec's Stages section for P2: *two phones, two names, alternating turns,
and a third priority request demoted.*

**Files:**
- Modify: `docs/superpowers/specs/2026-11-10-karaoke-night-design.md` (status line only)

**Interfaces:**
- Consumes: everything above.
- Produces: measured evidence in the spec; no new code.

- [ ] **Step 1: Full suites**

```bash
cd ~/developer/freetube && node --test "tests/*.test.cjs"
cd ~/developer/freetube-remote && uv run pytest tests -q && node --test "tests-web/*.test.mjs"
```

Record the live numbers (P1 ended at 99 / 43 / 3; P2 adds 19 + 10 + 4 + 5 + 4).

- [ ] **Step 2: Two claimers, two names, alternating turns — against the real bridge**

Script two phone sockets and one player socket at the live bridge (the P1 evidence script
`karaoke-e2e.py` in `~/.hermes/cache/scratch/` is the pattern: player `auth role=player`, phone
`auth role=phone` with the token from `POST /remote/pair`). Then:

1. each phone sends `singerClaim` with a different name — assert the roster answers with two rows,
   the first marked `host`
2. each phone queues two songs — assert `singerId`/`requester` on every add equals that phone's
   claimed singerId, and that the priority cap of 2 is counted per singer (a third priority add from
   one singer must arrive without priority while the other singer's is untouched)
3. switch rotation to `round_robin`, play the first song, let it end, and assert the next song
   belongs to the other singer, then back again
4. assert the `t:'queue'` frame the phones receive carries `singers` and each row's `singerId`

Record the two names, the four video ids, the observed turn order, and the demotion.

- [ ] **Step 3: The TV surfaces, in the live DOM**

At `http://100.77.173.63:9080/#/karaoke` with two claimed singers: assert `.karaokeSinger` = 2,
`.isHost` = 1, `.isActiveTurn` = 1, the rotation select's value, and that renaming/releasing/hosting
through the strip changes the roster. The controller runs this; the implementer records only what it
ran itself.

- [ ] **Step 4: The phone's claim screen**

Load the phone page over the funnel (`https://nextcloud.taild1347f.ts.net:10000/remote/`) and, with
the mode active, assert the claim screen appears once, that claiming an existing name and creating a
new one both land, and that your own songs sort first.

- [ ] **Step 5: Update the spec status line and commit**

```markdown
**Status:** P1 BUILT — `<P1 commit>`; P2 BUILT — `<P2 commit>`; renderer `<n>` tests, bridge `<n>` + `<n>`;
evidence in the plans' Task 8/9.
```

```bash
git add docs/superpowers/specs/2026-11-10-karaoke-night-design.md
git commit -m "docs(karaoke): P2 status and measured evidence"
```

---

## Self-review notes (kept in the plan on purpose)

- **Spec coverage.** §4 singer record → Task 1 (row shape) + Task 3 (per-profile `karaoke.db`);
  phone claim with no passwords → Task 5 (command) + Task 7 (screen); `from` → singer binding →
  Task 5; rotation `round_robin` cursor + `fifo` → Task 2; host granted on the TV and gating
  destructive commands → Task 1 (`setHost`) + Task 6 (strip; the destructive-command gate itself
  lands with P3's `queueClear`-host rule, which is where the spec puts it); "one singer may hold the
  current song and a queue" → no work needed, the reducer already allows it; §3's cap becoming
  per-singer → Task 4 (`karaokeAdd`'s requester resolution) + Task 5 (the wire); §11 `karaoke.db`
  `singers` (with `history`/`nights` deferred to P6, which the spec's Stages section gives grading) →
  Task 3; §12 singers strip → Task 6. §5 voting and §6 drag are P3/P4 and deliberately absent.
- **Type consistency.** `singerId` is the roster row's id everywhere (`s_…`); `requester` stays the
  cap key (singer id when claimed, else the phone's `from`, else `'local'`); `phoneId` is the
  bridge's `from`; the frame's row key is `id` while a command's row target is `itemId`.
- **Names that must not drift across tasks:** `createRoster`, `claimSinger`, `renameSinger`,
  `releaseSinger`, `setSingerActive`, `setHost`, `recordSong`, `nextSingerId`, `SINGER_COLORS`,
  `setRotation`, `ROTATIONS`, `lastSingerId`, `DBKaraokeHandlers`, `getSingers`,
  `getSingerByPhone`, `getKaraokeRotation`, `karaokeSetRotation`, `buildClaim`, `orderOwn`,
  `buildQueueFrame(karaoke, singers)`.
- **Known risk.** Task 5 changes the queue frame's shape, which the phone builds its UI from; Task 7
  is the consumer. Between them the phone renders rows without names — acceptable mid-branch, and
  Task 8 is where both are checked together.
- **Deferred on purpose:** the compact bar's "queue empty" state still has no pairing QR (spec §12);
  the controller ruled that into this stage's scope only if the pair-code flow is needed for the
  claim screen to be reachable, which Task 7 avoids by claiming on the first karaoke frame.
- **Known weakness.** Task 7's phone-DOM wiring is prose anchored to the file's real symbols
  (`show`, `command`, `applyFrame`, `state`) rather than full code, because the phone's screens are
  plain DOM whose exact markup varies; the implementer must read `web/app.js`'s existing screen
  pattern and mirror it. Everything decidable without a document in Task 7 (`buildClaim`, `orderOwn`)
  is written out in full and tested.
