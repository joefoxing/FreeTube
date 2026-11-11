// tests/karaoke-singers-store.test.cjs
//
// The singers store module's import chain runs through the webpack alias
// DB_HANDLERS_ELECTRON_RENDERER_OR_WEB into nedb, so a node:test file cannot import
// it. These cases therefore pin the contract the module must satisfy at the reducer /
// helper level, the same way P1's store test pinned localStorage: the rules the module
// delegates to are asserted directly.
const test = require('node:test')
const assert = require('node:assert/strict')

const { createRoster, claimSinger } = require('../src/renderer/helpers/karaoke-roster.js')
const { createQueue, addItem, pickNext, setRotation } = require('../src/renderer/helpers/karaoke-queue.js')

test('an add that carries a singerId is attributed to that singer', () => {
  const { queue } = addItem(createQueue(), { videoId: 'aaaaaaaaaaa', title: 'A', singerId: 's_1' }, 's_1')

  assert.equal(queue.items[0].singerId, 's_1')
  assert.equal(queue.items[0].requester, 's_1')
})

test('the priority cap counts a claimed singer, not the phone that claimed it', () => {
  const { priorityCount } = require('../src/renderer/helpers/karaoke-queue.js')
  let queue = createQueue()

  // the same singer, two different phones (a re-pair must not buy a second allowance)
  queue = addItem(queue, { videoId: 'aaaaaaaaaaa', title: 'A' }, 's_1').queue
  queue = { ...queue, items: queue.items.map(item => ({ ...item, priority: true })) }
  queue = addItem(queue, { videoId: 'bbbbbbbbbbb', title: 'B' }, 's_1').queue
  queue = { ...queue, items: queue.items.map(item => ({ ...item, priority: true })) }

  assert.equal(priorityCount(queue, 's_1'), 2)
  assert.equal(priorityCount(queue, 'ph_other'), 0)
})

test('the rotation mode the store sets is the mode the picker uses', () => {
  const { roster } = (() => {
    const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
    return claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  })()
  const [ada, grace] = roster
  let queue = createQueue()

  queue = addItem(queue, { videoId: 'aaaaaaaaaaa', title: 'A1' }, ada.id).queue
  queue = addItem(queue, { videoId: 'bbbbbbbbbbb', title: 'B1' }, grace.id).queue
  queue = { ...queue, items: queue.items.map(item => ({ ...item, singerId: item.requester })) }
  queue = setRotation(queue, 'round_robin').queue
  queue = { ...queue, lastSingerId: ada.id }

  assert.equal(pickNext(queue, { rotation: queue.rotation, roster }).videoId, 'bbbbbbbbbbb')
})

test('setRotation refuses an unknown mode', () => {
  assert.equal(setRotation(createQueue(), 'shuffle').code, 'E_BAD_ROTATION')
})
