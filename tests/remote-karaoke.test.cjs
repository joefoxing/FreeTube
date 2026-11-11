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

// The fake transport is the same shape tests/remote-agent-connection.test.cjs drives — this test
// goes through the agent's real send path and the real karaoke reducer, not the pure builders.
// The state frame's exact key set, so an extra key (e.g. a queue inlined under a new name) fails.
const STATE_FRAME_KEYS = ['at', 'channel', 'duration', 'karaokeActive', 'muted', 'playing', 'position', 'rate', 'thumbnail', 'title', 'videoId', 'volume'].sort()

class FakeSocket {
  static instances = []
  static OPEN = 1
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeSocket.instances.push(this)
  }
  send(payload) { this.sent.push(JSON.parse(payload)) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('the agent sends its own queue frame, keeps the queue out of the state frame, and takes the requester from the bridge `from` alone', async () => {
  const { createRemoteAgent } = await load()
  // The action map the agent registers is the REAL one App.vue builds, imported from its own
  // module — not a copy re-declared here, so a regression inside it fails this test.
  const { createKaraokeActions } = await import('../src/renderer/remote/karaoke-actions.js')
  const store = (await import('../src/renderer/store/modules/karaoke.js')).default

  // A minimal Vuex context over the real karaoke module, so a command lands on the same
  // reducer the app runs (`karaokeAdd` → `addItem(..., payload?.requester ?? 'local')`).
  const state = store.state()
  const commit = (type, payload) => store.mutations[type](state, payload)
  const dispatch = (type, payload) => store.actions[type]({ state, commit }, payload)

  const karaokeActions = createKaraokeActions({ dispatch })

  const video = new EventTarget()
  Object.assign(video, { paused: true, currentTime: 0, duration: 100, volume: 1, muted: false, playbackRate: 1 })

  FakeSocket.instances = []
  const agent = createRemoteAgent({
    url: 'wss://nextcloud.taild1347f.ts.net:10000/remote/ws',
    deviceKey: 'device-key',
    getVideo: () => video,
    getMeta: () => ({ videoId: 'abc', title: 'T', channel: 'C', thumbnail: '' }),
    getActions: () => null,
    getKaraoke: () => state,
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

  // (a) opening publishes a dedicated queue frame...
  const openQueues = socket.sent.filter(m => m.t === 'queue')
  assert.equal(openQueues.length, 1, 'a {t:"queue"} frame is sent when the socket opens')
  assert.deepEqual(openQueues[0].karaoke.upcoming, [])

  // (b) ...and the 1 s state frame carries karaokeActive only — never the queue itself.
  const openState = socket.sent.find(m => m.t === 'state')
  assert.equal(openState.state.karaokeActive, false)
  assert.deepEqual(Object.keys(openState.state).sort(), STATE_FRAME_KEYS, 'the state frame carries karaokeActive and nothing queue-shaped')

  socket.sent.length = 0

  // (c) an inbound queueAdd carrying `from:'ph_x'` reaches the queue as requester 'ph_x'.
  socket.receive({ t: 'cmd', id: 40, cmd: 'queueAdd', videoId: 'aaaaaaaaaaa', title: 'From a phone', from: 'ph_x' })
  await flush()

  const added = state.items.find(item => item.videoId === 'aaaaaaaaaaa')
  assert.ok(added, 'the queueAdd command reached the queue')
  assert.equal(added.requester, 'ph_x')

  // The queue change pushed a fresh queue frame, and it is NOT inlined into the state frame.
  const queued = socket.sent.filter(m => m.t === 'queue')
  assert.equal(queued.length, 1, 'a queue frame rides the queue change')
  assert.deepEqual(queued[0].karaoke.upcoming.map(item => [item.videoId, item.requester]), [['aaaaaaaaaaa', 'ph_x']])
  const stateFrames = socket.sent.filter(m => m.t === 'state')
  assert.ok(stateFrames.length >= 1, 'a state frame still rides the command')
  for (const frame of stateFrames) {
    assert.deepEqual(Object.keys(frame.state).sort(), STATE_FRAME_KEYS, 'the state frame carries karaokeActive and nothing queue-shaped')
  }
  assert.ok(socket.sent.some(m => m.t === 'ack' && m.id === 40 && m.ok === true))

  // A phone that sends its own `requester` but no `from` gets the queue's own default — never its
  // own identity, never undefined.
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 41, cmd: 'queueAdd', videoId: 'bbbbbbbbbbb', title: 'No from', requester: 'ph_evil' })
  await flush()

  const second = state.items.find(item => item.videoId === 'bbbbbbbbbbb')
  assert.ok(second, 'the second queueAdd reached the queue')
  assert.equal(second.requester, 'local')
  assert.notEqual(second.requester, 'ph_evil')
  assert.notEqual(second.requester, undefined)

  const secondFrame = socket.sent.filter(m => m.t === 'queue').at(-1)
  assert.equal(secondFrame.karaoke.upcoming.find(item => item.videoId === 'bbbbbbbbbbb').requester, 'local')

  agent.stop()
})

// The bridge stamps its own command-correlation id (`id`) — a monotonic counter — onto every
// relayed command, next to `t`, `cmd` and `from`. None of those is a queue-item field, and `id`
// must never become a row id: rows are matched by id in remove/promote/move and keyed by id in the
// queue panel, so two phones whose commands share a counter value would collide. A row id is
// always the reducer's own generated value.
test('a phone-added row never takes the bridge command id as its row id', async () => {
  const { createRemoteAgent } = await load()
  const { createKaraokeActions } = await import('../src/renderer/remote/karaoke-actions.js')
  const store = (await import('../src/renderer/store/modules/karaoke.js')).default

  const state = store.state()
  const commit = (type, payload) => store.mutations[type](state, payload)
  const dispatch = (type, payload) => store.actions[type]({ state, commit }, payload)

  const video = new EventTarget()
  Object.assign(video, { paused: true, currentTime: 0, duration: 100, volume: 1, muted: false, playbackRate: 1 })

  FakeSocket.instances = []
  const agent = createRemoteAgent({
    url: 'wss://nextcloud.taild1347f.ts.net:10000/remote/ws',
    deviceKey: 'device-key',
    getVideo: () => video,
    getMeta: () => ({ videoId: 'abc', title: 'T', channel: 'C', thumbnail: '' }),
    getActions: () => null,
    getKaraoke: () => state,
    getKaraokeActions: () => createKaraokeActions({ dispatch }),
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

  // Two commands the bridge relayed with the SAME correlation id (it is the bridge's counter,
  // not anything the queue knows), both stamped `from`.
  socket.receive({ t: 'cmd', id: 7, cmd: 'queueAdd', videoId: 'aaaaaaaaaaa', title: 'A', from: 'ph_1' })
  await flush()
  socket.receive({ t: 'cmd', id: 7, cmd: 'queueAdd', videoId: 'bbbbbbbbbbb', title: 'B', from: 'ph_1' })
  await flush()

  const a = state.items.find(item => item.videoId === 'aaaaaaaaaaa')
  const b = state.items.find(item => item.videoId === 'bbbbbbbbbbb')

  assert.ok(a && b, 'both commands reached the queue')
  assert.notEqual(a.id, 7, 'the row id is the reducer-generated value, not the bridge command id')
  assert.notEqual(b.id, 7)
  assert.notEqual(a.id, b.id, 'two commands sharing one wire id still mint two distinct row ids')

  agent.stop()
})

// --- singer roster reaches the phone ------------------------------------------------
const loadRoster = () => import('../src/renderer/helpers/karaoke-roster.js')
const loadQueue = () => import('../src/renderer/helpers/karaoke-queue.js')
const loadActions = () => import('../src/renderer/remote/karaoke-actions.js')

test('a singer claim binds the bridge phone id to a roster row', async () => {
  const { createKaraokeActions } = await loadActions()
  const { createRoster, claimSinger } = await loadRoster()

  const store = {
    state: { singers: { roster: createRoster() } },
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
  const { createKaraokeActions } = await loadActions()
  const { createRoster, claimSinger } = await loadRoster()

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
  const { createKaraokeActions } = await loadActions()

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

test('the queue frame carries the roster but never inside the state frame', async () => {
  const { buildQueueFrame, buildState } = await load()
  const { createRoster, claimSinger } = await loadRoster()
  const { createQueue } = await loadQueue()

  const roster = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' }).roster
  const queue = { ...createQueue(), active: true }
  const frame = buildQueueFrame(queue, roster)
  // buildState reads the media element's fields, so it needs a real-shaped video, not null.
  const video = { duration: 0, currentTime: 0, paused: true, volume: 1, muted: false, playbackRate: 1 }
  const state = { ...buildState({ title: 'T', videoId: 'aaaaaaaaaaa' }, video, 0), karaokeActive: true }

  assert.equal(frame.singers.length, 1)
  assert.equal(frame.singers[0].name, 'Ada')
  assert.deepEqual(Object.keys(state).sort(), STATE_FRAME_KEYS)
})

test('a frame with no roster sends an empty singers list, not undefined', async () => {
  const { buildQueueFrame } = await load()
  const { createQueue } = await loadQueue()

  assert.deepEqual(buildQueueFrame({ ...createQueue(), active: true }, undefined).singers, [])
})

// The wire half of the roster: a claim relayed over the socket reaches the roster through the
// agent's REAL command routing (KARAOKE_COMMANDS) and the REAL action map, and the very next queue
// frame names the singer — not the phone — as the requester. The singers store action itself is not
// reachable here (it persists through nedb), so its dispatch is stood in by the pure helper; the
// karaoke reducer the add lands on is the real one.
test('a claim over the wire reaches the roster and names the singer on the queue frame', async () => {
  const { createRemoteAgent } = await load()
  const { createKaraokeActions } = await loadActions()
  const { createRoster, claimSinger } = await loadRoster()
  const karaokeStore = (await import('../src/renderer/store/modules/karaoke.js')).default

  const singers = { roster: createRoster() }
  const state = karaokeStore.state()
  const commit = (type, payload) => karaokeStore.mutations[type](state, payload)
  const dispatch = (type, payload) => {
    if (type === 'karaokeAdd') return karaokeStore.actions.karaokeAdd({ state, commit }, payload)
    if (type === 'singerClaim') {
      const { roster, singer, code } = claimSinger(singers.roster, payload)
      if (code === null) singers.roster = roster
      return { singer, code }
    }
    return null
  }
  const getters = {
    getSingerByPhone: phoneId => singers.roster.find(singer => singer.phoneId === phoneId) ?? null,
    getSingers: () => singers.roster
  }
  const karaokeActions = createKaraokeActions({ dispatch, getters })

  const video = new EventTarget()
  Object.assign(video, { paused: true, currentTime: 0, duration: 100, volume: 1, muted: false, playbackRate: 1 })

  FakeSocket.instances = []
  const agent = createRemoteAgent({
    url: 'wss://nextcloud.taild1347f.ts.net:10000/remote/ws',
    deviceKey: 'device-key',
    getVideo: () => video,
    getMeta: () => ({ videoId: 'abc', title: 'T', channel: 'C', thumbnail: '' }),
    getActions: () => null,
    getKaraoke: () => state,
    getKaraokeActions: () => karaokeActions,
    getSingers: () => singers.roster,
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

  socket.receive({ t: 'cmd', id: 5, cmd: 'singerClaim', name: 'Ada', from: 'ph_a' })
  await flush()

  assert.equal(singers.roster.length, 1, 'the claim reached the roster')
  assert.equal(singers.roster[0].phoneId, 'ph_a')
  assert.ok(socket.sent.some(m => m.t === 'ack' && m.id === 5 && m.ok === true), 'the claim is acked')

  const claimed = socket.sent.filter(m => m.t === 'queue').at(-1)
  assert.ok(claimed, 'a queue frame rides the claim')
  assert.deepEqual(claimed.karaoke.singers.map(singer => singer.name), ['Ada'])

  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 6, cmd: 'queueAdd', videoId: 'aaaaaaaaaaa', title: 'A', from: 'ph_a' })
  await flush()

  const added = state.items.find(item => item.videoId === 'aaaaaaaaaaa')
  assert.ok(added, 'the add reached the queue')
  assert.equal(added.requester, singers.roster[0].id, 'the claimed singer, not the phone, is the requester')
  assert.equal(added.singerId, singers.roster[0].id)
  assert.equal(socket.sent.filter(m => m.t === 'queue').at(-1).karaoke.upcoming.at(-1).singerId, singers.roster[0].id)

  agent.stop()
})
