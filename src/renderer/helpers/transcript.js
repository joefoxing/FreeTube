// src/renderer/helpers/transcript.js
//
// Pure helpers for the transcribe feature (no Electron / Vue imports so they
// stay loadable from plain Node in tests). Consumers: Watch.js and the
// FtTranscript overlay (B5/B6), which import exactly these names.

/**
 * Clamp the transcription window to the video.
 *
 * The window is `[currentTime - secondsBefore, currentTime + secondsAfter]`,
 * clamped to `[0, duration]`. A zero-length window is rejected by the service,
 * so a current time at or past the end still yields the last second of the
 * video rather than an empty range.
 *
 * @param {number} currentTime
 * @param {number} secondsBefore
 * @param {number} secondsAfter
 * @param {number} duration
 * @returns {{ start: number, end: number }}
 */
export function clampTranscriptWindow(currentTime, secondsBefore, secondsAfter, duration) {
  // `|| 0` folds a zero, unknown or non-finite duration down to 0 so the
  // arithmetic below never propagates NaN.
  const maxDuration = Math.max(0, Math.floor(duration) || 0)
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
 * @returns {string} `m:ss`, or `h:mm:ss` past an hour
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
 * The transcript as plain text: one line per segment, no timestamps.
 *
 * The times belong to the overlay, where they are seek links; pasted into a
 * document or a note they are noise, and the user asked for clean text.
 *
 * @param {{ start: number, end: number, text: string }[]} segments
 * @returns {string}
 */
export function formatTranscriptText(segments) {
  return segments
    .filter(segment => String(segment.text ?? '').trim().length > 0)
    .map(segment => String(segment.text).trim())
    .join('\n')
}

/**
 * Copy text using whichever clipboard mechanism this origin actually has.
 *
 * A secure context (Electron, or the HTTPS preview) provides
 * `navigator.clipboard`. A plain-HTTP origin — the tailnet preview served over
 * `http://…:9080` — does NOT: the async clipboard API is undefined outside a
 * secure context, so an unconditional `navigator.clipboard.writeText` throws and
 * the copy reports failure even though the browser could have done it. The
 * legacy selection + execCommand path still works on those origins when there is
 * a user gesture behind the call (the Copy Transcript button), so it backs up
 * the async API instead of giving up.
 *
 * The clipboard and document are injectable so this stays testable from plain
 * Node, where neither exists.
 *
 * @param {string} text
 * @param {{ clipboard?: object|undefined, documentRef?: object|undefined }} [deps]
 * @returns {Promise<boolean>} whether the text was handed to the clipboard
 */
export async function copyTextToClipboard(text, deps = {}) {
  const clipboard = 'clipboard' in deps ? deps.clipboard : globalThis.navigator?.clipboard
  const documentRef = 'documentRef' in deps ? deps.documentRef : globalThis.document

  if (clipboard?.writeText !== undefined) {
    try {
      await clipboard.writeText(text)
      return true
    } catch (error) {
      // A denied permission is not necessarily the end of the road: try the
      // legacy path before reporting a failure.
      console.error('Async clipboard write failed, trying the legacy path', error)
    }
  }

  return legacyCopyText(text, documentRef)
}

/**
 * Selection + `document.execCommand('copy')`. Deprecated but still the only
 * route on an insecure origin, where the async clipboard API does not exist.
 *
 * @param {string} text
 * @param {object|undefined} documentRef
 * @returns {boolean}
 */
function legacyCopyText(text, documentRef) {
  if (documentRef === undefined || typeof documentRef.execCommand !== 'function') {
    return false
  }

  let area = null

  try {
    area = documentRef.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    // Off-screen rather than `display: none`, which cannot be selected.
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    documentRef.body.appendChild(area)
    area.select()

    return documentRef.execCommand('copy') === true
  } catch (error) {
    console.error('Legacy clipboard copy failed', error)
    return false
  } finally {
    if (area !== null && area.parentNode !== null) {
      area.parentNode.removeChild(area)
    }
  }
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
 * @returns {string} an i18n key under `Video.Player.Transcribe`
 */
export function mapTranscribeError(code) {
  return ERROR_KEYS[code] ?? 'Video.Player.Transcribe.Failed'
}
