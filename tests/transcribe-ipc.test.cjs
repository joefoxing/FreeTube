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
