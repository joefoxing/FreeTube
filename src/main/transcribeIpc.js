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

// Distinguishes a synchronously-reserved slot (taken before client.startJob
// resolves, when the real job id is not yet known) from a live job's id.
let nextReservationId = 0

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

    // Reserve the single in-flight slot SYNCHRONOUSLY, before the first await,
    // so a second start arriving during startJob's HTTP round-trip is rejected
    // as busy. Keyed by a placeholder until the real job id is known; without
    // this, two racing starts would both pass the activeJobs.size guard and
    // spawn two workers.
    const reservationId = `pending:${nextReservationId++}`
    activeJobs.set(reservationId, controller)
    let jobId = null

    // Every status event must be gated on the job still being the live entry:
    // a job that was cancelled or otherwise removed from activeJobs may keep
    // running its async frame, but it must never reach the renderer. The map is
    // keyed by the placeholder reservationId until startJob resolves and by the
    // real jobId afterwards, so liveness is checked against whichever key
    // applies at this moment — matching the keys used by the cancel handler and
    // the finally below.
    const send = view => {
      const liveKey = jobId ?? reservationId
      if (!activeJobs.has(liveKey)) {
        return
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannels.TRANSCRIBE_STATUS, view)
      }
    }

    try {
      const job = await client.startJob({ serviceUrl, token, videoId, startSeconds, endSeconds, signal: controller.signal })
      jobId = job.jobId
      // Swap the placeholder reservation for the real job id so cancel-by-id
      // can still target the in-flight job once it is running.
      activeJobs.delete(reservationId)
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
      // Always release the reservation, including when startJob failed before
      // returning a job id — otherwise a leaked reservation would block every
      // later start as busy.
      activeJobs.delete(reservationId)
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
