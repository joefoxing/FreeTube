// src/renderer/transcribe/backend/web.js
//
// Web build backend. There is no preload and no ipcRenderer in the browser, so
// this drives the electron-free service client directly — the same module the
// main process uses, so polling, timeouts, window arithmetic and error mapping
// have one implementation rather than two.
//
// It reproduces main's rules in browser-local form: one job at a time, cancel by
// id, and status views pushed with the same shape the IPC backend delivers.
// Delivery is gated on the job still being the live one, so a torn-down job's
// late view can never reach the renderer.
import { createTranscribeClient } from '../../../main/transcribeClient.js'

/**
 * @param {{ client?: ReturnType<typeof createTranscribeClient> }} [options]
 */
export function createWebBackend({ client = createTranscribeClient() } = {}) {
  /** @type {Set<(view: object) => void>} */
  const listeners = new Set()

  /** @type {{ jobId: string | null, controller: AbortController } | null} */
  let current = null

  function emit(view) {
    for (const listener of listeners) {
      listener(view)
    }
  }

  return {
    /**
     * @param {{ videoId: string, startSeconds: number, endSeconds: number, serviceUrl: string, token: string }} payload
     * @returns {Promise<{ jobId: string, startSeconds: number, endSeconds: number, view: object }>}
     */
    async start({ videoId, startSeconds, endSeconds, serviceUrl, token }) {
      if (current !== null) {
        const error = new Error('a transcription is already running')
        error.code = 'E_BUSY'
        throw error
      }

      const entry = { jobId: null, controller: new AbortController() }
      current = entry

      const emitIfCurrent = view => {
        if (current === entry) {
          emit(view)
        }
      }

      try {
        const job = await client.startJob({
          serviceUrl,
          token,
          videoId,
          startSeconds,
          endSeconds,
          signal: entry.controller.signal
        })
        entry.jobId = job.jobId

        const view = await client.waitForJob({
          serviceUrl,
          token,
          jobId: job.jobId,
          onUpdate: emitIfCurrent,
          signal: entry.controller.signal
        })

        return { jobId: job.jobId, startSeconds, endSeconds, view }
      } catch (error) {
        // Gated like every other view: a job the user already cancelled must not
        // surface as a failure on whatever request is current now.
        emitIfCurrent({
          jobId: entry.jobId,
          state: 'error',
          stage: 'error',
          progress: 0,
          error: { code: error.code ?? 'E_TRANSCRIBE_FAILED', message: error.message }
        })
        throw error
      } finally {
        if (current === entry) {
          current = null
        }
      }
    },

    /**
     * @param {string} [jobId]
     */
    cancel(jobId) {
      const entry = current

      if (entry === null) {
        return
      }
      if (jobId !== undefined && jobId !== null && jobId !== entry.jobId) {
        return
      }

      // Tear the job down BEFORE aborting: the abort makes waitForJob reject, and
      // the catch above must not be able to deliver a view for a job the user has
      // already dismissed. (This is the opposite order to main's cancel handler,
      // where the abort cannot emit synchronously — here the gate is the guarantee.)
      current = null
      entry.controller.abort()
    },

    /**
     * @param {(view: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onStatus(handler) {
      listeners.add(handler)

      return () => {
        listeners.delete(handler)
      }
    }
  }
}

const backend = createWebBackend()

export const start = backend.start
export const cancel = backend.cancel
export const onStatus = backend.onStatus
