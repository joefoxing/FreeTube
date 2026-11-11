import { DBKaraokeHandlers } from '../../../datastores/handlers/index'
import {
  claimSinger,
  renameSinger,
  releaseSinger,
  setSingerActive,
  setHost,
  recordSong
} from '../../helpers/karaoke-roster.js'

const state = {
  roster: []
}

const getters = {
  getSingers: state => state.roster,
  getSingerById: state => id => state.roster.find(singer => singer.id === id) ?? null,
  getSingerByPhone: state => phoneId => state.roster.find(singer => singer.phoneId === phoneId) ?? null,
  getHostSinger: state => state.roster.find(singer => singer.host) ?? null,
  getActiveSingers: state => state.roster.filter(singer => singer.active)
}

const mutations = {
  /**
   * @param {object} state
   * @param {object[]} roster
   */
  setRoster(state, roster) {
    state.roster = Array.isArray(roster) ? roster : []
  }
}

/**
 * The roster is stored one row per singer, so a rename is an upsert of that row and a release is an
 * upsert with `phoneId: null` — the row itself is the record, and deleting it would lose the stats.
 *
 * A roster row's identity is `id` (the helper mints `s_…`), but the datastore keys documents on
 * `_id`, so the handler-bound copy is stamped `_id = row.id` here. That keeps `find()`/`remove(id)`
 * consistent with the roster's own id without a second identity field in the row.
 *
 * @param {object} context
 * @param {object} context.commit
 * @param {object} roster
 * @param {object|null} changed
 */
async function persistRoster({ commit }, roster, changed = null) {
  commit('setRoster', roster)

  if (changed) {
    await DBKaraokeHandlers.upsert({ _id: changed.id, ...changed })
  }
}

const actions = {
  /**
   * @param {object} context
   * @param {object} context.commit
   */
  async singersLoad({ commit }) {
    const rows = await DBKaraokeHandlers.find()
    commit('setRoster', rows ?? [])
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{name: string, phoneId: string, source?: string}} payload
   * @returns {Promise<{singer: object|null, code: string|null}>}
   */
  async singerClaim({ state, commit }, payload) {
    const { roster, singer, code } = claimSinger(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, singer)
    } else if (singer) {
      commit('setRoster', roster)
    }

    return { singer, code }
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string, name: string}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerRename({ state, commit }, payload) {
    const { roster, code } = renameSinger(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerRelease({ state, commit }, payload) {
    const { roster, code } = releaseSinger(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string, active: boolean}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerSetActive({ state, commit }, payload) {
    const { roster, code } = setSingerActive(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerSetHost({ state, commit }, payload) {
    const { roster, code } = setHost(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster)

      for (const singer of roster) {
        await DBKaraokeHandlers.upsert({ _id: singer.id, ...singer })
      }
    }

    return code
  },

  /**
   * @param {object} context
   * @param {object} context.state
   * @param {object} context.commit
   * @param {{singerId: string, score?: number}} payload
   * @returns {Promise<string|null>} a code or null
   */
  async singerRecordSong({ state, commit }, payload) {
    const { roster, code } = recordSong(state.roster, payload)

    if (code === null) {
      await persistRoster({ commit }, roster, roster.find(singer => singer.id === payload.singerId))
    }

    return code
  }
}

export default { state, getters, mutations, actions }
