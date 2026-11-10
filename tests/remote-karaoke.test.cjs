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
  const store = (await import('../src/renderer/store/modules/karaoke.js')).default

  // A minimal Vuex context over the real karaoke module, so a command lands on the same
  // reducer the app runs (`karaokeAdd` → `addItem(..., payload?.requester ?? 'local')`).
  const state = store.state()
  const commit = (type, payload) => store.mutations[type](state, payload)
  const dispatch = (type, payload) => store.actions[type]({ state, commit }, payload)

  // The action map the agent registers. `queueAdd` mirrors src/renderer/App.vue: identity comes
  // from the bridge's `from` only, and with no `from` it stays undefined so the reducer default wins.
  const karaokeActions = {
    karaokeSet: payload => dispatch('karaokeSetActive', Boolean(payload?.active)),
    queueAdd: payload => dispatch('karaokeAdd', { ...payload, requester: payload?.from }),
    queuePromote: payload => dispatch('karaokePromote', payload?.id),
    queueRemove: payload => dispatch('karaokeRemove', payload?.id),
    queueClear: () => dispatch('karaokeClear'),
    queueMove: payload => dispatch('karaokeMove', { id: payload?.id, toIndex: payload?.toIndex })
  }

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
  assert.equal('items' in openState.state, false)
  assert.equal('upcoming' in openState.state, false)
  assert.equal('karaoke' in openState.state, false)

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
    assert.equal('items' in frame.state, false)
    assert.equal('upcoming' in frame.state, false)
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
