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

// Controller requirement 1: a non-JSON error body must not escape as an
// unhandled rejection; it maps to the generic failure code with the status.
test('a non-JSON error body maps to the generic failure code with the status', async () => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error')
  })

  const { createTranscribeClient } = await load()
  const client = createTranscribeClient()

  await assert.rejects(
    () => client.startJob({ serviceUrl: url, token: 't', videoId: 'a', startSeconds: 0, endSeconds: 30 }),
    error => error.code === 'E_TRANSCRIBE_FAILED' && error.message === 'HTTP 500'
  )

  server.close()
})

// Controller requirement 2: aborting the passed signal stops the polling loop
// promptly, even while a request is in flight.
test('waitForJob stops on abort while a request is in flight', async () => {
  let requestSeen = false

  const { server, url } = await startStub((req, res) => {
    requestSeen = true
    // Never responds: the request stays in flight until it is aborted.
  })

  const { createTranscribeClient } = await load()
  const client = createTranscribeClient({ sleep: () => Promise.resolve() })

  const controller = new AbortController()
  const promise = client.waitForJob({ serviceUrl: url, token: 't', jobId: 'j1', signal: controller.signal })

  // Let the first request reach the (hanging) server, then abort.
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(requestSeen, true)
  controller.abort()

  await assert.rejects(promise, error => error.code === 'E_CANCELLED')

  server.close()
})

// The service may spend a long time fetching before it reports `transcribing`:
// its own allowance is 300s plus a 120s decode, and a throttled connection makes
// a fetch of a few minutes genuinely take ~124s. The client used to abandon that
// job at 120s with E_TIMEOUT while the service was still working on it and then
// finished it successfully.
test('a slow fetch is outwaited while the service is still fetching, not abandoned', async () => {
  const started = 0
  const { server, url } = await startStub((req, res) => {
    if (Date.now() - started >= 400000) {
      json(res, 200, { jobId: 'j1', state: 'done', stage: 'transcribing', progress: 1, language: 'vi', segments: [{ start: 1, end: 2, text: 'ok' }] })
    } else {
      json(res, 200, { jobId: 'j1', state: 'running', stage: 'fetching', progress: 0.05 })
    }
  })

  // The client reads only Date.now() for elapsed time and the injected sleep,
  // so a driven clock makes a 400-second fetch take no real time.
  const realNow = Date.now
  let clock = 0
  Date.now = () => clock

  try {
    const { createTranscribeClient } = await load()
    const client = createTranscribeClient({ sleep: async () => { clock += 1000 } })

    const view = await client.waitForJob({ serviceUrl: url, token: 't', jobId: 'j1' })

    assert.equal(view.state, 'done')
    assert.equal(view.segments[0].text, 'ok')
    assert.ok(clock >= 400000, `expected the client to wait past 400s, it waited ${clock}ms`)
  } finally {
    Date.now = realNow
    server.close()
  }
})

// ...and the budget still bounds the wait: a job that never leaves `fetching` is
// given up on, so the new default is asserted here rather than merely written down.
test('the default budget still gives up on a job that never leaves fetching', async () => {
  const { server, url } = await startStub((req, res) => json(res, 200, { jobId: 'j1', state: 'running', stage: 'fetching', progress: 0.05 }))

  const realNow = Date.now
  let clock = 0
  Date.now = () => clock

  try {
    const { createTranscribeClient } = await load()
    const client = createTranscribeClient({ sleep: async () => { clock += 1000 } })

    await assert.rejects(
      () => client.waitForJob({ serviceUrl: url, token: 't', jobId: 'j1' }),
      error => error.code === 'E_TIMEOUT' && error.message.includes('480s')
    )
  } finally {
    Date.now = realNow
    server.close()
  }
})
