// The phone-command surface: a paired phone's queue commands land on this map.
//
// It lives here, not inline in App.vue, so the map is importable by `node --test`:
// an SFC's `<script setup>` locals are unreachable from a test, which is how a
// mirrored copy in a test can drift from the real one without anyone noticing.
// The store is passed in as a parameter, so this module imports nothing from App.vue.

// The keys the bridge owns on every relayed command, none of which is a queue-item field:
//   t    — the frame type ('cmd')
//   cmd  — the command name
//   from — the phone id the bridge stamped
//   id   — the bridge's command-correlation id, used only to match the ack
// `id` in particular must never reach the store as a row id: the reducer mints its own (`k_*`),
// and rows are matched by id in remove/promote/move while the queue panel keys them by id, so a
// counter value shared by two phones' commands would collide. Only queue-item fields may pass.
const RESERVED_COMMAND_KEYS = new Set(['t', 'cmd', 'from', 'id'])

/**
 * The queue-item fields of a phone command, with the bridge's envelope keys stripped.
 *
 * A phone names the queue row it acts on with `itemId` (the `id` a row carries in the `t:'queue'`
 * frame), never with the envelope's `id`, which is the bridge's correlation counter.
 *
 * @param {object} [payload]
 * @returns {object}
 */
function queueCommandFields(payload) {
  const fields = {}

  for (const [key, value] of Object.entries(payload ?? {})) {
    if (!RESERVED_COMMAND_KEYS.has(key)) {
      fields[key] = value
    }
  }

  return fields
}

/**
 * @param {{ dispatch: (type: string, payload?: any) => any }} store a Vuex store
 * @returns {Record<string, (payload?: object) => any>} the action map, each handler returning a code or null
 */
export function createKaraokeActions(store) {
  return {
    karaokeSet: payload => store.dispatch('karaokeSetActive', Boolean(payload?.active)),
    // The phone's own room id (the bridge stamps it as `from`) is the requester: the queue's
    // priority cap is per-requester, so dropping it would let one phone eat the whole allowance.
    // Identity comes ONLY from the bridge's `from`; a phone-supplied `requester` is ignored, and
    // when there is no `from` the reducer's own default applies. The reserved keys are stripped so
    // the bridge's command `id` can never become the row id.
    queueAdd: payload => store.dispatch('karaokeAdd', {
      ...queueCommandFields(payload),
      requester: payload?.from
    }),
    // The row to act on travels in `itemId`, never in the reserved `id`.
    queuePromote: payload => store.dispatch('karaokePromote', payload?.itemId),
    queueRemove: payload => store.dispatch('karaokeRemove', payload?.itemId),
    queueClear: () => store.dispatch('karaokeClear'),
    queueMove: payload => store.dispatch('karaokeMove', { id: payload?.itemId, toIndex: payload?.toIndex })
  }
}
