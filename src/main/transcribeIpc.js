// src/main/transcribeIpc.js
//
// Wires the Electron-free transcribe client (./transcribeClient.js) to the
// renderer over IPC. The ipcMain surface (and the client) are injected so this
// module stays importable from plain Node in tests — see
// tests/transcribe-ipc.test.cjs.
import { IpcChannels } from '../constants.js'
import { createTranscribeClient } from './transcribeClient.js'

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
