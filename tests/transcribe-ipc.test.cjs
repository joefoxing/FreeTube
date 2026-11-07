// tests/transcribe-ipc.test.cjs
//
// Unit tests for the main-process transcribe IPC handler. No Electron import:
// registerTranscribeIpc takes the ipcMain surface (and the client) by injection,
// so a stub drives it exactly as the real main process would.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const loadHandler = () => import('../src/main/transcribeIpc.js')
const loadChannels = () => import('../src/constants.js')

function makeIpcMain() {
  const handlers = new Map()
  const listeners = new Map()

  return {
    handlers,
    listeners,
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn)
  }
}

function makeSender(sent) {
  return {
    isDestroyed: () => false,
    send: (channel, view) => sent.push({ channel, view })
  }
}

const payload = {
  videoId: 'abc',
  startSeconds: 0,
  endSeconds: 30,
  serviceUrl: 'http://127.0.0.1:9098',
  token: 't'
}

// A waitForJob that only settles when its signal is aborted: keeps one job
// "in flight" for the duration of a test.
function hangingWaitForJob() {
  return ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('cancelled')
      error.code = 'E_CANCELLED'
      reject(error)
    })
  })
}

test('TRANSCRIBE_START runs the client and forwards each status to the sender', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()

  const views = [
    { jobId: 'j1', state: 'running', stage: 'fetching', progress: 0.5 },
    {
      jobId: 'j1',
      state: 'done',
      stage: 'transcribing',
      progress: 1,
      language: 'en',
      segments: [{ start: 5, end: 7, text: 'stub transcript' }]
    }
  ]

  const client = {
    startJob: async () => ({ jobId: 'j1' }),
    waitForJob: async ({ onUpdate }) => {
      for (const view of views) {
        onUpdate(view)
      }
      return views[views.length - 1]
    }
  }

  registerTranscribeIpc({ ipcMain, client })

  const result = await ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)(
    { sender: makeSender(sent) },
    payload
  )

  assert.deepEqual(result, { jobId: 'j1', startSeconds: 0, endSeconds: 30, view: views[1] })
  assert.deepEqual(
    sent.map(entry => entry.channel),
    [IpcChannels.TRANSCRIBE_STATUS, IpcChannels.TRANSCRIBE_STATUS]
  )
  assert.equal(sent[1].view.segments[0].text, 'stub transcript')
})

test('a client failure reaches the renderer as an error status and rejects the invoke', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()

  const client = {
    startJob: async () => {
      const error = new Error('service unreachable')
      error.code = 'E_SERVICE_UNREACHABLE'
      throw error
    }
  }

  registerTranscribeIpc({ ipcMain, client })

  await assert.rejects(
    () => ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)({ sender: makeSender(sent) }, payload),
    error => error.code === 'E_SERVICE_UNREACHABLE' && error.message === 'service unreachable'
  )

  const last = sent[sent.length - 1]
  assert.equal(last.channel, IpcChannels.TRANSCRIBE_STATUS)
  assert.equal(last.view.state, 'error')
  assert.equal(last.view.error.code, 'E_SERVICE_UNREACHABLE')
})

test('TRANSCRIBE_CANCEL aborts the in-flight job', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()

  let capturedSignal
  const client = {
    startJob: async ({ signal }) => {
      capturedSignal = signal
      return { jobId: 'j1' }
    },
    waitForJob: hangingWaitForJob()
  }

  registerTranscribeIpc({ ipcMain, client })

  const pending = ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)({ sender: makeSender(sent) }, payload)
  pending.catch(() => {})

  // Let startJob resolve so the job is registered as active.
  await new Promise(resolve => setImmediate(resolve))

  ipcMain.listeners.get(IpcChannels.TRANSCRIBE_CANCEL)({}, 'j1')

  await assert.rejects(pending, error => error.code === 'E_CANCELLED')
  assert.equal(capturedSignal.aborted, true)
})

test('a second TRANSCRIBE_START while a job is in flight rejects with E_BUSY', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()

  const client = {
    startJob: async () => ({ jobId: 'j1' }),
    waitForJob: hangingWaitForJob()
  }

  registerTranscribeIpc({ ipcMain, client })

  const first = ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)({ sender: makeSender(sent) }, payload)
  first.catch(() => {})

  await new Promise(resolve => setImmediate(resolve))

  await assert.rejects(
    () => ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)({ sender: makeSender(sent) }, payload),
    error => error.code === 'E_BUSY'
  )

  // Clean up the in-flight job so the module-level registry is empty again.
  ipcMain.listeners.get(IpcChannels.TRANSCRIBE_CANCEL)({}, 'j1')
  await first.catch(() => {})
})

test('a second TRANSCRIBE_START racing during the first startJob round-trip rejects with E_BUSY', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()

  // startJob does not resolve until we release it, so the first start sits in
  // the exact TOCTOU window (accepted, but not yet registered in activeJobs)
  // while the second start arrives — no setImmediate, no sleeps.
  let releaseStartJob
  const startJobGate = new Promise(resolve => {
    releaseStartJob = resolve
  })
  let startJobCalls = 0

  const client = {
    startJob: async () => {
      startJobCalls += 1
      await startJobGate
      return { jobId: 'j1' }
    },
    waitForJob: hangingWaitForJob()
  }

  registerTranscribeIpc({ ipcMain, client })
  const start = ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)

  const first = start({ sender: makeSender(sent) }, payload)
  first.catch(() => {})

  // Invoke the second start synchronously, still inside the first's window.
  const second = start({ sender: makeSender(sent) }, payload)
  second.catch(() => {})

  // The old (broken) guard entered startJob a second time here; the fixed guard
  // rejects before startJob is ever called.
  assert.equal(startJobCalls, 1, 'startJob must not be entered for the rejected concurrent start')
  await assert.rejects(second, error => error.code === 'E_BUSY')

  // Let the first start proceed, then finish it so the registry is released.
  releaseStartJob()
  await new Promise(resolve => setImmediate(resolve))
  ipcMain.listeners.get(IpcChannels.TRANSCRIBE_CANCEL)({}, 'j1')
  await first.catch(() => {})
})

test('the in-flight slot is released after a failed start so a later start can proceed', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()

  let attempt = 0
  const client = {
    startJob: async () => {
      attempt += 1
      if (attempt === 1) {
        const error = new Error('service unreachable')
        error.code = 'E_SERVICE_UNREACHABLE'
        throw error
      }
      return { jobId: `j${attempt}` }
    },
    waitForJob: async ({ onUpdate, signal: _signal }) => {
      const view = { jobId: `j${attempt}`, state: 'done', stage: 'done', progress: 1, segments: [] }
      onUpdate(view)
      return view
    }
  }

  registerTranscribeIpc({ ipcMain, client })
  const start = ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)

  await assert.rejects(
    () => start({ sender: makeSender(sent) }, payload),
    error => error.code === 'E_SERVICE_UNREACHABLE'
  )

  // If the failed start had leaked its reservation, this would reject E_BUSY.
  const result = await start({ sender: makeSender(sent) }, payload)
  assert.equal(result.jobId, 'j2')
  assert.equal(result.view.state, 'done')
})

test('TRANSCRIBE_START without a service URL rejects with E_WINDOW_INVALID', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()
  const client = { startJob: async () => ({ jobId: 'j1' }), waitForJob: async () => ({}) }

  registerTranscribeIpc({ ipcMain, client })

  await assert.rejects(
    () => ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)(
      { sender: makeSender(sent) },
      { videoId: 'abc', startSeconds: 0, endSeconds: 30 }
    ),
    error => error.code === 'E_WINDOW_INVALID'
  )
})

// B-style RED check: with the un-gated `send` (main's pre-fix code), the late
// poll frame below still reaches the sender — the whole point of gating on the
// live activeJobs entry. Cancel arrives with a null id, which is exactly the
// case the renderer's own stale-id guard cannot cover: handleTranscribe never
// learned a job id, so cancelTranscribe records nothing and a late status event
// would claim the current job. Main is the only place left that can suppress it.
test('a cancelled job delivers no further status events, even when cancel arrives before the renderer learned its id', async () => {
  const { registerTranscribeIpc } = await loadHandler()
  const { IpcChannels } = await loadChannels()

  const sent = []
  const ipcMain = makeIpcMain()

  // Captured so the test can deliver it on demand: models the next poll frame
  // of a job that was still polling when it got cancelled — the frame resolves
  // and reaches `onUpdate` after main has already torn the job down. (The real
  // client only ever calls onUpdate after an awaited poll, never synchronously
  // from inside the abort listener.)
  let emitLatePollFrame

  const client = {
    startJob: async () => ({ jobId: 'j1' }),
    waitForJob: ({ onUpdate, signal }) => new Promise((_resolve, reject) => {
      onUpdate({ jobId: 'j1', state: 'running', stage: 'fetching', progress: 0.5 })
      emitLatePollFrame = () =>
        onUpdate({ jobId: 'j1', state: 'running', stage: 'transcribing', progress: 0.9 })
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled')
        error.code = 'E_CANCELLED'
        reject(error)
      })
    })
  }

  registerTranscribeIpc({ ipcMain, client })

  const pending = ipcMain.handlers.get(IpcChannels.TRANSCRIBE_START)({ sender: makeSender(sent) }, payload)
  pending.catch(() => {})

  // Let startJob resolve so the job is the live activeJobs entry and its running
  // frame is legitimately delivered.
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(sent.length, 1, 'the live running status is delivered')
  assert.equal(sent[0].view.state, 'running')

  const sentBeforeCancel = sent.length

  // Cancel with a null id: the renderer never learned the id, so its guard is a
  // no-op here. Main must still stop the old job's events.
  ipcMain.listeners.get(IpcChannels.TRANSCRIBE_CANCEL)({}, null)

  await assert.rejects(pending, error => error.code === 'E_CANCELLED')

  // A poll frame from the now-torn-down job arrives; it must not be delivered.
  emitLatePollFrame()

  assert.equal(sent.length, sentBeforeCancel, 'a cancelled job must deliver no further status event')
  assert.ok(
    sent.every(entry => entry.view?.jobId !== 'j1' || entry.view.state === 'running'),
    'no post-cancel status event may carry the torn-down job id'
  )
})
