/**
 * The `toIndex` a drag means.
 *
 * `from` is the dragged row's index in the list as displayed (the row still in it) and `droppedAt` is
 * the position it was dropped at, in that same list. Because `moveItem` lifts the row out before
 * splicing it back, a drop BELOW the row's own slot lands one place higher; a drop ABOVE it lands
 * exactly where it was dropped. Returning `null` for anything that is not a whole, non-negative index
 * keeps a broken caller from silently reordering the queue by one place, which no screenshot would
 * show.
 *
 * @param {number} from the dragged row's index in the displayed list
 * @param {number} droppedAt the position the row was dropped at, in the same list
 * @returns {number|null}
 */
export function dropToIndex(from, droppedAt) {
  if (!Number.isInteger(from) || !Number.isInteger(droppedAt)) return null
  if (from < 0 || droppedAt < 0) return null

  return droppedAt > from ? droppedAt - 1 : droppedAt
}

/**
 * The move a drop means: the row that was DRAGGED, and the index it lands at.
 *
 * The dragged row is the one that moves -- moving the row it was dropped on is the bug this function
 * exists to make impossible: the list still reorders either way, so nothing on screen says which row
 * travelled. A drop onto the dragged row's own slot is a dither, and returns `null` so no queue write
 * (and no persistence write) happens for it.
 *
 * @param {object[]} rows the queue as displayed, the dragged row still in it
 * @param {number} from the dragged row's index in `rows`
 * @param {number} droppedAt the index the row was dropped at, in `rows`
 * @returns {{id: string, toIndex: number}|null}
 */
export function dropMove(rows, from, droppedAt) {
  const list = Array.isArray(rows) ? rows : []
  const toIndex = dropToIndex(from, droppedAt)

  if (toIndex === null || from === droppedAt) return null
  // A landing place outside the list is refused here rather than sent: the reducer would only refuse
  // it again (E_BAD_INDEX) and the phone would read a code for a move the UI should never offer.
  if (toIndex < 0 || toIndex >= list.length) return null

  const row = list[from]

  return row?.id ? { id: row.id, toIndex } : null
}

/**
 * The `toIndex` a phone's up/down button means.
 *
 * `rows` must be the queue in the STORE's order -- the frame's `upcoming` -- never the order the phone
 * displays: the phone shows the sender's own songs first, while `moveItem` indexes the store's list.
 * `null` at either end, and for a row that is no longer queued, so the button is disabled rather than
 * sending an index the reducer would have to refuse.
 *
 * @param {object[]} rows the queue in store order
 * @param {string} itemId the row to move
 * @param {'up'|'down'} direction
 * @returns {number|null}
 */
export function stepToIndex(rows, itemId, direction) {
  if (direction !== 'up' && direction !== 'down') return null

  const list = Array.isArray(rows) ? rows : []
  const from = list.findIndex(row => row?.id === itemId)

  if (from === -1) return null

  const to = direction === 'up' ? from - 1 : from + 1

  return to < 0 || to >= list.length ? null : to
}
