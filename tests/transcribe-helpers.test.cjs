// tests/transcribe-helpers.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/helpers/transcript.js')

test('window is clamped at the start of the video', async () => {
  const { clampTranscriptWindow } = await load()

  assert.deepEqual(clampTranscriptWindow(30, 60, 180, 600), { start: 0, end: 210 })
})

test('window is clamped at the end of the video', async () => {
  const { clampTranscriptWindow } = await load()

  assert.deepEqual(clampTranscriptWindow(590, 60, 180, 600), { start: 530, end: 600 })
})

test('window keeps at least one second of audio', async () => {
  const { clampTranscriptWindow } = await load()

  // At the end of the video this is a normal clamped window: [600-60, 600+180]
  // clamped to [0, 600].
  assert.deepEqual(clampTranscriptWindow(600, 60, 180, 600), { start: 540, end: 600 })
  // Past the end it degrades to the last second of the video, never zero-length.
  assert.deepEqual(clampTranscriptWindow(900, 60, 180, 600), { start: 599, end: 600 })
})

test('window handles a zero or unknown duration', async () => {
  const { clampTranscriptWindow } = await load()

  assert.deepEqual(clampTranscriptWindow(30, 60, 180, 0), { start: 0, end: 0 })
  assert.deepEqual(clampTranscriptWindow(30, 60, 180, undefined), { start: 0, end: 0 })
  assert.deepEqual(clampTranscriptWindow(30, 60, 180, NaN), { start: 0, end: 0 })
})

test('timestamps format below and above an hour', async () => {
  const { formatTimestamp } = await load()

  assert.equal(formatTimestamp(0), '0:00')
  assert.equal(formatTimestamp(65.4), '1:05')
  assert.equal(formatTimestamp(3725), '1:02:05')
})

test('the copied transcript is plain text with no timestamps', async () => {
  const { formatTranscriptText } = await load()

  const text = formatTranscriptText([
    { start: 60.9, end: 66.5, text: 'Hello there' },
    { start: 66.5, end: 70, text: 'general kenobi' }
  ])

  assert.equal(text, 'Hello there\ngeneral kenobi')
})

test('an empty segment list formats to an empty string', async () => {
  const { formatTranscriptText } = await load()

  assert.equal(formatTranscriptText([]), '')
})

test('whitespace-only segments are skipped', async () => {
  const { formatTranscriptText } = await load()

  const text = formatTranscriptText([
    { start: 0, end: 1, text: '   ' },
    { start: 1, end: 2, text: 'Real line' },
    { start: 2, end: 3, text: '\n\t' }
  ])

  assert.equal(text, 'Real line')
})

test('service errors map to i18n keys with a fallback', async () => {
  const { mapTranscribeError } = await load()

  assert.equal(mapTranscribeError('E_FETCH_FAILED'), 'Video.Player.Transcribe.FetchAudioFailed')
  assert.equal(mapTranscribeError('E_SERVICE_UNREACHABLE'), 'Video.Player.Transcribe.ServiceUnreachable')
  assert.equal(mapTranscribeError('E_SOMETHING_NEW'), 'Video.Player.Transcribe.Failed')
})

test('copying prefers the async clipboard API when the origin has one', async () => {
  const { copyTextToClipboard } = await load()

  const written = []
  const clipboard = { writeText: async text => written.push(text) }

  assert.equal(await copyTextToClipboard('hello', { clipboard }), true)
  assert.deepEqual(written, ['hello'])
})

test('copying falls back to execCommand where navigator.clipboard does not exist', async () => {
  const { copyTextToClipboard } = await load()

  // The tailnet preview over plain HTTP: navigator.clipboard is undefined there
  // because the origin is not a secure context.
  const calls = []
  const documentRef = {
    body: {
      appendChild: node => {
        calls.push(['append', node.value])
        node.parentNode = documentRef.body
      },
      removeChild: () => calls.push(['remove'])
    },
    createElement: () => ({ style: {}, setAttribute: () => {}, select: () => calls.push(['select']), parentNode: null }),
    execCommand: command => {
      calls.push(['exec', command])
      return true
    }
  }

  assert.equal(await copyTextToClipboard('hello', { clipboard: undefined, documentRef }), true)
  // ...and the scratch textarea is taken back out of the document afterwards.
  assert.deepEqual(calls, [['append', 'hello'], ['select'], ['exec', 'copy'], ['remove']])
})

test('a refused execCommand is reported as a failure, not as success', async () => {
  const { copyTextToClipboard } = await load()

  const documentRef = {
    body: { appendChild: () => {} },
    createElement: () => ({ style: {}, setAttribute: () => {}, select: () => {}, parentNode: null }),
    execCommand: () => false
  }

  assert.equal(await copyTextToClipboard('hello', { clipboard: undefined, documentRef }), false)
})

test('a rejected async write still tries the legacy path', async () => {
  const { copyTextToClipboard } = await load()

  let legacyUsed = false
  const clipboard = {
    writeText: async () => {
      throw new Error('permission denied')
    }
  }
  const documentRef = {
    body: { appendChild: () => {} },
    createElement: () => ({ style: {}, setAttribute: () => {}, select: () => {}, parentNode: null }),
    execCommand: () => {
      legacyUsed = true
      return true
    }
  }

  assert.equal(await copyTextToClipboard('hello', { clipboard, documentRef }), true)
  assert.equal(legacyUsed, true)
})
