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

test('a persisted queue is restored', async () => {
  const module = await load()
  const { createQueue, serializeQueue } = await import('../src/renderer/helpers/karaoke-queue.js')
  const storage = fakeStorage()
  const base = createQueue()
  const queue = {
    ...base,
    active: true,
    items: [
      { id: 'k_a', videoId: 'aaaaaaaaaaa', title: 'A', channel: 'x', durationSeconds: 100, requester: 'local', priority: true },
      { id: 'k_b', videoId: 'bbbbbbbbbbb', title: 'B', channel: 'y', durationSeconds: 200, requester: 'local', priority: false }
    ],
    settings: { ...base.settings, minSeconds: 240 }
  }
  storage.setItem('freetube-karaoke', serializeQueue(queue))

  globalThis.localStorage = storage
  const state = module.default.state()
  assert.deepEqual(state.items.map(entry => entry.title), ['A', 'B'])
  assert.equal(state.items[0].priority, true)
  assert.equal(state.active, true)
  assert.equal(state.settings.minSeconds, 240)
})

test('a corrupt persisted queue is ignored', async () => {
  const module = await load()
  const storage = fakeStorage({ 'freetube-karaoke': 'not json' })

  globalThis.localStorage = storage
  assert.deepEqual(module.default.state().items, [])
  assert.equal(module.default.getters.getKaraokeActive(module.default.state()), false)
})

test('promote, remove, clear and move report their codes and leave a known queue', async () => {
  const module = await load()
  const ctx = await context(module, fakeStorage())
  const actions = module.default.actions

  await actions.karaokeAdd(ctx, { videoId: 'aaaaaaaaaaa', title: 'A' })
  await actions.karaokeAdd(ctx, { videoId: 'bbbbbbbbbbb', title: 'B' })
  await actions.karaokeAdd(ctx, { videoId: 'ccccccccccc', title: 'C' })
  const [a, b] = ctx.state.items

  // Unknown ids: E_NOT_FOUND, and neither call mutates the queue.
  assert.equal(await actions.karaokeRemove(ctx, 'k_missing'), 'E_NOT_FOUND')
  assert.equal(await actions.karaokePromote(ctx, 'k_missing'), 'E_NOT_FOUND')
  assert.deepEqual(ctx.state.items.map(entry => entry.title), ['A', 'B', 'C'])

  // A valid remove drops exactly that row.
  assert.equal(await actions.karaokeRemove(ctx, b.id), null)
  assert.deepEqual(ctx.state.items.map(entry => entry.title), ['A', 'C'])

  // An out-of-range index yields E_BAD_INDEX and leaves the order untouched.
  assert.equal(await actions.karaokeMove(ctx, { id: a.id, toIndex: 9 }), 'E_BAD_INDEX')
  assert.deepEqual(ctx.state.items.map(entry => entry.title), ['A', 'C'])

  // A valid clear empties items and current and returns null.
  assert.equal(await actions.karaokeClear(ctx), null)
  assert.deepEqual(ctx.state.items, [])
  assert.equal(ctx.state.current, null)
})

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
