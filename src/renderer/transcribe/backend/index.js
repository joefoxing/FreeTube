// src/renderer/transcribe/backend/index.js
//
// The renderer's only handle on transcription. The implementation behind the
// alias is chosen at build time — the Electron renderer talks to the main
// process over IPC, the web build talks to the service directly — exactly as
// the datastore handlers are selected.
export {
  start,
  cancel,
  onStatus
} from 'TRANSCRIBE_BACKEND_ELECTRON_OR_WEB'
