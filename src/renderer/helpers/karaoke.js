// Karaoke-only search: query rewriting, result filtering and the paging rule.
//
// Pure on purpose: no Vue, no Electron, no window. `tests/karaoke-helpers.test.cjs`
// runs this in node, and the phone PWA carries an equivalent matcher pinned to the
// same fixture file (tests/fixtures/karaoke-titles.json).

export const KARAOKE_QUERY_TOKENS = [
  'karaoke',
  'instrumental',
  'backing track',
  'backing-track',
  'sing along',
  'sing-along',
  'minus one',
  'off vocal',
  'off-vocal',
  'ktv'
]

export const KARAOKE_TITLE_PATTERN = /\bkaraoke\b|instrumental|backing[\s-]?track|sing[\s-]?along|minus[\s-]?one|off[\s-]?vocal|\bktv\b|\blyrics?\b/i

export const DEFAULT_MIN_SECONDS = 90
export const DEFAULT_MAX_SECONDS = 720
export const TARGET_RESULTS = 8
export const MAX_PAGES = 3

/**
 * Appends the karaoke token so YouTube's ranking does the heavy lifting, unless the
 * user already asked for something karaoke-shaped.
 *
 * @param {string} input
 * @returns {string}
 */
export function buildKaraokeQuery(input) {
  const query = String(input ?? '').trim().replaceAll(/\s+/g, ' ')

  if (query === '') {
    return ''
  }

  const lower = query.toLowerCase()
  if (KARAOKE_QUERY_TOKENS.some(token => lower.includes(token))) {
    return query
  }

  return `${query} karaoke`
}

/**
 * @param {object} video
 * @returns {number|null} seconds, or null when the API did not say
 */
export function videoSeconds(video) {
  const value = Number(video?.lengthSeconds ?? video?.durationSeconds)

  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * @param {object} video
 * @param {{minSeconds?: number, maxSeconds?: number}} [bounds]
 * @returns {boolean}
 */
export function isKaraokeVideo(video, bounds = {}) {
  if (!video || video.type !== 'video') {
    return false
  }

  const min = Number.isFinite(bounds.minSeconds) ? bounds.minSeconds : DEFAULT_MIN_SECONDS
  const max = Number.isFinite(bounds.maxSeconds) ? bounds.maxSeconds : DEFAULT_MAX_SECONDS
  const seconds = videoSeconds(video)

  // A duration the API did not state cannot be judged; dropping those would hide
  // real karaoke tracks behind an API quirk.
  if (seconds !== null && (seconds < min || seconds > max)) {
    return false
  }

  return KARAOKE_TITLE_PATTERN.test(`${video.title ?? ''} ${video.author ?? video.channelName ?? ''}`)
}

/**
 * @param {object[]} results
 * @param {{minSeconds?: number, maxSeconds?: number}} [bounds]
 * @returns {object[]}
 */
export function filterKaraokeResults(results, bounds = {}) {
  return (results ?? []).filter(item => isKaraokeVideo(item, bounds))
}

/**
 * @param {number} keptCount
 * @param {number} pagesFetched
 * @returns {boolean}
 */
export function needsAnotherPage(keptCount, pagesFetched) {
  return keptCount < TARGET_RESULTS && pagesFetched < MAX_PAGES
}
