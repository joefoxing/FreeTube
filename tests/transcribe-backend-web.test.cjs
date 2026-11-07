// tests/transcribe-backend-web.test.cjs
//
// Unit tests for the web-build transcribe backend. The service client is
// injected, so a stub drives it exactly as a browser would.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const loadBackend = () => import('../src/renderer/transcribe/backend/web.js')

const payload = {
  videoId: 'abc',
  startSeconds: 0,
  endSeconds: 30,
  serviceUrl: 'https://example.invalid:9446',
  token: 't'
}

function cancelledError() {
  return Object.assign(new Error('cancelled'), { code: 'E_CANCELLED' })
}

// A waitForJob that resolves on demand: keeps one job "in flight" until the test
// says otherwise, and pushes one running view immediately.
function makeClient() {
  let settle = null
  let onUpdateRef = null

  return {
    startJob: async () => ({ jobId: 'j1' }),
    waitForJob: ({ onUpdate, signal }) => {
      onUpdateRef = onUpdate
      onUpdate({ jobId: 'j1', state: 'running', stage: 'fetching', progress: 10 })

      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(cancelledError())
          return
        }

        signal.addEventListener('abort', () => reject(cancelledError()), { once: true })
        settle = () => {
          // The real client calls onUpdate on EVERY poll, the terminal one
          // included (src/main/transcribeClient.js:132-137), so the stub must too.
          const view = { jobId: 'j1', state: 'done', stage: 'done', progress: 100, segments: [] }
          onUpdateRef(view)
          resolve(view)
        }
      })
    },
    finish: () => settle()
  }
}

test('start returns main-process shaped result and pushes views to subscribers', async () => {
  const { createWebBackend } = await loadBackend()
  const client = makeClient()
  const backend = createWebBackend({ client })

  const seen = []
  const unsubscribe = backend.onStatus(view => seen.push(view))

  const running = backend.start(payload)
  await new Promise(resolve => setImmediate(resolve))

  client.finish()

  const result = await running

  assert.equal(result.jobId, 'j1')
  assert.equal(result.startSeconds, 0)
  assert.equal(result.endSeconds, 30)
  assert.equal(result.view.state, 'done')
  assert.deepEqual(seen.map(view => view.state), ['running', 'done'])

  unsubscribe()
})

test('a second start while one is in flight rejects as busy', async () => {
  const { createWebBackend } = await loadBackend()
  const backend = createWebBackend({ client: makeClient() })

  const first = backend.start(payload)
  await new Promise(resolve => setImmediate(resolve))

  await assert.rejects(backend.start(payload), error => error.code === 'E_BUSY')

  backend.cancel()
  await assert.rejects(first, error => error.code === 'E_CANCELLED')
})

test('cancel delivers no further status once the job is torn down', async () => {
  const { createWebBackend } = await loadBackend()
  const backend = createWebBackend({ client: makeClient() })

  const seen = []
  backend.onStatus(view => seen.push(view))

  const running = backend.start(payload)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(seen.length, 1)

  backend.cancel()
  await assert.rejects(running, error => error.code === 'E_CANCELLED')

  // The catch's error view must be gated out: the user already dismissed the job.
  assert.equal(seen.length, 1)
})
