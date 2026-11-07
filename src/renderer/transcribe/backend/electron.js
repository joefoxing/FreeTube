// src/renderer/transcribe/backend/electron.js
//
// Electron renderer backend: everything goes through the preload's IPC surface,
// which is what the app used directly before this backend existed.

/**
 * @param {{ videoId: string, startSeconds: number, endSeconds: number, serviceUrl: string, token: string }} payload
 * @returns {Promise<{ jobId: string, startSeconds: number, endSeconds: number, view: object }>}
 */
export function start(payload) {
  return window.ftElectron.transcribeStart(payload)
}

/**
 * @param {string} [jobId]
 */
export function cancel(jobId) {
  window.ftElectron.transcribeCancel(jobId)
}

/**
 * @param {(view: object) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onStatus(handler) {
  return window.ftElectron.onTranscribeStatus(handler)
}
