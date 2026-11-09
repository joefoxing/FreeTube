const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/remote/agent.js')

class FakeVideo extends EventTarget {
  constructor(overrides = {}) {
    super()
    this.paused = true
    this.currentTime = 0
    this.duration = 754.2
    this.volume = 1
    this.muted = false
    this.playbackRate = 1
    this.playRejects = null
    Object.assign(this, overrides)
  }

  play() {
    if (this.playRejects) return Promise.reject(this.playRejects)
    this.paused = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }

  pause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
}

const meta = { videoId: 'arj7oStGLkU', title: 'Inside the mind', channel: 'TED', thumbnail: 'https://i/1.jpg' }

test('buildState reads the element, not the app', async () => {
  const { buildState } = await load()
  const video = new FakeVideo({ currentTime: 123.4, paused: false })
  assert.deepEqual(buildState(meta, video, 1762700000000), {
    videoId: 'arj7oStGLkU',
    title: 'Inside the mind',
    channel: 'TED',
    thumbnail: 'https://i/1.jpg',
    duration: 754.2,
    position: 123.4,
    playing: true,
    volume: 1,
    muted: false,
    rate: 1,
    at: 1762700000000,
  })
})

test('buildState reports an unknown duration as null, never NaN', async () => {
  const { buildState } = await load()
  assert.equal(buildState(meta, new FakeVideo({ duration: NaN }), 1).duration, null)
})

test('seek clamps to the media bounds', async () => {
  const { applyCommand } = await load()
  const video = new FakeVideo()
  assert.equal(await applyCommand({ cmd: 'seek', to: 1e9 }, video), null)
  assert.equal(video.currentTime, 754.2)
  await applyCommand({ cmd: 'seekBy', by: -1e9 }, video)
  assert.equal(video.currentTime, 0)
})

test('volume and rate clamp to what a browser accepts', async () => {
  const { applyCommand } = await load()
  const video = new FakeVideo()
  await applyCommand({ cmd: 'volume', value: 5 }, video)
  assert.equal(video.volume, 1)
  await applyCommand({ cmd: 'volume', value: -2 }, video)
  assert.equal(video.volume, 0)
  await applyCommand({ cmd: 'rate', value: 99 }, video)
  assert.equal(video.playbackRate, 3)
  await applyCommand({ cmd: 'rate', value: 0.01 }, video)
  assert.equal(video.playbackRate, 0.25)
})

test('a rejected play() is E_NOT_ALLOWED and never claims playback', async () => {
  const { applyCommand } = await load()
  const error = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
  const video = new FakeVideo({ playRejects: error })
  assert.equal(await applyCommand({ cmd: 'play' }, video), 'E_NOT_ALLOWED')
  assert.equal(video.paused, true)
})

test('toggle plays when paused and pauses when playing', async () => {
  const { applyCommand } = await load()
  const video = new FakeVideo()
  assert.equal(await applyCommand({ cmd: 'toggle' }, video), null)
  assert.equal(video.paused, false)
  assert.equal(await applyCommand({ cmd: 'toggle' }, video), null)
  assert.equal(video.paused, true)
})

test('an unknown command changes nothing and says so', async () => {
  const { applyCommand } = await load()
  const video = new FakeVideo()
  assert.equal(await applyCommand({ cmd: 'selfDestruct' }, video), 'E_UNKNOWN_CMD')
  assert.equal(video.paused, true)
  assert.equal(video.currentTime, 0)
})

test('open navigates through the hash router', async () => {
  const { applyCommand } = await load()
  const calls = []
  const result = await applyCommand(
    { cmd: 'open', videoId: 'arj7oStGLkU' },
    new FakeVideo(),
    { navigate: id => calls.push(id) }
  )
  assert.equal(result, null)
  assert.deepEqual(calls, ['arj7oStGLkU'])
})

test('open refuses anything that is not a video id', async () => {
  const { applyCommand } = await load()
  const calls = []
  const result = await applyCommand(
    { cmd: 'open', videoId: 'https://evil.example/x' },
    new FakeVideo(),
    { navigate: id => calls.push(id) }
  )
  assert.equal(result, 'E_BAD_VIDEO_ID')
  assert.deepEqual(calls, [])
})

test('a device key is generated once and reused', async () => {
  const { getDeviceKey } = await load()
  const store = new Map()
  const localStorageImpl = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value)
  }
  const first = getDeviceKey(localStorageImpl)
  const second = getDeviceKey(localStorageImpl)
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(first, second)
})
