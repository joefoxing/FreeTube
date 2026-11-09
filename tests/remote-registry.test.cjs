const { test } = require('node:test')
const assert = require('node:assert/strict')

test('qrUrl points at the bridge that issued the code', async () => {
  const { qrUrl } = await import('../src/renderer/remote/index.js')
  assert.equal(
    qrUrl('https://nextcloud.taild1347f.ts.net:10000/remote/#/pair?code=48291357', '48291357'),
    'https://nextcloud.taild1347f.ts.net:10000/remote/qr/48291357.svg'
  )
})

test('registering a player before start() is allowed and replayed on start', async () => {
  const registry = await import('../src/renderer/remote/index.js')
  const video = { paused: true, currentTime: 0, duration: 10, volume: 1, muted: false, playbackRate: 1 }
  registry.registerPlayer(video, () => ({ videoId: 'abc', title: 'T', channel: 'C', thumbnail: '' }))
  assert.equal(registry.status().enabled, false)
  registry.unregisterPlayer(video)
  assert.equal(registry.status().enabled, false)
})

test('stop() is idempotent and leaves no socket owned', async () => {
  const registry = await import('../src/renderer/remote/index.js')
  registry.stop()
  registry.stop()
  assert.deepEqual(registry.status(), { enabled: false, connected: false, pairing: null })
})
