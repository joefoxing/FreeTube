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
 * One timestamped line per non-blank segment. Segments carry ABSOLUTE video
 * seconds in `start` (the service already offsets them), so no re-offsetting
 * happens here. Whitespace-only segments are dropped so a transcript never
 * contains a bare `[m:ss]` line.
 *
 * @param {{ start: number, end: number, text: string }[]} segments
 * @returns {string}
 */
export function formatTranscriptText(segments) {
  return segments
    .filter(segment => String(segment.text ?? '').trim().length > 0)
    .map(segment => `[${formatTimestamp(segment.start)}] ${segment.text}`)
    .join('\n')
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
