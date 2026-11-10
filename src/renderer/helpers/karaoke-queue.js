// The karaoke queue: pending order, the priority tier, and the played stack.
//
// Pure and immutable — every mutator returns { queue, code } and never touches its
// input, so the Vuex module, the remote agent and the tests all run this one
// implementation. `current` is deliberately NOT part of `items`: the song on screen
// cannot be reordered, removed or dragged by accident.

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
export const PLAYED_LIMIT = 50
export const PRIORITY_CAP = 2

export const CODES = {
  BAD_VIDEO_ID: 'E_BAD_VIDEO_ID',
  DUPLICATE: 'E_DUPLICATE',
  PRIORITY_CAP: 'E_PRIORITY_CAP',
  NOT_FOUND: 'E_NOT_FOUND',
  BAD_INDEX: 'E_BAD_INDEX'
}

const SCHEMA = 1

/** @returns {{filterOn: boolean, minSeconds: number, maxSeconds: number, priorityCap: number}} */
export function defaultSettings() {
  return { filterOn: true, minSeconds: 90, maxSeconds: 720, priorityCap: PRIORITY_CAP }
}

/** @returns {object} a fresh queue */
export function createQueue() {
  return {
    active: false,
    rotation: 'fifo',
    current: null,
    items: [],
    played: [],
    settings: defaultSettings()
  }
}

/**
 * How many leading items are priority items.
 *
 * @param {object[]} items
 * @returns {number}
 */
function priorityRunLength(items) {
  let at = 0
  while (at < items.length && items[at].priority) {
    at += 1
  }
  return at
}

/**
 * @param {object} queue
 * @param {string} requester
 * @returns {number}
 */
export function priorityCount(queue, requester) {
  return queue.items.filter(item => item.priority && item.requester === requester).length
}

/**
 * @param {object} queue
 * @param {object} item
 * @param {string} [requester]
 * @returns {{queue: object, code: string|null}}
 */
export function addItem(queue, item, requester = 'local') {
  const videoId = String(item?.videoId ?? '')

  if (!VIDEO_ID.test(videoId)) {
    return { queue, code: CODES.BAD_VIDEO_ID }
  }

  if (queue.items.some(existing => existing.videoId === videoId)) {
    return { queue, code: CODES.DUPLICATE }
  }

  const entry = {
    id: item.id ?? `k_${videoId}_${queue.items.length}_${Date.now().toString(36)}`,
    videoId,
    title: String(item.title ?? ''),
    channel: String(item.channel ?? ''),
    durationSeconds: Number.isFinite(item.durationSeconds) ? item.durationSeconds : null,
    thumbnail: String(item.thumbnail ?? ''),
    requester: item.requester ?? requester,
    priority: Boolean(item.priority),
    addedAt: Date.now()
  }

  let code = null

  if (entry.priority && priorityCount(queue, entry.requester) >= queue.settings.priorityCap) {
    entry.priority = false
    code = CODES.PRIORITY_CAP
  }

  const items = queue.items.slice()
  items.splice(entry.priority ? priorityRunLength(items) : items.length, 0, entry)

  return { queue: { ...queue, items }, code }
}

/**
 * @param {object} queue
 * @param {string} id
 * @returns {{queue: object, code: string|null}}
 */
export function removeItem(queue, id) {
  if (!queue.items.some(item => item.id === id)) {
    return { queue, code: CODES.NOT_FOUND }
  }

  return { queue: { ...queue, items: queue.items.filter(item => item.id !== id) }, code: null }
}

/**
 * @param {object} queue
 * @returns {{queue: object, code: string|null}}
 */
export function clearQueue(queue) {
  return { queue: { ...queue, items: [], current: null }, code: null }
}

/**
 * @param {object} queue
 * @param {string} id
 * @param {{force?: boolean}} [options]
 * @returns {{queue: object, code: string|null}}
 */
export function promoteItem(queue, id, options = {}) {
  const item = queue.items.find(entry => entry.id === id)

  if (!item) {
    return { queue, code: CODES.NOT_FOUND }
  }

  // ★ on a row that already holds priority is a successful no-op: the row is excluded
  // from its own cap check and left exactly where it is, so re-promoting at the cap
  // returns null (not E_PRIORITY_CAP) and never reorders. Only a normal row is held to
  // the cap.
  if (item.priority) {
    return { queue, code: null }
  }

  if (!options.force && priorityCount(queue, item.requester) >= queue.settings.priorityCap) {
    return { queue, code: CODES.PRIORITY_CAP }
  }

  const rest = queue.items.filter(entry => entry.id !== id)
  rest.splice(priorityRunLength(rest), 0, { ...item, priority: true })

  return { queue: { ...queue, items: rest }, code: null }
}

/**
 * @param {object} queue
 * @param {string} id
 * @param {number} toIndex
 * @returns {{queue: object, code: string|null}}
 */
export function moveItem(queue, id, toIndex) {
  const from = queue.items.findIndex(item => item.id === id)

  if (from === -1) {
    return { queue, code: CODES.NOT_FOUND }
  }

  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= queue.items.length) {
    return { queue, code: CODES.BAD_INDEX }
  }

  const rest = queue.items.filter(item => item.id !== id)
  // The tier comes from where the row landed: inside the leading priority run of the
  // rows that stayed put means priority.
  const boundary = priorityRunLength(rest)
  const moved = { ...queue.items[from], priority: toIndex < boundary }
  rest.splice(toIndex, 0, moved)

  return { queue: { ...queue, items: rest }, code: null }
}

/**
 * @param {object} queue
 * @returns {object|null} the item that should play next
 */
export function pickNext(queue) {
  const priority = queue.items.find(item => item.priority)

  return priority ?? queue.items[0] ?? null
}

/**
 * @param {object} queue
 * @param {string} id
 * @returns {{queue: object, code: string|null}}
 */
export function startItem(queue, id) {
  const item = queue.items.find(entry => entry.id === id)

  if (!item) {
    return { queue, code: CODES.NOT_FOUND }
  }

  return {
    queue: { ...queue, current: item, items: queue.items.filter(entry => entry.id !== id) },
    code: null
  }
}

/**
 * @param {object} queue
 * @returns {{queue: object, code: string|null}}
 */
export function completeCurrent(queue) {
  if (!queue.current) {
    return { queue, code: null }
  }

  return {
    queue: { ...queue, current: null, played: [...queue.played, queue.current].slice(-PLAYED_LIMIT) },
    code: null
  }
}

/**
 * @param {object} queue
 * @returns {{queue: object, code: string|null}}
 */
export function previous(queue) {
  const played = queue.played.slice()
  const restored = played.pop()

  if (!restored) {
    return { queue, code: CODES.NOT_FOUND }
  }

  const items = queue.items.slice()

  if (queue.current) {
    // The song that was playing goes back to the front of the normal tier, so
    // prev-then-next lands on the same song again.
    items.splice(priorityRunLength(items), 0, { ...queue.current, priority: false })
  }

  return { queue: { ...queue, current: { ...restored, priority: false }, items, played }, code: null }
}

/**
 * @param {object} queue
 * @param {boolean} active
 * @returns {{queue: object, code: string|null}}
 */
export function setActive(queue, active) {
  return { queue: { ...queue, active: Boolean(active) }, code: null }
}

/**
 * @param {object} queue
 * @param {object} partial
 * @returns {{queue: object, code: string|null}}
 */
export function setSettings(queue, partial) {
  return { queue: { ...queue, settings: { ...queue.settings, ...partial } }, code: null }
}

/**
 * @param {object} queue
 * @returns {string}
 */
export function serializeQueue(queue) {
  return JSON.stringify({
    v: SCHEMA,
    active: queue.active,
    rotation: queue.rotation,
    current: queue.current,
    items: queue.items,
    played: queue.played,
    settings: queue.settings
  })
}

/**
 * @param {string|null|undefined} json
 * @returns {object|null} a queue, or null when the payload is unusable
 */
export function deserializeQueue(json) {
  try {
    const raw = JSON.parse(json)

    if (!raw || typeof raw !== 'object' || raw.v !== SCHEMA) {
      return null
    }

    // Anything missing or of the wrong type falls back to a fresh queue's shape, so a
    // partial payload (e.g. `{ v: 1 }`) can never hand the caller `items: undefined` to
    // call `.length` on.
    const base = createQueue()
    const settings =
      raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
        ? raw.settings
        : {}

    return {
      ...base,
      active: typeof raw.active === 'boolean' ? raw.active : base.active,
      rotation: typeof raw.rotation === 'string' ? raw.rotation : base.rotation,
      current: raw.current && typeof raw.current === 'object' ? raw.current : null,
      items: Array.isArray(raw.items) ? raw.items : base.items,
      played: Array.isArray(raw.played) ? raw.played : base.played,
      settings: { ...base.settings, ...settings }
    }
  } catch {
    return null
  }
}
