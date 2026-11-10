// The phone-command surface: a paired phone's queue commands land on this map.
//
// It lives here, not inline in App.vue, so the map is importable by `node --test`:
// an SFC's `<script setup>` locals are unreachable from a test, which is how a
// mirrored copy in a test can drift from the real one without anyone noticing.
// The store is passed in as a parameter, so this module imports nothing from App.vue.

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
    // when there is no `from` the reducer's own default applies.
    queueAdd: payload => store.dispatch('karaokeAdd', {
      ...payload,
      requester: payload?.from
    }),
    queuePromote: payload => store.dispatch('karaokePromote', payload?.id),
    queueRemove: payload => store.dispatch('karaokeRemove', payload?.id),
    queueClear: () => store.dispatch('karaokeClear'),
    queueMove: payload => store.dispatch('karaokeMove', { id: payload?.id, toIndex: payload?.toIndex })
  }
}
