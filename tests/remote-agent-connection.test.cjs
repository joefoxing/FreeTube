const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/remote/agent.js')

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

function makeAgent(overrides = {}) {
  return load().then(({ createRemoteAgent }) =>
    createRemoteAgent({
      url: 'wss://nextcloud.taild1347f.ts.net:10000/remote/ws',
      deviceKey: 'device-key',
      getVideo: () => overrides.video ?? null,
      getMeta: () => ({ videoId: 'abc', title: 'T', channel: 'C', thumbnail: '' }),
      onPairCode: overrides.onPairCode ?? (() => {}),
      onStatus: overrides.onStatus ?? (() => {}),
      WebSocketImpl: FakeSocket,
      now: () => 1000,
      setTimeoutImpl: (fn, ms) => { overrides.timers?.push(ms); return 0 },
      clearTimeoutImpl: () => {},
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {},
      ...overrides
    })
  )
}

test('nothing secret goes in the URL', async () => {
  FakeSocket.instances = []
  const agent = await makeAgent()
  agent.start()
  assert.equal(FakeSocket.instances[0].url, 'wss://nextcloud.taild1347f.ts.net:10000/remote/ws')
  assert.equal(FakeSocket.instances[0].url.includes('key'), false)
})

test('the first frame after open is the auth frame', async () => {
  FakeSocket.instances = []
  const agent = await makeAgent()
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  assert.deepEqual(socket.sent[0], { t: 'auth', role: 'player', key: 'device-key' })
})

test('pair-code is handed to the caller with its public url', async () => {
  const seen = []
  const agent = await makeAgent({ onPairCode: (code, pairUrl) => seen.push([code, pairUrl]) })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.receive({ t: 'hello', playerId: 'p_1' })
  socket.receive({
    t: 'pair-code',
    code: '48291357',
    pairUrl: 'https://nextcloud.taild1347f.ts.net:10000/remote/#/pair?code=48291357'
  })
  assert.deepEqual(seen.at(-1), [
    '48291357',
    'https://nextcloud.taild1347f.ts.net:10000/remote/#/pair?code=48291357'
  ])
})

test('requestPairing sends pair-open, and cancelPairing sends pair-close', async () => {
  FakeSocket.instances = []
  const agent = await makeAgent()
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  agent.requestPairing()
  agent.cancelPairing()
  assert.deepEqual(socket.sent, [{ t: 'pair-open' }, { t: 'pair-close' }])
})

test('reconnect backoff follows the ladder and does not reset on failure', async () => {
  const timers = []
  const agent = await makeAgent({ timers })
  agent.start()
  for (let i = 0; i < 6; i += 1) FakeSocket.instances.at(-1).close()
  assert.deepEqual(timers, [1000, 2000, 5000, 10000, 30000, 30000])
})

test('one publish per media event carries the element state', async () => {
  FakeSocket.instances = []
  const video = new EventTarget()
  Object.assign(video, { paused: false, currentTime: 5, duration: 100, volume: 1, muted: false, playbackRate: 1 })
  const agent = await makeAgent({ video })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  video.dispatchEvent(new Event('play'))
  assert.equal(socket.sent.length, 1)
  assert.equal(socket.sent[0].t, 'state')
  assert.equal(socket.sent[0].state.position, 5)
  assert.equal(socket.sent[0].state.playing, true)
})

test('a command is applied and acked with the bridge id', async () => {
  const video = new EventTarget()
  Object.assign(video, {
    paused: true, currentTime: 10, duration: 100, volume: 1, muted: false, playbackRate: 1,
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true }
  })
  const agent = await makeAgent({ video })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 7, cmd: 'seekBy', by: 10 })
  await new Promise(resolve => setImmediate(resolve))
  const ack = socket.sent.find(m => m.t === 'ack')
  assert.deepEqual(ack, { t: 'ack', id: 7, ok: true })
  assert.equal(video.currentTime, 20)
})

test('a status callback fires when the socket opens and closes', async () => {
  FakeSocket.instances = []
  const seen = []
  const agent = await makeAgent({ onStatus: open => seen.push(open) })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.close()
  assert.deepEqual(seen, [true, false])
})

test('open works with no media element on screen', async () => {
  FakeSocket.instances = []
  const calls = []
  const agent = await makeAgent({ navigate: id => calls.push(id) })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 9, cmd: 'open', videoId: 'arj7oStGLkU' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['arj7oStGLkU'])
  assert.deepEqual(socket.sent.find(m => m.t === 'ack'), { t: 'ack', id: 9, ok: true })
})

test('open with a bad id navigates nowhere, with or without a media element', async () => {
  FakeSocket.instances = []
  const calls = []
  const agent = await makeAgent({ navigate: id => calls.push(id) })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 10, cmd: 'open', videoId: 'https://evil.example/x' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [])
  assert.deepEqual(socket.sent.find(m => m.t === 'ack'), {
    t: 'ack', id: 10, ok: false, code: 'E_BAD_VIDEO_ID'
  })
})

test('a playback command with no media element is still E_NO_PLAYER', async () => {
  FakeSocket.instances = []
  const agent = await makeAgent()
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 11, cmd: 'toggle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(socket.sent.find(m => m.t === 'ack'), {
    t: 'ack', id: 11, ok: false, code: 'E_NO_PLAYER'
  })
})

test('next and prev call the registered actions', async () => {
  FakeSocket.instances = []
  const calls = []
  const video = new EventTarget()
  Object.assign(video, { paused: true, currentTime: 0, duration: 100, volume: 1, muted: false, playbackRate: 1 })
  const agent = await makeAgent({
    video,
    getActions: () => ({ next: () => calls.push('next'), prev: () => calls.push('prev') })
  })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 20, cmd: 'next' })
  socket.receive({ t: 'cmd', id: 21, cmd: 'prev' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['next', 'prev'])
  assert.deepEqual(socket.sent.filter(m => m.t === 'ack'), [
    { t: 'ack', id: 20, ok: true },
    { t: 'ack', id: 21, ok: true }
  ])
})

test('next without a player element is E_NO_PLAYER', async () => {
  FakeSocket.instances = []
  const agent = await makeAgent()
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 22, cmd: 'next' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(socket.sent.find(m => m.t === 'ack'), {
    t: 'ack', id: 22, ok: false, code: 'E_NO_PLAYER'
  })
})
