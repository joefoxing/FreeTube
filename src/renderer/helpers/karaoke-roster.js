// The roster's rules, in one pure place: claim, rename, release, host, colours, stats, rotation
// order. No Vuex, no datastore, no DOM — the store module, the TV strip and the phone PWA all call
// these, and so do the tests.

export const SINGER_COLORS = [
  '#e4572e', '#17bebb', '#ffc914', '#2e86ab',
  '#a23b72', '#76b041', '#f18f01', '#4d4dff'
]

export const NAME_MAX = 24

/**
 * @param {string} name
 * @returns {string} trimmed, whitespace-collapsed, length-capped
 */
export function normalizeName(name) {
  return String(name ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

/** @returns {object[]} a fresh, empty roster */
export function createRoster() {
  return []
}

/**
 * @param {object[]} roster
 * @param {string} name
 * @returns {object|null}
 */
export function findByName(roster, name) {
  const wanted = normalizeName(name).toLowerCase()
  return roster.find(singer => singer.name.toLowerCase() === wanted) ?? null
}

/**
 * @param {object[]} roster
 * @param {string} phoneId
 * @returns {object|null}
 */
export function findByPhone(roster, phoneId) {
  if (!phoneId) return null
  return roster.find(singer => singer.phoneId === phoneId) ?? null
}

/**
 * @param {object[]} roster
 * @returns {string} the next colour in the palette, cycling
 */
export function nextColor(roster) {
  return SINGER_COLORS[roster.length % SINGER_COLORS.length]
}

/**
 * Claim a roster row for a phone. A phone that already holds a row is refused: identity is the
 * roster row, and a second row per phone would let one device vote or queue twice.
 *
 * @param {object[]} roster
 * @param {{name: string, phoneId?: string, source?: string}} payload
 * @returns {{roster: object[], singer: object|null, code: string|null}}
 */
export function claimSinger(roster, payload) {
  const name = normalizeName(payload?.name)
  const phoneId = payload?.phoneId ?? null

  if (name.length === 0) {
    return { roster, singer: null, code: 'E_BAD_NAME' }
  }

  if (!phoneId) {
    return { roster, singer: null, code: 'E_NO_PHONE' }
  }

  if (findByPhone(roster, phoneId)) {
    return { roster, singer: findByPhone(roster, phoneId), code: 'E_ALREADY_CLAIMED' }
  }

  const existing = findByName(roster, name)

  if (existing && existing.phoneId) {
    return { roster, singer: null, code: 'E_NAME_TAKEN' }
  }

  // A released row keeps its name but no phone (releaseSinger clears phoneId): the next phone to
  // claim that name takes the released row over rather than minting a duplicate.
  if (existing) {
    const singer = { ...existing, phoneId }
    return { roster: roster.map(entry => (entry.id === existing.id ? singer : entry)), singer, code: null }
  }

  const singer = {
    id: `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1679616).toString(36)}`,
    name,
    color: nextColor(roster),
    source: payload?.source === 'roster' ? 'roster' : 'phone',
    phoneId,
    host: roster.every(existing => !existing.host),
    active: true,
    createdAt: Date.now(),
    stats: { songsSung: 0, totalScore: 0, bestScore: 0, votesCast: 0 }
  }

  return { roster: [...roster, singer], singer, code: null }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string, name: string}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function renameSinger(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  const name = normalizeName(payload?.name)

  if (name.length === 0) {
    return { roster, code: 'E_BAD_NAME' }
  }

  const holder = findByName(roster, name)

  if (holder && holder.id !== singer.id) {
    return { roster, code: 'E_NAME_TAKEN' }
  }

  return {
    roster: roster.map(entry => (entry.id === singer.id ? { ...entry, name } : entry)),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function releaseSinger(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  return {
    roster: roster.map(entry => (entry.id === singer.id ? { ...entry, phoneId: null } : entry)),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string, active: boolean}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function setSingerActive(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  return {
    roster: roster.map(entry => (entry.id === singer.id ? { ...entry, active: Boolean(payload.active) } : entry)),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function setHost(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  return {
    roster: roster.map(entry => ({ ...entry, host: entry.id === singer.id })),
    code: null
  }
}

/**
 * @param {object[]} roster
 * @param {{singerId: string, score?: number}} payload
 * @returns {{roster: object[], code: string|null}}
 */
export function recordSong(roster, payload) {
  const singer = roster.find(entry => entry.id === payload?.singerId)

  if (!singer) {
    return { roster, code: 'E_NOT_FOUND' }
  }

  const score = Number.isFinite(payload?.score) ? Number(payload.score) : null

  return {
    roster: roster.map(entry => {
      if (entry.id !== singer.id) return entry

      const stats = { ...entry.stats, songsSung: entry.stats.songsSung + 1 }

      if (score !== null) {
        stats.totalScore += score
        stats.bestScore = Math.max(stats.bestScore, score)
      }

      return { ...entry, stats }
    }),
    code: null
  }
}

/**
 * Whose turn is it next, in roster order, one step past the singer who just sang, skipping singer
 * rows that are switched off or hold nothing pending. Roster order is the rotation order; the
 * queue's own array order is untouched by it.
 *
 * @param {object[]} roster
 * @param {{lastSingerId?: string|null, pendingSingerIds?: string[]}} options
 * @returns {string|null} the next singerId, or null when nobody has a pending song
 */
export function nextSingerId(roster, options) {
  const pending = new Set(options?.pendingSingerIds ?? [])
  const eligible = roster.filter(singer => singer.active && pending.has(singer.id))

  if (eligible.length === 0) return null

  const lastSingerId = options?.lastSingerId ?? null
  const lastIndex = roster.findIndex(singer => singer.id === lastSingerId)

  for (let offset = 1; offset <= roster.length; offset += 1) {
    const candidate = roster[(lastIndex + offset + roster.length) % roster.length]

    if (candidate && eligible.some(singer => singer.id === candidate.id)) {
      return candidate.id
    }
  }

  return eligible[0].id
}
