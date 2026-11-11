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
  setRotation,
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
    // The round-robin cursor lives here too: completeCurrent advances it, and dropping it
    // from the snapshot would make every commit snap it back and stall the rotation.
    lastSingerId: state.lastSingerId ?? null,
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
    getKaraokeNext: (state, getters, rootState, rootGetters) =>
      pickNext(state, { rotation: state.rotation, roster: rootGetters?.getSingers ?? [] }),
    getKaraokeRotation: state => state.rotation,
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
      state.lastSingerId = queue.lastSingerId ?? null
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
    /**
     * The phone's identity resolves to the singer it claimed before the reducer counts the
     * priority cap: the cap is per-singer, not per-phone, so re-pairing must not buy a second
     * allowance. A phone with no claimed row (or an add that names `singerId` directly) keeps the
     * bridge's opaque `from` as its identity; a TV-local add stays `local`.
     *
     * @param {object} context
     * @param {object} context.state
     * @param {object} context.commit
     * @param {object} [context.rootGetters]
     * @param {object} payload
     * @returns {string|null} a CODES value, or null when the item was queued
     */
    karaokeAdd({ state, commit, rootGetters }, payload) {
      const phoneId = payload?.requester ?? null
      const claimed = phoneId ? rootGetters?.getSingerByPhone?.(phoneId) : null
      const singerId = payload?.singerId ?? claimed?.id ?? null
      const requester = singerId ?? phoneId ?? 'local'
      const { queue, code } = addItem(snapshot(state), { ...payload, singerId, requester }, requester)
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
    },
    /**
     * @param {object} context
     * @param {object} context.state
     * @param {object} context.commit
     * @param {string} rotation
     * @returns {string|null} a code or null
     */
    karaokeSetRotation({ state, commit }, rotation) {
      const { queue, code } = setRotation(snapshot(state), rotation)

      if (code === null) {
        commit('setKaraokeQueue', queue)
        persist(queue)
      }

      return code
    }
  }
}
