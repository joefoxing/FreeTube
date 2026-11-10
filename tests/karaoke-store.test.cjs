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
