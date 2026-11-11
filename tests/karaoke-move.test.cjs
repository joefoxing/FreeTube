// tests/karaoke-move.test.cjs
//
// The index arithmetic between a drag (or a phone's up/down button) and `moveItem`'s `toIndex`.
// Both helpers are pure so the numbers can be pinned here: they are the half of P4 that no amount of
// live clicking can prove convincingly, because a wrong index that HAPPENS to look plausible (the
// list still reorders, just not where you dropped it) is invisible in a screenshot.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/helpers/karaoke-move.js')

test('a drag downward lands one place higher once its own row is lifted out', async () => {
  const { dropToIndex } = await load()

  // [A,B,C,D]: A dropped onto the slot after B must end at index 1, not 2 -- moveItem removes A
  // first, so the list it splices into is already one shorter.
  assert.equal(dropToIndex(0, 2), 1, 'dropping row 0 onto position 2 ends at index 1')
  assert.equal(dropToIndex(1, 3), 2, 'dropping row 1 onto position 3 ends at index 2')
  assert.equal(dropToIndex(0, 3), 2, 'a drop onto the very end still shifts by one')
})

test('a drag upward lands exactly where it was dropped', async () => {
  const { dropToIndex } = await load()

  // [A,B,C,D]: D dropped onto position 1 ends at index 1 -- nothing before it was removed.
  assert.equal(dropToIndex(3, 1), 1, 'dropping row 3 onto position 1 ends at index 1')
  assert.equal(dropToIndex(2, 0), 0, 'a drop onto the very top lands at 0')
})

test('a drop onto its own slot keeps the index, so a dithering drag changes nothing', async () => {
  const { dropToIndex } = await load()

  assert.equal(dropToIndex(2, 2), 2, 'a self-drop is a no-op index')
  assert.equal(dropToIndex(0, 0), 0, 'the first row dropped on itself stays first')
})

test('nonsense drops are refused rather than guessed', async () => {
  const { dropToIndex } = await load()

  assert.equal(dropToIndex(undefined, 1), null, 'a missing source index has no answer')
  assert.equal(dropToIndex(1, undefined), null, 'a missing drop position has no answer')
  assert.equal(dropToIndex(-1, 2), null, 'a negative source index has no answer')
  assert.equal(dropToIndex(1, -1), null, 'a negative drop position has no answer')
  assert.equal(dropToIndex(1.5, 2), null, 'a fractional index is not a position')
})

test('a drop moves the row that was DRAGGED, not the row it was dropped on', async () => {
  const { dropMove } = await load()

  const rows = [{ id: 'kA' }, { id: 'kB' }, { id: 'kC' }]

  // Dragging the FIRST row onto the third slot: kA travels to index 1. Naming kC here instead
  // (the row under the cursor) reorders the list just as convincingly and moves the wrong song.
  assert.deepEqual(dropMove(rows, 0, 2), { id: 'kA', toIndex: 1 }, 'the dragged row is the one that moves')
  assert.deepEqual(dropMove(rows, 2, 0), { id: 'kC', toIndex: 0 }, 'and it travels upward as well as down')
  assert.deepEqual(dropMove(rows, 2, 1), { id: 'kC', toIndex: 1 }, 'a drop onto the row above lands above it')
})

test('a drop with nothing to do is refused, so no queue write happens for it', async () => {
  const { dropMove } = await load()

  const rows = [{ id: 'kA' }, { id: 'kB' }]

  assert.equal(dropMove(rows, 1, 1), null, 'a drop onto its own slot is a dither, not an instruction')
  assert.equal(dropMove(rows, 0, 5), null, 'a drop past the end has no landing place')
  assert.equal(dropMove(rows, undefined, 1), null, 'a drag that never started has no row')
  assert.equal(dropMove(rows, 9, 0), null, 'a drag of a row that is gone has no row')
  assert.equal(dropMove([], 0, 0), null, 'an empty queue has nothing to move')
})

test('a phone step moves one place, and stops at the ends', async () => {
  const { stepToIndex } = await load()

  const rows = [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }]

  assert.equal(stepToIndex(rows, 'k2', 'up'), 0, 'the middle row moves up one place')
  assert.equal(stepToIndex(rows, 'k2', 'down'), 2, 'the middle row moves down one place')
  assert.equal(stepToIndex(rows, 'k1', 'up'), null, 'the first row cannot move up, so the button is disabled')
  assert.equal(stepToIndex(rows, 'k3', 'down'), null, 'the last row cannot move down either')
  assert.equal(stepToIndex(rows, 'gone', 'up'), null, 'a row that is no longer queued has no target')
})

test('a step with no direction, or a direction nobody defined, is refused', async () => {
  const { stepToIndex } = await load()

  const rows = [{ id: 'k1' }, { id: 'k2' }]

  // A missing direction must not silently mean "down": a typo in a handler would then reorder the
  // queue while looking like nothing happened.
  assert.equal(stepToIndex(rows, 'k1', undefined), null, 'no direction means no move')
  assert.equal(stepToIndex(rows, 'k1', 'sideways'), null, 'an unknown direction means no move')
})

test('a step reads the list it is handed, so the caller must hand it the frame order', async () => {
  const { stepToIndex } = await load()

  // The phone renders its OWN rows first (`orderOwn`), but `moveItem` indexes the STORE's order. Here
  // the frame order is [A(not mine), B(mine), C(not mine)] and the phone would display [B, A, C]:
  // "move B down one" must be index 2, and the displayed position would have said 1.
  const frameOrder = [{ id: 'kA' }, { id: 'kB' }, { id: 'kC' }]
  const displayedOrder = [frameOrder[1], frameOrder[0], frameOrder[2]]

  assert.equal(stepToIndex(frameOrder, 'kB', 'down'), 2, 'the frame order gives the store the index it needs')
  assert.equal(
    stepToIndex(displayedOrder, 'kB', 'down'),
    1,
    'the displayed order would have sent index 1 -- the bug this helper exists to keep out of the phone'
  )
})
