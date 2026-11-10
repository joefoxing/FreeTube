// tests/karaoke-queue.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/helpers/karaoke-queue.js')

const A = { videoId: 'aaaaaaaaaaa', title: 'A' }
const B = { videoId: 'bbbbbbbbbbb', title: 'B' }
const C = { videoId: 'ccccccccccc', title: 'C' }
const D = { videoId: 'ddddddddddd', title: 'D' }

function ids(queue) {
  return queue.items.map(item => item.title)
}

test('a normal add appends and a priority add jumps ahead of it', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, B).queue
  queue = addItem(queue, C).queue

  const withPriority = addItem(queue, { ...A, priority: true }, 'ph_1')
  assert.equal(withPriority.code, null)
  assert.deepEqual(ids(withPriority.queue), ['A', 'B', 'C'])
})

test('priority keeps FIFO order inside its own tier', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, { ...A, priority: true }, 'ph_1').queue
  queue = addItem(queue, { ...B, priority: true }, 'ph_1').queue
  queue = addItem(queue, C).queue

  assert.deepEqual(ids(queue), ['A', 'B', 'C'])
})

test('the third priority request from one requester is demoted to normal', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, { ...A, priority: true }, 'ph_1').queue
  queue = addItem(queue, { ...B, priority: true }, 'ph_1').queue
  const third = addItem(queue, { ...C, priority: true }, 'ph_1')

  assert.equal(third.code, 'E_PRIORITY_CAP')
  assert.equal(third.queue.items.find(item => item.title === 'C').priority, false)

  // another requester still has their own two
  const other = addItem(third.queue, { ...D, priority: true }, 'ph_2')
  assert.equal(other.code, null)
  assert.equal(other.queue.items.find(item => item.title === 'D').priority, true)
})

test('the same video cannot be queued twice, another one can', async () => {
  const { addItem, createQueue } = await load()

  let queue = createQueue()
  queue = addItem(queue, A, 'ph_1').queue

  assert.equal(addItem(queue, A, 'ph_2').code, 'E_DUPLICATE')
  assert.equal(addItem(queue, { ...A, title: 'A again', priority: true }, 'ph_2').code, 'E_DUPLICATE')

  const second = addItem(queue, B, 'ph_1')
  assert.equal(second.code, null)
  assert.equal(second.queue.items.length, 2)
})

test('a video id that is not eleven url-safe characters is refused', async () => {
  const { addItem, createQueue } = await load()

  assert.equal(addItem(createQueue(), { videoId: 'short' }).code, 'E_BAD_VIDEO_ID')
  assert.equal(addItem(createQueue(), { videoId: 'has space!!' }).code, 'E_BAD_VIDEO_ID')
  assert.equal(addItem(createQueue(), { videoId: 'dQw4w9WgXcQ' }).code, null)
})

test('promote moves an item to the front of the priority tier and respects the cap', async () => {
  const { addItem, createQueue, promoteItem } = await load()

  let queue = createQueue()
  queue = addItem(queue, A, 'ph_1').queue
  queue = addItem(queue, B, 'ph_1').queue
  queue = addItem(queue, C, 'ph_1').queue

  const promoted = promoteItem(queue, queue.items[2].id)
  assert.equal(promoted.code, null)
  assert.deepEqual(ids(promoted.queue), ['C', 'A', 'B'])

  // ph_1 already holds one priority; the cap is two, so a second promote works and a
  // third is refused with the cap code.
  const second = promoteItem(promoted.queue, promoted.queue.items.find(i => i.title === 'A').id)
  assert.equal(second.code, null)
  const third = promoteItem(second.queue, second.queue.items.find(i => i.title === 'B').id)
  assert.equal(third.code, 'E_PRIORITY_CAP')
  assert.deepEqual(ids(third.queue), ['C', 'A', 'B'])
})

test('remove and clear report what they could not find', async () => {
  const { addItem, clearQueue, createQueue, removeItem } = await load()

  let queue = addItem(createQueue(), A).queue
  assert.equal(removeItem(queue, 'nope').code, 'E_NOT_FOUND')

  queue = removeItem(queue, queue.items[0].id).queue
  assert.deepEqual(ids(queue), [])

  queue = addItem(queue, A).queue
  assert.deepEqual(ids(clearQueue(queue).queue), [])
})

test('moveItem re-orders, and dropping inside the priority run promotes', async () => {
  const { addItem, createQueue, moveItem } = await load()

  let queue = createQueue()
  queue = addItem(queue, A).queue
  queue = addItem(queue, B).queue
  queue = addItem(queue, C).queue
  queue = addItem(queue, { ...D, priority: true }, 'ph_1').queue

  assert.deepEqual(ids(queue), ['D', 'A', 'B', 'C'])

  // dropped into the leading priority run, so it is promoted
  const promoted = moveItem(queue, queue.items.find(item => item.title === 'C').id, 0)
  assert.equal(promoted.code, null)
  assert.deepEqual(ids(promoted.queue), ['C', 'D', 'A', 'B'])
  assert.equal(promoted.queue.items[0].priority, true)

  // dropped out of the run, so it is demoted and D stays the only priority row
  const demoted = moveItem(promoted.queue, promoted.queue.items[0].id, 3)
  assert.deepEqual(ids(demoted.queue), ['D', 'A', 'B', 'C'])
  assert.equal(demoted.queue.items.every(item => item.priority === (item.title === 'D')), true)

  assert.equal(moveItem(queue, queue.items[0].id, 9).code, 'E_BAD_INDEX')
})

test('pickNext prefers the priority tier in array order', async () => {
  const { addItem, createQueue, pickNext } = await load()

  let queue = createQueue()
  queue = addItem(queue, A).queue
  queue = addItem(queue, { ...B, priority: true }, 'ph_1').queue

  assert.equal(pickNext(queue).title, 'B')
  assert.equal(pickNext(addItem(createQueue(), A).queue).title, 'A')
  assert.equal(pickNext(createQueue()), null)
})

test('playing, completing and going back is an identity', async () => {
  const { addItem, completeCurrent, createQueue, pickNext, previous, startItem } = await load()

  let queue = createQueue()
  queue = addItem(queue, A).queue
  queue = addItem(queue, B).queue
  queue = addItem(queue, C).queue

  const first = startItem(queue, pickNext(queue).id)
  assert.equal(first.code, null)
  assert.equal(first.queue.current.title, 'A')
  assert.deepEqual(ids(first.queue), ['B', 'C'])

  queue = completeCurrent(first.queue).queue
  assert.equal(queue.played.length, 1)

  queue = startItem(queue, pickNext(queue).id).queue
  assert.equal(queue.current.title, 'B')

  const back = previous(queue)
  assert.equal(back.code, null)
  assert.equal(back.queue.current.title, 'A')
  assert.deepEqual(ids(back.queue), ['B', 'C'])
  assert.deepEqual(back.queue.played, [])

  const afterEnd = completeCurrent(back.queue).queue
  const forward = startItem(afterEnd, pickNext(afterEnd).id)
  assert.equal(forward.queue.current.title, 'B')
  assert.deepEqual(ids(forward.queue), ['C'])
})

test('previous with nothing played reports it', async () => {
  const { createQueue, previous } = await load()

  assert.equal(previous(createQueue()).code, 'E_NOT_FOUND')
})

test('the played stack is capped', async () => {
  const { addItem, completeCurrent, createQueue, startItem, PLAYED_LIMIT } = await load()

  let queue = createQueue()
  for (let i = 0; i < PLAYED_LIMIT + 5; i++) {
    queue = addItem(queue, { videoId: `v${String(i).padStart(10, '0')}`, title: `t${i}` }).queue
    queue = startItem(queue, queue.items[0].id).queue
    queue = completeCurrent(queue).queue
  }

  assert.equal(queue.played.length, PLAYED_LIMIT)
})

test('serialization round-trips and refuses another schema', async () => {
  const { addItem, createQueue, deserializeQueue, serializeQueue, setActive } = await load()

  const queue = setActive(addItem(createQueue(), A).queue, true).queue
  const restored = deserializeQueue(serializeQueue(queue))

  assert.equal(restored.active, true)
  assert.equal(restored.items[0].videoId, A.videoId)
  assert.equal(deserializeQueue('not json'), null)
  assert.equal(deserializeQueue(JSON.stringify({ v: 99, items: [] })), null)
  assert.equal(deserializeQueue(null), null)
})
