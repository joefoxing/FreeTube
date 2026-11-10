import {
  addItem,
  clearQueue,
  completeCurrent,
  createQueue,
  deserializeQueue,
  moveItem,
  pickNext,
  previous,
  promoteItem,
  removeItem,
  serializeQueue,
  setActive,
  setSettings,
  startItem
} from '../../helpers/karaoke-queue.js'

// One key, not one per profile: a party queue that disappears because the TV profile
// changed is a worse failure than two profiles sharing it.
export const KARAOKE_STORAGE_KEY = 'freetube-karaoke'

/**
 * @param {Storage} [storage]
 * @returns {object|null}
 */
export function loadPersisted(storage = globalThis.localStorage) {
  try {
    return deserializeQueue(storage?.getItem(KARAOKE_STORAGE_KEY))
  } catch {
    return null
  }
}

/**
 * @param {object} queue
 * @param {Storage} [storage]
 */
export function persist(queue, storage = globalThis.localStorage) {
  try {
    storage?.setItem(KARAOKE_STORAGE_KEY, serializeQueue(queue))
  } catch {
    // Private mode or a full quota: the queue then lives for this session only,
    // which is exactly what happened before persistence existed.
  }
}

/**
 * The queue-shaped slice of the module state, so the pure reducer can be reused
 * without knowing about Vuex.
 *
 * @param {object} state
 * @returns {object}
 */
function snapshot(state) {
  return {
    active: state.active,
    rotation: state.rotation,
    current: state.current,
    items: state.items,
    played: state.played,
    settings: state.settings
  }
}

export default {
  state: () => (loadPersisted() ?? createQueue()),
  getters: {
    getKaraokeActive: state => state.active,
    getKaraokeCurrent: state => state.current,
    getKaraokeUpcoming: state => state.items,
    getKaraokeQueue: state => snapshot(state),
    getKaraokeNext: state => pickNext(state),
    getKaraokePriorityCount: state => state.items.filter(item => item.priority).length
  },
  mutations: {
    /**
     * @param {object} state
     * @param {boolean} active
     */
    setKaraokeActive(state, active) {
      state.active = Boolean(active)
    },
    /**
     * @param {object} state
     * @param {object} queue
     */
    setKaraokeQueue(state, queue) {
      state.active = queue.active
      state.rotation = queue.rotation
      state.current = queue.current
      state.items = queue.items
      state.played = queue.played
      state.settings = queue.settings
    },
    /**
     * @param {object} state
     * @param {object} partial
     */
    setKaraokeSettings(state, partial) {
      state.settings = { ...state.settings, ...partial }
    }
  },
  actions: {
    /**
     * @param {object} context
     * @param {object} context.state
     * @param {object} context.commit
     * @param {boolean} active
     * @returns {string|null}
     */
    karaokeSetActive({ state, commit }, active) {
      const { queue, code } = setActive(snapshot(state), active)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} a CODES value, or null when the item was queued */
    karaokeAdd({ state, commit }, payload) {
      const { queue, code } = addItem(snapshot(state), payload, payload?.requester ?? 'local')
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokePromote({ state, commit }, payload) {
      const id = typeof payload === 'string' ? payload : payload?.id
      const { queue, code } = promoteItem(snapshot(state), id)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeRemove({ state, commit }, payload) {
      const id = typeof payload === 'string' ? payload : payload?.id
      const { queue, code } = removeItem(snapshot(state), id)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeClear({ state, commit }) {
      const { queue, code } = clearQueue(snapshot(state))
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeMove({ state, commit }, payload) {
      const { queue, code } = moveItem(snapshot(state), payload?.id, payload?.toIndex)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeStart({ state, commit }, payload) {
      const id = typeof payload === 'string' ? payload : payload?.id
      const { queue, code } = startItem(snapshot(state), id)
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /** @returns {string|null} */
    karaokeComplete({ state, commit }) {
      const { queue, code } = completeCurrent(snapshot(state))
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    },
    /**
     * @returns {object|null} the song that is playing again, or null when nothing has played
     */
    karaokePrevious({ state, commit }) {
      const { queue, code } = previous(snapshot(state))

      if (code !== null) {
        return null
      }

      commit('setKaraokeQueue', queue)
      persist(queue)
      return queue.current
    },
    /** @returns {string|null} */
    karaokeSetSettings({ state, commit }, partial) {
      const { queue, code } = setSettings(snapshot(state), partial ?? {})
      commit('setKaraokeQueue', queue)
      persist(queue)
      return code
    }
  }
}
