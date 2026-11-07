# FreeTube Transcribe — App Implementation Plan (Phase B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Transcribe action to the FreeTube player that asks the Phase A service for a transcript of `[t − 60 s, t + 180 s]` of the playing video and shows it in an overlay over the player, auto-copied to the clipboard.

**Architecture:** The renderer keeps owning settings and UI; the main process does all HTTP. A pure, electron-free client module in `src/main` speaks the service contract and is unit-testable against a stub server; a thin IPC module wires it to `ipcMain`. A new shaka player button (mirroring the screenshot button) dispatches an event the Watch page handles, and a new overlay component renders job progress and the transcript.

**Tech Stack:** Vue 3 (Options API for `Watch.js`, `<script setup>` for components), Vuex settings module (getters auto-generated from state keys), Electron IPC (`contextBridge` in `src/preload/interface.js`), webpack + eslint, Node 22's built-in test runner for unit tests (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-11-07-freetube-transcribe-design.md`
**Depends on:** Phase A service plan (`docs/superpowers/plans/2026-11-07-freetube-transcribe-service.md`). App tasks are testable against a stub service before Phase A lands, but the live verification tasks need the real one.

## Global Constraints

- Branch: work on `freetube-transcribe`. Never commit to `development`.
- No new npm dependencies. The app stays free of native modules and of any YouTube-fetching code (that lives in the service).
- App unit tests live in `/home/joefox/developer/freetube/tests/*.test.cjs` (outside `src/`, so eslint's `src/**` globs and webpack never see them). They use `node:test` + `node:assert/strict` and load application modules with **dynamic `import()`** inside the test body.
- Run them as `node --test "tests/**/*.test.cjs"` — a bare directory argument fails in Node 22 ("Cannot find module 'tests'"); globs and explicit paths work.
- Settings keys and their getters: adding `transcriptionServiceUrl`, `transcriptionToken`, `transcriptionSecondsBefore`, `transcriptionSecondsAfter` to `state` in `src/renderer/store/modules/settings.js` auto-generates `getTranscriptionServiceUrl`, `getTranscriptionToken`, ... and the `updateTranscription*` actions. No getter code to write.
- i18n: add strings to `static/locales/en-US.yaml` only.
- Window contract: `[t − 60 s, t + 180 s]`, clamped to `[0, duration]`; segments arrive in **absolute video seconds**.
- Every task ends with `pnpm run lint` clean and a commit.
- Desktop-only: the button and overlay stay hidden when `process.env.IS_ELECTRON` is false.

---

### Task B1: Channels, shortcut, icon, settings keys, strings

**Files:**
- Modify: `src/constants.js` (IpcChannels block; `VIDEO_PLAYER.GENERAL` shortcut block; `PlayerIcons` block)
- Modify: `src/renderer/store/modules/settings.js` (the `state` object, near `screenshotMode`/`screenshotFormat`)
- Modify: `static/locales/en-US.yaml` (`Video.Player` and `Settings.Player Settings` trees)
- Test: `tests/transcribe-constants.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `IpcChannels.TRANSCRIBE_START = 'transcribe-start'`, `IpcChannels.TRANSCRIBE_CANCEL = 'transcribe-cancel'`, `IpcChannels.TRANSCRIBE_STATUS = 'transcribe-status'`; `KeyboardShortcuts.VIDEO_PLAYER.GENERAL.TRANSCRIBE = 'ctrl+t'`; `PlayerIcons.TRANSCRIBE`; settings keys listed above.

- [ ] **Step 1: Write the failing constants test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/joefox/developer/freetube && node --test "tests/**/*.test.cjs"`
Expected: FAIL — `TRANSCRIBE_START` is `undefined`.

- [ ] **Step 3: Add the constants**

In `src/constants.js`, in the `IpcChannels` object (next to `GENERATE_PO_TOKEN: 'generate-po-token',`):

```js
  TRANSCRIBE_START: 'transcribe-start',
  TRANSCRIBE_CANCEL: 'transcribe-cancel',
  TRANSCRIBE_STATUS: 'transcribe-status',
```

In `KeyboardShortcuts.VIDEO_PLAYER.GENERAL` (after `TAKE_SCREENSHOT: 'u',`):

```js
      TRANSCRIBE: 'ctrl+t',
```

In the `PlayerIcons` object, add the `d` attribute of the Material Symbols `transcribe` glyph. Fetch it with:

```bash
curl -s https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded/transcribe/default/24px.svg | grep -o 'd="[^"]*"' | head -1
```

The value is 871 characters long and starts `M850-750q6-6 14.5-9.5T882-763q19 0 32 13t13 32q0 9-3.5 17.5T914-686...` — check both before pasting, so a truncated fetch cannot slip in. Then:

```js
  TRANSCRIBE: 'M850-750q6-6 14.5-9.5T882-763...',   // the full 871-char string
```

- [ ] **Step 4: Add the settings keys**

In `src/renderer/store/modules/settings.js`, in `state` next to `screenshotFormat: 'png',`:

```js
  transcriptionServiceUrl: '',
  transcriptionToken: '',
  transcriptionSecondsBefore: 60,
  transcriptionSecondsAfter: 180,
```

- [ ] **Step 5: Add the strings**

In `static/locales/en-US.yaml`, under `Video.Player:` (sibling of `Take Screenshot:`):

```yaml
      Transcribe:
        Transcribe: Transcribe this video
        Transcribing: Transcribing…
        Fetching audio: Fetching audio…
        Decoding audio: Preparing audio…
        Copy Transcript: Copy Transcript
        Copied: Transcript copied to clipboard
        Copy Failed: Transcript is shown, but copying to the clipboard failed
        Close: Close
        Retry: Retry
        Cancel: Cancel
        Empty: No speech found in this section
        Busy: Already transcribing this video
        Window Clamped: Requested window was shortened to the service limit
        Not Configured: Set a transcription service URL in Settings → Player Settings
```

and under `Settings.Player Settings:`:

```yaml
    Transcript:
      Transcript: Transcript
      Service URL: Transcription service URL
      Service URL Description: Base URL of the transcription service, e.g. http://100.77.173.63:9099
      Token: Transcription service token
      Seconds Before: Seconds before the current position
      Seconds After: Seconds after the current position
```

Also add a tooltip entry under `Tooltips.Player Settings:` mirroring the Service URL description.

- [ ] **Step 6: Run the test and lint**

Run: `node --test "tests/**/*.test.cjs"` → PASS (3 passed)
Run: `pnpm run lint` → no errors

- [ ] **Step 7: Commit**

```bash
git add src/constants.js src/renderer/store/modules/settings.js static/locales/en-US.yaml tests/transcribe-constants.test.cjs
git commit -m "feat: transcribe ipc channels, shortcut, settings keys and strings"
```

---

### Task B2: Window math, text formatting, error mapping (pure helpers)

**Files:**
- Create: `src/renderer/helpers/transcript.js`
- Test: `tests/transcribe-helpers.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `clampTranscriptWindow(currentTime, secondsBefore, secondsAfter, duration) -> { start, end }` (integers, clamped to `[0, duration]`, `end > start` guaranteed by clamping to at least 1 s)
  - `formatTranscriptText(segments) -> string` (one line per segment, `[mm:ss] text`)
  - `formatTimestamp(seconds) -> string` (`m:ss`, or `h:mm:ss` past an hour)
  - `mapTranscribeError(code) -> i18n key` (maps `E_SERVICE_UNREACHABLE`, `E_UNAUTHORIZED`, `E_FETCH_FAILED`, `E_DECODE_FAILED`, `E_TRANSCRIBE_FAILED`, `E_TIMEOUT`, `E_BUSY`, `E_WINDOW_INVALID` to `Video.Player.Transcribe.*` keys, defaulting to a generic failure key)

- [ ] **Step 1: Write the failing helper tests**

```js
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

  assert.deepEqual(clampTranscriptWindow(600, 60, 180, 600), { start: 530, end: 600 })
})

test('timestamps format below and above an hour', async () => {
  const { formatTimestamp } = await load()

  assert.equal(formatTimestamp(0), '0:00')
  assert.equal(formatTimestamp(65.4), '1:05')
  assert.equal(formatTimestamp(3725), '1:02:05')
})

test('transcript text is one timestamped line per segment', async () => {
  const { formatTranscriptText } = await load()

  const text = formatTranscriptText([
    { start: 60.9, end: 66.5, text: 'Hello there' },
    { start: 66.5, end: 70, text: 'general kenobi' }
  ])

  assert.equal(text, '[1:00] Hello there\n[1:06] general kenobi')
})

test('service errors map to i18n keys with a fallback', async () => {
  const { mapTranscribeError } = await load()

  assert.equal(mapTranscribeError('E_FETCH_FAILED'), 'Video.Player.Transcribe.FetchAudioFailed')
  assert.equal(mapTranscribeError('E_SERVICE_UNREACHABLE'), 'Video.Player.Transcribe.ServiceUnreachable')
  assert.equal(mapTranscribeError('E_SOMETHING_NEW'), 'Video.Player.Transcribe.Failed')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test "tests/**/*.test.cjs"`
Expected: FAIL — `Cannot find module '../src/renderer/helpers/transcript.js'`

- [ ] **Step 3: Implement the helpers**

```js
// src/renderer/helpers/transcript.js

/**
 * @param {number} currentTime
 * @param {number} secondsBefore
 * @param {number} secondsAfter
 * @param {number} duration
 * @returns {{ start: number, end: number }}
 */
export function clampTranscriptWindow(currentTime, secondsBefore, secondsAfter, duration) {
  const maxDuration = Math.max(0, Math.floor(duration))
  const start = Math.max(0, Math.floor(currentTime - secondsBefore))
  const end = Math.min(maxDuration, Math.ceil(currentTime + secondsAfter))

  // A window of zero length is rejected by the service; a video shorter than the
  // requested window still gets whatever exists, down to one second.
  if (end - start < 1) {
    return { start: Math.max(0, maxDuration - 1), end: maxDuration }
  }

  return { start, end }
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/**
 * @param {{ start: number, end: number, text: string }[]} segments
 * @returns {string}
 */
export function formatTranscriptText(segments) {
  return segments
    .map(segment => `[${formatTimestamp(segment.start)}] ${segment.text}`)
    .join('\n')
}

const ERROR_KEYS = {
  E_SERVICE_UNREACHABLE: 'Video.Player.Transcribe.ServiceUnreachable',
  E_UNAUTHORIZED: 'Video.Player.Transcribe.Unauthorized',
  E_FETCH_FAILED: 'Video.Player.Transcribe.FetchAudioFailed',
  E_DECODE_FAILED: 'Video.Player.Transcribe.DecodeAudioFailed',
  E_TRANSCRIBE_FAILED: 'Video.Player.Transcribe.Failed',
  E_MODEL_FAILED: 'Video.Player.Transcribe.Failed',
  E_TIMEOUT: 'Video.Player.Transcribe.TimedOut',
  E_BUSY: 'Video.Player.Transcribe.Busy',
  E_WINDOW_INVALID: 'Video.Player.Transcribe.WindowInvalid'
}

/**
 * @param {string} code
 * @returns {string}
 */
export function mapTranscribeError(code) {
  return ERROR_KEYS[code] ?? 'Video.Player.Transcribe.Failed'
}
```

Add the five extra error strings to `static/locales/en-US.yaml` under `Video.Player.Transcribe` (same commit):

```yaml
        Failed: Transcription failed
        ServiceUnreachable: Transcription service is not reachable
        Unauthorized: The transcription service rejected the token
        FetchAudioFailed: Could not fetch the audio for this section
        DecodeAudioFailed: Could not prepare the fetched audio
        TimedOut: Transcription timed out
        WindowInvalid: That section of the video cannot be transcribed
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "tests/**/*.test.cjs"`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/helpers/transcript.js tests/transcribe-helpers.test.cjs static/locales/en-US.yaml
git commit -m "feat: transcript window, formatting and error-mapping helpers"
```

---

### Task B3: Main-process service client (no electron imports)

**Files:**
- Create: `src/main/transcribeClient.js`
- Test: `tests/transcribe-client.test.cjs`

**Interfaces:**
- Consumes: the Phase A HTTP contract.
- Produces: `createTranscribeClient({ fetchImpl = globalThis.fetch, sleep = defaultSleep })` returning:
  - `startJob({ serviceUrl, token, videoId, startSeconds, endSeconds }, { signal }) -> Promise<{ jobId, startSeconds, endSeconds }>`
  - `waitForJob({ serviceUrl, token, jobId }, { onUpdate, signal, pollIntervalMs = 1000, fetchTimeoutMs = 120000, transcribeTimeoutMs = 240000 }) -> Promise<jobView>`
  - `cancelJob({ serviceUrl, token, jobId }) -> Promise<void>` (never throws)
  - error rejection shape: `Error` with `.code` and `.message`

- [ ] **Step 1: Write the failing client tests against a stub server**

```js
// tests/transcribe-client.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const load = () => import('../src/main/transcribeClient.js')

function startStub(handler) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => handler(req, res, body ? JSON.parse(body) : null))
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('startJob posts a camelCase body with the bearer token', async () => {
  const seen = {}

  const { server, url } = await startStub((req, res, body) => {
    seen.method = req.method
    seen.path = req.url
    seen.auth = req.headers.authorization
    seen.body = body
    json(res, 201, { jobId: 'j1', state: 'queued', startSeconds: 60, endSeconds: 300 })
  })

  const { createTranscribeClient } = await load()
  const client = createTranscribeClient()

  const job = await client.startJob({ serviceUrl: url, token: 'tok', videoId: 'abc', startSeconds: 60, endSeconds: 300 })

  assert.equal(job.jobId, 'j1')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.path, '/jobs')
  assert.equal(seen.auth, 'Bearer tok')
  assert.deepEqual(seen.body, { videoId: 'abc', startSeconds: 60, endSeconds: 300 })

  server.close()
})

test('waitForJob polls until done and reports stage updates', async () => {
  let polls = 0

  const { server, url } = await startStub((req, res) => {
    polls += 1
    if (polls === 1) {
      json(res, 200, { jobId: 'j1', state: 'running', stage: 'fetching', progress: 0.45 })
    } else {
      json(res, 200, {
        jobId: 'j1',
        state: 'done',
        stage: 'transcribing',
        progress: 1,
        language: 'en',
        segments: [{ start: 60, end: 62, text: 'hi' }]
      })
    }
  })

  const { createTranscribeClient } = await load()
  const client = createTranscribeClient({ sleep: () => Promise.resolve() })
  const stages = []

  const view = await client.waitForJob({ serviceUrl: url, token: 'tok', jobId: 'j1', onUpdate: v => stages.push(v.stage) })

  assert.deepEqual(stages, ['fetching', 'transcribing'])
  assert.equal(view.state, 'done')
  assert.equal(view.segments[0].text, 'hi')

  server.close()
})

test('http errors map to codes', async () => {
  const { server, url } = await startStub((req, res) => json(res, 401, { error: { code: 'E_UNAUTHORIZED', message: 'nope' } }))

  const { createTranscribeClient } = await load()
  const client = createTranscribeClient()

  await assert.rejects(
    () => client.startJob({ serviceUrl: url, token: 'bad', videoId: 'a', startSeconds: 0, endSeconds: 30 }),
    error => error.code === 'E_UNAUTHORIZED'
  )

  server.close()
})

test('an unreachable service maps to E_SERVICE_UNREACHABLE', async () => {
  const { createTranscribeClient } = await load()
  const client = createTranscribeClient()

  await assert.rejects(
    () => client.startJob({ serviceUrl: 'http://127.0.0.1:1', token: 't', videoId: 'a', startSeconds: 0, endSeconds: 30 }),
    error => error.code === 'E_SERVICE_UNREACHABLE'
  )
})

test('a job that never finishes maps to E_TIMEOUT', async () => {
  const { server, url } = await startStub((req, res) => json(res, 200, { jobId: 'j1', state: 'running', stage: 'fetching', progress: 0.1 }))

  const { createTranscribeClient } = await load()
  const client = createTranscribeClient({ sleep: () => Promise.resolve() })

  await assert.rejects(
    () => client.waitForJob({ serviceUrl: url, token: 't', jobId: 'j1', fetchTimeoutMs: 0, transcribeTimeoutMs: 0 }),
    error => error.code === 'E_TIMEOUT'
  )

  server.close()
})

test('cancelJob posts to the cancel route and swallows failures', async () => {
  const seen = []

  const { server, url } = await startStub((req, res) => {
    seen.push(req.url)
    json(res, 200, { jobId: 'j1', state: 'cancelled' })
  })

  const { createTranscribeClient } = await load()
  const client = createTranscribeClient()

  await client.cancelJob({ serviceUrl: url, token: 't', jobId: 'j1' })
  await client.cancelJob({ serviceUrl: 'http://127.0.0.1:1', token: 't', jobId: 'j1' })

  assert.deepEqual(seen, ['/jobs/j1/cancel'])

  server.close()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test "tests/**/*.test.cjs"`
Expected: FAIL — `Cannot find module '../src/main/transcribeClient.js'`

- [ ] **Step 3: Implement the client**

```js
// src/main/transcribeClient.js

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function transcribeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function createTranscribeClient({ fetchImpl = globalThis.fetch, sleep = defaultSleep } = {}) {
  /**
   * @param {string} serviceUrl
   * @param {string} token
   * @param {string} path
   * @param {{ method?: string, body?: object, fetchTimeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async function request(serviceUrl, token, path, { method = 'GET', body, fetchTimeoutMs = 15000, signal } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs)

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    let response
    try {
      response = await fetchImpl(joinUrl(serviceUrl, path), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
    } catch (error) {
      if (signal?.aborted) {
        throw transcribeError('E_CANCELLED', 'cancelled')
      }
      throw transcribeError('E_SERVICE_UNREACHABLE', `${serviceUrl}: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      const code = payload?.error?.code ?? payload?.detail?.code ?? (response.status === 401 ? 'E_UNAUTHORIZED' : 'E_TRANSCRIBE_FAILED')
      const message = payload?.error?.message ?? payload?.detail?.message ?? `HTTP ${response.status}`
      throw transcribeError(code, message)
    }

    return payload
  }

  return {
    /**
     * @param {{ serviceUrl: string, token: string, videoId: string, startSeconds: number, endSeconds: number, signal?: AbortSignal }} options
     */
    async startJob({ serviceUrl, token, videoId, startSeconds, endSeconds, signal }) {
      const payload = await request(serviceUrl, token, '/jobs', {
        method: 'POST',
        body: { videoId, startSeconds, endSeconds },
        signal
      })

      if (!payload?.jobId) {
        throw transcribeError('E_TRANSCRIBE_FAILED', 'service returned no job id')
      }

      return payload
    },

    /**
     * @param {{
     *   serviceUrl: string,
     *   token: string,
     *   jobId: string,
     *   onUpdate?: (view: object) => void,
     *   signal?: AbortSignal,
     *   pollIntervalMs?: number,
     *   fetchTimeoutMs?: number,
     *   transcribeTimeoutMs?: number
     * }} options
     */
    async waitForJob({
      serviceUrl,
      token,
      jobId,
      onUpdate,
      signal,
      pollIntervalMs = 1000,
      fetchTimeoutMs = 120000,
      transcribeTimeoutMs = 240000
    }) {
      const startedAt = Date.now()

      for (;;) {
        const view = await request(serviceUrl, token, `/jobs/${jobId}`, { signal })

        onUpdate?.(view)

        if (view.state === 'done' || view.state === 'error' || view.state === 'cancelled') {
          return view
        }

        const elapsed = Date.now() - startedAt
        const budget = view.stage === 'transcribing' ? fetchTimeoutMs + transcribeTimeoutMs : fetchTimeoutMs
        if (elapsed > budget) {
          throw transcribeError('E_TIMEOUT', `job ${jobId} exceeded its ${Math.round(budget / 1000)}s budget`)
        }

        if (signal?.aborted) {
          throw transcribeError('E_CANCELLED', 'cancelled')
        }

        await sleep(pollIntervalMs)
      }
    },

    /**
     * @param {{ serviceUrl: string, token: string, jobId: string }} options
     */
    async cancelJob({ serviceUrl, token, jobId }) {
      try {
        await request(serviceUrl, token, `/jobs/${jobId}/cancel`, { method: 'POST', fetchTimeoutMs: 5000 })
      } catch {
        // cancellation is best effort: the job may already be gone
      }
    }
  }
}
```

Note the timeout budget is deliberate: a job still in `fetching`/`decoding` gets
only `fetchTimeoutMs` (120 s), and once it reports `transcribing` the budget
grows to `fetchTimeoutMs + transcribeTimeoutMs` (360 s), so a slow fetch and a
slow transcription cannot borrow from each other.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "tests/**/*.test.cjs"`
Expected: PASS (15 passed)

- [ ] **Step 5: Commit**

```bash
git add src/main/transcribeClient.js tests/transcribe-client.test.cjs
git commit -m "feat: electron-free transcribe service client with polling, timeout and cancel"
```

---

### Task B4: IPC wiring (main + preload)

**Files:**
- Create: `src/main/transcribeIpc.js`
- Modify: `src/main/index.js` (import + registration call)
- Modify: `src/preload/interface.js` (three methods)
- Test: live CDP check (no unit test — this file's job is wiring electron APIs)

**Interfaces:**
- Consumes: `createTranscribeClient`, `IpcChannels`.
- Produces: `registerTranscribeIpc({ ipcMain, client })` registering `TRANSCRIBE_START` (invoke → `{ jobId, startSeconds, endSeconds, view }` after completion, rejecting with `{ code, message }`), `TRANSCRIBE_CANCEL` (send), and emitting `TRANSCRIBE_STATUS` to the calling webContents with the latest view; renderer API `window.ftElectron.transcribeStart(payload)`, `transcribeCancel(jobId)`, `onTranscribeStatus(handler)`.

- [ ] **Step 1: Implement the IPC module**

```js
// src/main/transcribeIpc.js
import { IpcChannels } from '../constants'
import { createTranscribeClient } from './transcribeClient'

/** @type {Map<string, AbortController>} */
const activeJobs = new Map()

/**
 * @param {{ ipcMain: import('electron').IpcMain, client?: ReturnType<typeof createTranscribeClient> }} options
 */
export function registerTranscribeIpc({ ipcMain, client = createTranscribeClient() }) {
  ipcMain.handle(IpcChannels.TRANSCRIBE_START, async (event, payload) => {
    const { videoId, startSeconds, endSeconds, serviceUrl, token } = payload ?? {}

    if (!serviceUrl) {
      throw { code: 'E_WINDOW_INVALID', message: 'no transcription service configured' }
    }
    if (activeJobs.size > 0) {
      throw { code: 'E_BUSY', message: 'a transcription is already running' }
    }

    const controller = new AbortController()
    let jobId = null

    const send = view => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannels.TRANSCRIBE_STATUS, view)
      }
    }

    try {
      const job = await client.startJob({ serviceUrl, token, videoId, startSeconds, endSeconds, signal: controller.signal })
      jobId = job.jobId
      activeJobs.set(jobId, controller)

      const view = await client.waitForJob({
        serviceUrl,
        token,
        jobId,
        onUpdate: send,
        signal: controller.signal
      })

      return { jobId, startSeconds, endSeconds, view }
    } catch (error) {
      const code = error.code ?? 'E_TRANSCRIBE_FAILED'
      send({ jobId, state: 'error', stage: 'error', progress: 0, error: { code, message: error.message } })
      throw { code, message: error.message }
    } finally {
      if (jobId !== null) {
        activeJobs.delete(jobId)
      }
    }
  })

  ipcMain.on(IpcChannels.TRANSCRIBE_CANCEL, (_event, requestedJobId) => {
    for (const [jobId, controller] of activeJobs) {
      if (requestedJobId === undefined || requestedJobId === null || requestedJobId === jobId) {
        controller.abort()
        activeJobs.delete(jobId)
      }
    }
  })
}
```

Semantics: one job in flight per app instance; `TRANSCRIBE_START` resolves only
when the job reaches a terminal state, and every poll's view is pushed to the
renderer as a `TRANSCRIBE_STATUS` event; a cancel aborts the in-flight job's
signal (which the polling loop and the fetch both observe).

- [ ] **Step 2: Register it in the main process**

In `src/main/index.js`, add to the imports (next to `import { extractExpiryTimestamp, ImageCache } from './ImageCache'`):

```js
import { registerTranscribeIpc } from './transcribeIpc'
```

and immediately after the last `ipcMain.handle(...)` registration block (the one closing out `ipcMain.handle(IpcChannels.DB_SUBSCRIPTION_CACHE, ...)`), add:

```js
registerTranscribeIpc({ ipcMain })
```

- [ ] **Step 3: Add the preload methods**

In `src/preload/interface.js`, inside the exported object (next to `writeToDefaultFolder`):

```js
  /**
   * @param {{ videoId: string, startSeconds: number, endSeconds: number, serviceUrl: string, token: string }} payload
   * @returns {Promise<{ jobId: string, startSeconds: number, endSeconds: number, view: object }>}
   */
  transcribeStart: (payload) => {
    return ipcRenderer.invoke(IpcChannels.TRANSCRIBE_START, payload)
  },

  /**
   * @param {string} [jobId]
   */
  transcribeCancel: (jobId) => {
    ipcRenderer.send(IpcChannels.TRANSCRIBE_CANCEL, jobId)
  },

  /**
   * @param {(view: object) => void} handler
   */
  onTranscribeStatus: (handler) => {
    ipcRenderer.on(IpcChannels.TRANSCRIBE_STATUS, (_, view) => {
      handler(view)
    })
  },
```

- [ ] **Step 4: Verify live that the IPC round trip works**

Start a stub service and the app, then drive it from the renderer over CDP (the same technique the spec's verification section uses):

```bash
cd /home/joefox/developer/freetube
node -e "
const http=require('http');
http.createServer((req,res)=>{
  if(req.url==='/jobs'){res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({jobId:'stub1',state:'queued',startSeconds:0,endSeconds:30}));return}
  if(req.url==='/jobs/stub1'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jobId:'stub1',state:'done',stage:'transcribing',progress:1,language:'en',segments:[{start:5,end:7,text:'stub transcript'}]}));return}
  res.writeHead(404);res.end('{}')
}).listen(9098,'127.0.0.1',()=>console.log('stub on 9098'))
" &
```

Then in the running dev app (started as `pnpm run dev --remote-debug` under Xvfb), evaluate in the renderer:

```js
await window.ftElectron.transcribeStart({ videoId: 'abc', startSeconds: 0, endSeconds: 30, serviceUrl: 'http://127.0.0.1:9098', token: 't' })
```

Expected: a resolved object whose `view.segments[0].text === 'stub transcript'`, and a `transcribe-status` event received by a handler registered with `onTranscribeStatus`.

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/transcribeIpc.js src/main/index.js src/preload/interface.js
git commit -m "feat: transcribe IPC channels in main and preload"
```

---

### Task B5: The player button

**Files:**
- Create: `src/renderer/components/ft-shaka-video-player/player-components/TranscribeButton.js`
- Modify: `src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js` (emits array; a `registerTranscribeButton()` next to `registerScreenshotButton()`; its call site; a `keyboardShortcutHandler` case)
- Test: live DOM check

**Interfaces:**
- Consumes: `PlayerIcons.TRANSCRIBE`, `KeyboardShortcuts.VIDEO_PLAYER.GENERAL.TRANSCRIBE`, store getter `getTranscriptionServiceUrl`.
- Produces: a `transcribe` CustomEvent from the player's events bus, re-emitted by the component as the Vue event `transcribe`; the button node carries the class `transcribe-button`.

- [ ] **Step 1: Implement the button component**

```js
// src/renderer/components/ft-shaka-video-player/player-components/TranscribeButton.js
import shaka from 'shaka-player'

import i18n from '../../../i18n/index'
import { KeyboardShortcuts, PlayerIcons } from '../../../../constants'
import { addKeyboardShortcutToActionTitle } from '../../../helpers/utils'

export class TranscribeButton extends shaka.ui.Element {
  /**
   * @param {boolean} enabled
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(enabled, events, parent, controls) {
    super(parent, controls)

    /** @private */
    this.enabled_ = enabled

    /** @private */
    this.button_ = document.createElement('button')
    this.button_.classList.add('transcribe-button', 'shaka-tooltip')

    // eslint-disable-next-line no-new
    new shaka.ui.Icon(this.button_, PlayerIcons.TRANSCRIBE)

    const label = document.createElement('label')
    label.classList.add(
      'shaka-overflow-button-label',
      'shaka-overflow-menu-only',
      'shaka-simple-overflow-button-label-inline'
    )

    /** @private */
    this.nameSpan_ = document.createElement('span')
    label.appendChild(this.nameSpan_)

    this.button_.appendChild(label)

    this.parent.appendChild(this.button_)

    this.eventManager.listen(this.button_, 'click', () => {
      if (this.enabled_) {
        events.dispatchEvent(new CustomEvent('transcribe'))
      }
    })

    this.eventManager.listen(events, 'localeChanged', () => {
      this.updateLocalisedStrings_()
    })

    this.updateLocalisedStrings_()
    this.checkAvailability()
  }

  /** @private */
  updateLocalisedStrings_() {
    const label = addKeyboardShortcutToActionTitle(
      i18n.global.t('Video.Player.Transcribe.Transcribe'),
      KeyboardShortcuts.VIDEO_PLAYER.GENERAL.TRANSCRIBE
    )
    this.nameSpan_.textContent = this.button_.ariaLabel = label
  }

  /** @override */
  checkAvailability() {
    // No IPC layer (web build) or no service configured means no button at all.
    if (!this.enabled_ || this.isSubMenuOpened) {
      this.button_.classList.add('shaka-hidden')
    } else {
      this.button_.classList.remove('shaka-hidden')
    }
  }
}
```

- [ ] **Step 2: Register it in the player**

In `ft-shaka-video-player.js`:

1. Import next to the other player components:
```js
import { TranscribeButton } from './player-components/TranscribeButton'
```
2. Add `'transcribe',` to the `emits` array (after `'player-reload-requested',`).
3. Add the registration function next to `registerScreenshotButton()`:
```js
    function registerTranscribeButton() {
      events.addEventListener('transcribe', () => {
        emit('transcribe')
      })

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class TranscribeButtonFactory {
        create(rootElement, controls) {
          return new TranscribeButton(props.transcribeEnabled, events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_transcribe', new TranscribeButtonFactory())
      shakaOverflowMenu.registerElement('ft_transcribe', new TranscribeButtonFactory())
    }
```
4. Call `registerTranscribeButton()` in the same place `registerScreenshotButton()` is called.
5. Add the keyboard case next to the `TAKE_SCREENSHOT` case in `keyboardShortcutHandler`:
```js
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.TRANSCRIBE:
          if (props.transcribeEnabled) {
            event.preventDefault()
            events.dispatchEvent(new CustomEvent('transcribe'))
          }
          blurTooltipButtons()
          break
```
6. Add the prop:
```js
    transcribeEnabled: {
      type: Boolean,
      default: false
    },
```

- [ ] **Step 3: Pass the prop from the Watch page**

In `src/renderer/views/Watch/Watch.vue`, on the `<ft-shaka-video-player>` element (next to `:sabr-data="sabrData"`):

```html
          :transcribe-enabled="transcribeEnabled"
```

and in `src/renderer/views/Watch/Watch.js`, add to `computed`:

```js
    transcribeEnabled: function () {
      return process.env.IS_ELECTRON === true && this.transcriptionServiceUrl !== ''
    },

    transcriptionServiceUrl: function () {
      return this.$store.getters.getTranscriptionServiceUrl
    },
```

- [ ] **Step 4: Verify the button is live in the running app**

With the dev app running and a service URL configured in settings (Task B7) or by setting the store directly in the page:

```js
window.ftElectron && document.querySelectorAll('.transcribe-button').length
```

Expected: `1` (and its label reads "Transcribe this video (ctrl+t)").

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/renderer/components/ft-shaka-video-player src/renderer/views/Watch
git commit -m "feat: transcribe button in the player control bar with ctrl+t shortcut"
```

---

### Task B6: The overlay, the Watch wiring, and auto-copy

**Files:**
- Create: `src/renderer/components/FtTranscript/FtTranscript.vue`
- Create: `src/renderer/components/FtTranscript/FtTranscript.css`
- Modify: `src/renderer/views/Watch/Watch.vue` (overlay inside `.videoAreaMargin`; import)
- Modify: `src/renderer/views/Watch/Watch.js` (state, handlers, subscription, teardown)
- Test: live end-to-end

**Interfaces:**
- Consumes: `window.ftElectron.transcribeStart/transcribeCancel/onTranscribeStatus`, helpers from Task B2.
- Produces: `<FtTranscript>` props `{ visible, state, stage, progress, segments, errorCode, windowStart, windowEnd }`, events `close`, `retry`, `cancel`, `seek`; Watch.js method `handleTranscribe()`; `handleTranscribeStatus(view)`; `handleTranscribeSeek(seconds)`.

- [ ] **Step 1: Implement the overlay component**

```vue
<!-- src/renderer/components/FtTranscript/FtTranscript.vue -->
<template>
  <div
    v-if="visible"
    class="transcriptOverlay"
  >
    <div class="transcriptHeader">
      <span class="transcriptTitle">
        {{ t('Video.Player.Transcribe.Transcribe') }}
      </span>
      <span class="transcriptWindow">
        {{ windowLabel }}
      </span>
      <FtIconButton
        :title="t('Video.Player.Transcribe.Close')"
        :icon="['fas', 'xmark']"
        theme="base"
        @click="$emit('close')"
      />
    </div>

    <div
      v-if="isBusy"
      class="transcriptBusy"
    >
      <FtLoader :fullscreen="false" />
      <p class="transcriptStage">
        {{ stageLabel }}<span v-if="progress > 0"> · {{ Math.round(progress * 100) }}%</span>
      </p>
      <FtButton
        :label="t('Video.Player.Transcribe.Cancel')"
        @click="$emit('cancel')"
      />
    </div>

    <div
      v-else-if="state === 'error'"
      class="transcriptError"
    >
      <p>{{ t(mapTranscribeError(errorCode)) }}</p>
      <FtButton
        :label="t('Video.Player.Transcribe.Retry')"
        @click="$emit('retry')"
      />
    </div>

    <template v-else>
      <div class="transcriptBody">
        <p
          v-if="segments.length === 0"
          class="transcriptEmpty"
        >
          {{ t('Video.Player.Transcribe.Empty') }}
        </p>
        <button
          v-for="segment in segments"
          :key="`${segment.start}-${segment.end}`"
          class="transcriptLine"
          @click="$emit('seek', segment.start)"
        >
          <span class="transcriptLineTime">{{ formatTimestamp(segment.start) }}</span>
          <span class="transcriptLineText">{{ segment.text }}</span>
        </button>
      </div>
      <div class="transcriptFooter">
        <FtButton
          :label="copied ? t('Video.Player.Transcribe.Copied') : t('Video.Player.Transcribe.Copy Transcript')"
          @click="$emit('copy')"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtLoader from '../FtLoader/FtLoader.vue'

import { formatTimestamp, mapTranscribeError } from '../../helpers/transcript'

const props = defineProps({
  visible: { type: Boolean, default: false },
  state: { type: String, default: 'idle' },
  stage: { type: String, default: 'queued' },
  progress: { type: Number, default: 0 },
  segments: { type: Array, default: () => [] },
  errorCode: { type: String, default: '' },
  windowStart: { type: Number, default: 0 },
  windowEnd: { type: Number, default: 0 },
  copied: { type: Boolean, default: false }
})

defineEmits(['close', 'retry', 'cancel', 'copy', 'seek'])

const { t } = useI18n()

const isBusy = computed(() => props.state === 'queued' || props.state === 'running')

const stageLabel = computed(() => {
  switch (props.stage) {
    case 'fetching':
      return t('Video.Player.Transcribe.Fetching audio')
    case 'decoding':
      return t('Video.Player.Transcribe.Decoding audio')
    case 'transcribing':
      return t('Video.Player.Transcribe.Transcribing')
    default:
      return t('Video.Player.Transcribe.Transcribing')
  }
})

const windowLabel = computed(() => `${formatTimestamp(props.windowStart)} – ${formatTimestamp(props.windowEnd)}`)
</script>

<style scoped src="./FtTranscript.css" />
```

The CSS mirrors the player's existing overlay styling: absolutely positioned inside the player container, right-anchored, `max-height: 60%`, scrollable body, semi-transparent background using the theme variables already used in `ft-shaka-video-player.css`.

- [ ] **Step 2: Mount it in the Watch page**

In `src/renderer/views/Watch/Watch.vue`, inside `.videoAreaMargin` directly after the closing tag of the `<ft-shaka-video-player>` block's wrapper element:

```html
        <ft-transcript
          :visible="transcriptVisible"
          :state="transcriptState"
          :stage="transcriptStage"
          :progress="transcriptProgress"
          :segments="transcriptSegments"
          :error-code="transcriptErrorCode"
          :window-start="transcriptWindow.start"
          :window-end="transcriptWindow.end"
          :copied="transcriptCopied"
          @close="closeTranscript"
          @cancel="cancelTranscribe"
          @retry="handleTranscribe"
          @copy="copyTranscript"
          @seek="handleTranscribeSeek"
        />
```

Import and register it next to `ft-shaka-video-player` in the component's `components` block, following the local `Watcher`-style naming already used there (`ft-transcript` → `FtTranscript`).

- [ ] **Step 3: Wire the state and handlers in Watch.js**

Add to `data()`:

```js
      transcriptVisible: false,
      transcriptState: 'idle',
      transcriptStage: 'queued',
      transcriptProgress: 0,
      transcriptSegments: [],
      transcriptWindow: { start: 0, end: 0 },
      transcriptErrorCode: '',
      transcriptCopied: false,
      transcriptJobId: null,
```

Add to `methods`:

```js
    handleTranscribe: async function () {
      if (!this.transcribeEnabled) {
        showToast(this.t('Video.Player.Transcribe.Not Configured'))
        return
      }

      if (this.transcriptState === 'queued' || this.transcriptState === 'running') {
        showToast(this.t('Video.Player.Transcribe.Busy'))
        return
      }

      const currentTime = this.$refs.player.getCurrentTime()
      const secondsBefore = this.$store.getters.getTranscriptionSecondsBefore
      const secondsAfter = this.$store.getters.getTranscriptionSecondsAfter
      const window_ = clampTranscriptWindow(currentTime, secondsBefore, secondsAfter, this.videoLengthSeconds)

      this.transcriptVisible = true
      this.transcriptState = 'queued'
      this.transcriptStage = 'queued'
      this.transcriptProgress = 0
      this.transcriptSegments = []
      this.transcriptErrorCode = ''
      this.transcriptCopied = false
      this.transcriptWindow = window_

      try {
        const result = await window.ftElectron.transcribeStart({
          videoId: this.videoId,
          startSeconds: window_.start,
          endSeconds: window_.end,
          serviceUrl: this.transcriptionServiceUrl,
          token: this.$store.getters.getTranscriptionToken
        })

        this.transcriptJobId = result.jobId
        this.handleTranscribeResult(result.view)
      } catch (error) {
        this.transcriptState = 'error'
        this.transcriptErrorCode = error?.code ?? 'E_TRANSCRIBE_FAILED'
      }
    },

    handleTranscribeStatus: function (view) {
      if (view?.jobId) {
        this.transcriptJobId = view.jobId
      }

      this.transcriptState = view.state
      this.transcriptStage = view.stage
      this.transcriptProgress = view.progress
    },

    handleTranscribeResult: function (view) {
      if (view.state === 'done') {
        this.transcriptSegments = view.segments
        this.transcriptState = 'done'
        this.copyTranscript()
        return
      }

      this.transcriptState = 'error'
      this.transcriptErrorCode = view.error?.code ?? 'E_TRANSCRIBE_FAILED'
    },

    copyTranscript: async function () {
      try {
        await navigator.clipboard.writeText(formatTranscriptText(this.transcriptSegments))
        this.transcriptCopied = true
        showToast(this.t('Video.Player.Transcribe.Copied'))
      } catch {
        this.transcriptCopied = false
        showToast(this.t('Video.Player.Transcribe.Copy Failed'), 5000)
      }
    },

    handleTranscribeSeek: function (seconds) {
      this.$refs.player.setCurrentTime(seconds)
    },

    cancelTranscribe: function () {
      window.ftElectron.transcribeCancel(this.transcriptJobId)
      this.transcriptState = 'cancelled'
      this.transcriptVisible = false
    },

    closeTranscript: function () {
      if (this.transcriptState === 'queued' || this.transcriptState === 'running') {
        this.cancelTranscribe()
        return
      }

      this.transcriptVisible = false
    },
```

Add to `mounted()` (where other `ftElectron` subscriptions are registered):

```js
      if (process.env.IS_ELECTRON) {
        window.ftElectron.onTranscribeStatus(this.handleTranscribeStatus)
      }
```

Add a watcher to cancel an in-flight job when the video changes, next to the existing `videoId` watcher:

```js
    videoId: function () {
      if (this.transcriptState === 'queued' || this.transcriptState === 'running') {
        this.cancelTranscribe()
      }

      this.transcriptVisible = false
      this.transcriptState = 'idle'
      this.transcriptSegments = []
    },
```

Add the imports at the top of `Watch.js`:

```js
import { clampTranscriptWindow, formatTranscriptText } from '../../helpers/transcript'
```

- [ ] **Step 4: Verify live, end to end**

With the real Phase A service running, in the dev app: open a video, seek to ~2 minutes, click Transcribe (or press `ctrl+t`). Expected: the overlay opens showing "Fetching audio…" then "Transcribing…", then ~40 timestamped lines; a toast says the transcript was copied; `navigator.clipboard.readText()` in the page returns the same text; clicking a line seeks the player; the video never paused.

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/renderer/components/FtTranscript src/renderer/views/Watch
git commit -m "feat: transcript overlay, watch page wiring and clipboard auto-copy"
```

---

### Task B7: Settings UI

**Files:**
- Modify: `src/renderer/components/PlayerSettings/PlayerSettings.vue`
- Test: live check in the Settings page

**Interfaces:**
- Consumes: store getters/actions generated in Task B1.
- Produces: a "Transcript" settings section with service URL, token, seconds before, seconds after.

- [ ] **Step 1: Add the section markup**

Inside the existing `<FtSettingsSection>` in `PlayerSettings.vue`, after the screenshot block (before the closing `</FtSettingsSection>`), reusing the same `FtFlexBox` + `FtInput` pattern the screenshot folder field uses:

```html
      <FtFlexBox>
        <FtInput
          :placeholder="t('Settings.Player Settings.Transcript.Service URL')"
          :value="transcriptionServiceUrl"
          :show-action-button="false"
          @change="updateTranscriptionServiceUrl"
        />
      </FtFlexBox>
      <FtFlexBox>
        <FtInput
          :placeholder="t('Settings.Player Settings.Transcript.Token')"
          :value="transcriptionToken"
          :show-action-button="false"
          @change="updateTranscriptionToken"
        />
      </FtFlexBox>
      <FtFlexBox>
        <FtInput
          :placeholder="t('Settings.Player Settings.Transcript.Seconds Before')"
          :value="transcriptionSecondsBefore"
          :show-action-button="false"
          @change="value => updateTranscriptionSecondsBefore(Number(value) || 60)"
        />
      </FtFlexBox>
      <FtFlexBox>
        <FtInput
          :placeholder="t('Settings.Player Settings.Transcript.Seconds After')"
          :value="transcriptionSecondsAfter"
          :show-action-button="false"
          @change="value => updateTranscriptionSecondsAfter(Number(value) || 180)"
        />
      </FtFlexBox>
```

- [ ] **Step 2: Add the computed refs**

Next to the existing `const screenshotMode = computed(() => store.getters.getScreenshotMode)`:

```js
const transcriptionServiceUrl = computed(() => store.getters.getTranscriptionServiceUrl)
const transcriptionToken = computed(() => store.getters.getTranscriptionToken)
const transcriptionSecondsBefore = computed(() => store.getters.getTranscriptionSecondsBefore)
const transcriptionSecondsAfter = computed(() => store.getters.getTranscriptionSecondsAfter)
```

and next to the existing `handleUpdate...` functions:

```js
function updateTranscriptionServiceUrl(value) {
  store.dispatch('updateTranscriptionServiceUrl', value)
}

function updateTranscriptionToken(value) {
  store.dispatch('updateTranscriptionToken', value)
}

function updateTranscriptionSecondsBefore(value) {
  store.dispatch('updateTranscriptionSecondsBefore', value)
}

function updateTranscriptionSecondsAfter(value) {
  store.dispatch('updateTranscriptionSecondsAfter', value)
}
```

- [ ] **Step 3: Verify live**

In the running app: Settings → Player Settings shows the four fields; entering the service URL and token, then restarting the app, shows them still there (they are persisted through the settings DB by the generated updater actions).

- [ ] **Step 4: Lint and commit**

```bash
pnpm run lint
git add src/renderer/components/PlayerSettings/PlayerSettings.vue
git commit -m "feat: transcription settings section"
```

---

### Task B8: Full live verification against the real service

**Files:** none modified.

- [ ] **Step 1: Run the app and the service, then walk the spec's verification list**

Run the Phase A unit suite, then start the service (`systemctl --user restart freetube-transcribe.service`) and the app (`xvfb-run -a pnpm run dev --remote-debug`). Over CDP on port 9223, for a speech-heavy video (e.g. `aircAruvnKk`):

1. `GET http://100.77.173.63:9099/health` shows `modelLoaded: true` after one job.
2. Navigate to the watch page, seek to `t = 300`, click `.transcribe-button`.
3. Assert the overlay's DOM text appears and contains more than 20 lines.
4. Fetch the service transcript for the same window independently (`curl` a job for `startSeconds = t-60`, `endSeconds = t+180`) and assert the overlay text contains the same opening words.
5. Assert every timestamp in the overlay falls within `[t-60, t+180]`.
6. Assert playback continued: `document.querySelector('video').currentTime` advanced and `paused === false` throughout.
7. Assert `navigator.clipboard.readText()` equals the overlay text.
8. Press `ctrl+t` and confirm an identical flow runs.
9. Click Transcribe again while a job is running and confirm the "Already transcribing" toast instead of a second job.
10. Set a bogus token in settings and confirm the overlay shows the unauthorized message, not a crash.

- [ ] **Step 2: Record the outcome in the spec's verification section**

Append a short "Verification run" subsection to the spec with the date, the exact commands, and the observed results (including anything that did not pass). Do not write "verified" without the quoted output that shows it.

- [ ] **Step 3: Lint, commit, and hand off for review**

```bash
pnpm run lint
git add docs/superpowers/specs/2026-11-07-freetube-transcribe-design.md
git commit -m "docs: transcribe feature verification run"
```

---

## Verification (Phase B complete when all hold)

- `node --test "tests/**/*.test.cjs"` passes (constants, helpers, client: 15+ tests).
- `pnpm run lint` is clean.
- The button appears in the player control bar with a `ctrl+t` tooltip, and is absent in the web build (`pnpm run dev:web`).
- A real click produces a transcript of `[t−60, t+180]` matching an independently fetched service transcript for the same window, with the clipboard holding the same text.
- Playback never pauses and the overlay is dismissible mid-flight (which cancels the job server-side).
- Settings round-trip: the service URL, token and both window offsets persist across a restart.
