// tests/transcribe-constants.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

test('ipc channels exist', async () => {
  const { IpcChannels } = await import('../src/constants.js')

  assert.equal(IpcChannels.TRANSCRIBE_START, 'transcribe-start')
  assert.equal(IpcChannels.TRANSCRIBE_CANCEL, 'transcribe-cancel')
  assert.equal(IpcChannels.TRANSCRIBE_STATUS, 'transcribe-status')
})

test('shortcut does not collide with theatre mode', async () => {
  const { KeyboardShortcuts } = await import('../src/constants.js')
  const general = KeyboardShortcuts.VIDEO_PLAYER.GENERAL

  assert.equal(general.TRANSCRIBE, 'ctrl+t')
  assert.notEqual(general.TRANSCRIBE, general.THEATRE_MODE)
})

test('player icon glyph is registered', async () => {
  const { PlayerIcons } = await import('../src/constants.js')

  assert.equal(typeof PlayerIcons.TRANSCRIBE, 'string')
  assert.ok(PlayerIcons.TRANSCRIBE.length > 20)
})
