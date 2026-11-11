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
 * Stamp a roster row for the datastore: `Karaoke.upsert` keys nedb documents on `_id` (see
 * `src/datastores/handlers/base.js`, `updateAsync({ _id: record._id }, ...)`), while a roster row
 * is keyed by `id` in state. This helper is the only crossing point between those two identities —
 * roster rows are `id`-keyed in state and `_id`-keyed in nedb, so every write goes through here.
 * The spread comes first so a row that happens to carry its own `_id` cannot override the mapping.
 *
 * @param {object} row a roster row keyed by `id`
 * @returns {object} the handler-bound copy, keyed by `_id`
 */
function toHandlerRow(row) {
  return { ...row, _id: row.id }
}

/**
 * The roster is stored one row per singer, so a rename is an upsert of that row and a release is an
 * upsert with `phoneId: null` — the row itself is the record, and deleting it would lose the stats.
 *
 * @param {object} context
 * @param {object} context.commit
 * @param {object} roster
 * @param {object|null} changed
 */
async function persistRoster({ commit }, roster, changed = null) {
  commit('setRoster', roster)

  if (changed) {
    await DBKaraokeHandlers.upsert(toHandlerRow(changed))
  }
}

const actions = {
  /**
   * @param {object} context
   * @param {object} context.commit
   */
  async singersLoad({ commit }) {
    const rows = await DBKaraokeHandlers.find()

    // nedb returns full documents, so each row carries a `_id` mirror of its own `id`; strip it on
    // the way into state so a roster row is exactly the pure helper's shape. Build new objects
    // rather than mutating the handler's results.
    commit('setRoster', (rows ?? []).map(({ _id, ...row }) => row))
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
        await DBKaraokeHandlers.upsert(toHandlerRow(singer))
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
