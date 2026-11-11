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
    // The claim binds the bridge's phone id — the only identity a phone can prove, stamped on the
    // relayed command as `from` — to a roster row. The phone sends a name; the phone id comes from
    // the bridge's `from`, never from the payload, so a phone cannot claim a row for another phone.
    // The payload is rebuilt field by field (never spread), so a phone cannot smuggle extra keys
    // into the store action. The store action returns `{singer, code}`; only the code crosses back
    // so a REJECTED claim (e.g. a name another phone already holds) reaches the ack as a failure
    // instead of a silent success — this is the string-or-null contract every sibling keeps.
    singerClaim: async payload => {
      const { code } = await store.dispatch('singerClaim', {
        name: payload?.name,
        phoneId: payload?.from,
        source: payload?.source
      })

      return code
    },
    // Attribution: once the phone has claimed a singer, that singer is the requester — the priority
    // cap counts singers, so re-pairing a phone must not buy a second allowance. An unclaimed phone
    // keeps the P1 behaviour (its own `from`, else the reducer's default). The `singerId` rides the
    // item too, so the reducer's own `getSingerByPhone` resolution agrees with this one.
    queueAdd: payload => {
      const singer = store.getters?.getSingerByPhone?.(payload?.from) ?? null

      return store.dispatch('karaokeAdd', {
        ...queueCommandFields(payload),
        singerId: singer?.id ?? null,
        requester: singer?.id ?? payload?.from
      })
    },
    // The row to act on travels in `itemId`, never in the reserved `id`.
    queuePromote: payload => store.dispatch('karaokePromote', payload?.itemId),
    queueRemove: payload => store.dispatch('karaokeRemove', payload?.itemId),
    // Clearing the queue is the one queue-wide, destructive command, so it is host-only: the
    // sending phone's claimed singer (resolved exactly as `queueAdd` resolves it, from the
    // bridge-stamped `from`) must hold the host row. A non-host — or a phone that claimed
    // nothing — is refused with a code and NOTHING is dispatched, so the ack reports the
    // failure instead of silently emptying everyone's queue.
    queueClear: payload => {
      const singer = store.getters?.getSingerByPhone?.(payload?.from) ?? null

      if (!singer?.host) return 'E_NOT_HOST'

      return store.dispatch('karaokeClear')
    },
    queueMove: payload => store.dispatch('karaokeMove', { id: payload?.itemId, toIndex: payload?.toIndex }),
    // One upvote per singer per song, so the voter is the sender's claimed roster row and
    // never anything the payload says. An unclaimed phone is refused rather than voting as
    // its `from` hash: re-pairing changes that hash, which would buy the same human a
    // second vote — exactly what the spec forbids.
    vote: payload => {
      const singer = store.getters?.getSingerByPhone?.(payload?.from) ?? null

      if (!singer) return 'E_NO_SINGER'

      return store.dispatch('karaokeVote', { id: payload?.itemId, singerId: singer.id })
    }
  }
}
