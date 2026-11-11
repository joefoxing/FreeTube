// tests/karaoke-queue.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/helpers/karaoke-queue.js')

// Task 2's cases read the reducer through the same module the per-test `load()` imports; a
// top-level `require` of the ESM helper works here (Node's require(esm)), the same way
// tests/karaoke-roster.test.cjs requires the roster helper. The queue module is still loaded
// fresh per test by `load()`; this binding is only for the module-scope helpers below.
const {
  addItem,
  completeCurrent,
  createQueue,
  deserializeQueue,
  pickNext,
  promoteItem,
  serializeQueue,
  setRotation,
  startItem
} = require('../src/renderer/helpers/karaoke-queue.js')

const { createRoster, claimSinger } = require('../src/renderer/helpers/karaoke-roster.js')

function twoSingerRoster() {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })

  return { ada: ada.singer.id, grace: grace.singer.id, roster: grace.roster }
}

function queueWith(rows) {
  return rows.reduce((queue, row) => {
    const added = addItem(
      queue,
      {
        videoId: row.videoId,
        title: row.title,
        singerId: row.singerId ?? null
      },
      row.requester
    )

    return added.queue
  }, createQueue())
}

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

test('moveItem reads the priority tier from where the row lands, not from its old slot', async () => {
  const { addItem, createQueue, moveItem } = await load()

  // A is the only priority row and the row being moved, so the run of rows that stay put
  // is empty: dropping A back at index 0 must leave it normal. The buggy rule — measuring
  // the run over the ORIGINAL items, which still has A leading it — would keep A priority.
  let queue = createQueue()
  queue = addItem(queue, { ...A, priority: true }, 'ph_1').queue
  queue = addItem(queue, B).queue
  assert.deepEqual(ids(queue), ['A', 'B'])

  const movedOne = moveItem(queue, queue.items.find(i => i.title === 'A').id, 0)
  assert.equal(movedOne.code, null)
  assert.deepEqual(ids(movedOne.queue), ['A', 'B'])
  assert.equal(movedOne.queue.items.find(i => i.title === 'A').priority, false)

  // Two leading priority rows: moving the first down one slot lands it outside the run
  // that stayed (B alone), so it is demoted. The buggy rule counts BOTH leading priority
  // rows and would keep A priority.
  let two = createQueue()
  two = addItem(two, { ...A, priority: true }, 'ph_1').queue
  two = addItem(two, { ...B, priority: true }, 'ph_2').queue
  assert.deepEqual(ids(two), ['A', 'B'])

  const movedTwo = moveItem(two, two.items.find(i => i.title === 'A').id, 1)
  assert.equal(movedTwo.code, null)
  assert.deepEqual(ids(movedTwo.queue), ['B', 'A'])
  assert.equal(movedTwo.queue.items.find(i => i.title === 'A').priority, false)
  assert.equal(movedTwo.queue.items.find(i => i.title === 'B').priority, true)
})

test('pickNext prefers a priority row even when it is not first in the array', async () => {
  const { createQueue, pickNext } = await load()

  // The mutators never produce this state: addItem splices every priority row into the
  // leading run, so a priority row can only sit behind a normal one when a queue is
  // hand-assembled or loaded from storage. This pins the guard inside pickNext itself,
  // rather than the ordering the mutators happen to leave behind.
  const queue = {
    ...createQueue(),
    items: [
      { ...B, priority: false },
      { ...A, priority: true }
    ]
  }

  assert.equal(pickNext(queue).title, 'A')
})

test('re-promoting a row that already holds priority is a no-op even at the cap', async () => {
  const { addItem, createQueue, promoteItem } = await load()

  // ph_1 holds its full two priority rows (A, B); C is a normal row from the same phone.
  let queue = createQueue()
  queue = addItem(queue, { ...A, priority: true }, 'ph_1').queue
  queue = addItem(queue, { ...B, priority: true }, 'ph_1').queue
  queue = addItem(queue, C, 'ph_1').queue
  assert.deepEqual(ids(queue), ['A', 'B', 'C'])

  // ★ on B, which is already priority: succeeds and leaves the order untouched.
  const repromote = promoteItem(queue, queue.items.find(i => i.title === 'B').id)
  assert.equal(repromote.code, null)
  assert.deepEqual(ids(repromote.queue), ['A', 'B', 'C'])
  assert.equal(repromote.queue.items.filter(i => i.priority).length, 2)

  // A different, still-normal row from the same requester is still refused at the cap.
  const newRow = promoteItem(queue, queue.items.find(i => i.title === 'C').id)
  assert.equal(newRow.code, 'E_PRIORITY_CAP')
  assert.deepEqual(ids(newRow.queue), ['A', 'B', 'C'])
  assert.equal(newRow.queue.items.find(i => i.title === 'C').priority, false)
})

test('deserialize fills createQueue defaults for a v:1 payload missing or mistyping fields', async () => {
  const { createQueue, deserializeQueue } = await load()
  const defaults = createQueue()

  const sparse = deserializeQueue(JSON.stringify({ v: 1 }))

  assert.notEqual(sparse, null)
  assert.deepEqual(sparse.items, [])
  assert.deepEqual(sparse.played, [])
  assert.deepEqual(sparse.settings, defaults.settings)
  assert.equal(sparse.active, false)
  assert.equal(sparse.rotation, 'fifo')
  assert.equal(sparse.current, null)

  const wrong = deserializeQueue(
    JSON.stringify({
      v: 1,
      items: 'nope',
      played: 7,
      settings: 'nope',
      current: 'nope',
      active: 'yes',
      rotation: 42
    })
  )

  assert.deepEqual(wrong.items, [])
  assert.deepEqual(wrong.played, [])
  assert.deepEqual(wrong.settings, defaults.settings)
  assert.equal(wrong.active, false)
  assert.equal(wrong.rotation, 'fifo')
  assert.equal(wrong.current, null)
})

test('a fifo queue ignores rotation and takes the plain order', () => {
  const { ada, grace } = twoSingerRoster()
  const queue = queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A', requester: ada, singerId: ada },
    { videoId: 'bbbbbbbbbbb', title: 'B', requester: grace, singerId: grace }
  ])

  assert.equal(pickNext(queue, { rotation: 'fifo' }).videoId, 'aaaaaaaaaaa')
})

test('round robin gives the next singer their earliest pending song', () => {
  const { ada, grace, roster } = twoSingerRoster()
  const queue = {
    ...queueWith([
      { videoId: 'aaaaaaaaaaa', title: 'A1', requester: ada, singerId: ada },
      { videoId: 'bbbbbbbbbbb', title: 'B1', requester: grace, singerId: grace },
      { videoId: 'ccccccccccc', title: 'A2', requester: ada, singerId: ada }
    ]),
    lastSingerId: ada
  }

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'bbbbbbbbbbb')
})

test('round robin skips a singer with nothing pending instead of going silent', () => {
  const { ada, grace, roster } = twoSingerRoster()
  const queue = {
    ...queueWith([
      { videoId: 'aaaaaaaaaaa', title: 'A1', requester: ada, singerId: ada },
      { videoId: 'ccccccccccc', title: 'A2', requester: ada, singerId: ada }
    ]),
    lastSingerId: grace
  }

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'aaaaaaaaaaa')
})

test('round robin still lets a priority item jump the line', () => {
  const { ada, grace, roster } = twoSingerRoster()
  const promoted = queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A1', requester: ada, singerId: ada },
    { videoId: 'bbbbbbbbbbb', title: 'B1', requester: grace, singerId: grace }
  ])
  const queue = { ...promoteItem(promoted, promoted.items[1].id).queue, lastSingerId: ada }

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'bbbbbbbbbbb')
})

test('round robin falls back to the plain order when nothing can be rotated', () => {
  const { roster } = twoSingerRoster()
  const queue = queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A', requester: 'local', singerId: null }
  ])

  assert.equal(pickNext(queue, { rotation: 'round_robin', roster }).videoId, 'aaaaaaaaaaa')
})

test('finishing a song records which singer it belonged to', () => {
  const { ada } = twoSingerRoster()
  const queue = queueWith([{ videoId: 'aaaaaaaaaaa', title: 'A', requester: ada, singerId: ada }])
  const started = startItem(queue, queue.items[0].id).queue
  const done = completeCurrent(started).queue

  assert.equal(done.lastSingerId, ada)
  assert.equal(done.current, null)
})

test('an item with no singer leaves the rotation cursor alone', () => {
  const queue = queueWith([
    { videoId: 'aaaaaaaaaaa', title: 'A', requester: 'local', singerId: null }
  ])
  const started = startItem(queue, queue.items[0].id).queue

  assert.equal(completeCurrent(started).queue.lastSingerId, null)
})

test('setRotation accepts the two modes and refuses anything else', () => {
  const queue = createQueue()

  assert.equal(setRotation(queue, 'round_robin').queue.rotation, 'round_robin')
  assert.equal(setRotation(queue, 'fifo').queue.rotation, 'fifo')
  assert.equal(setRotation(queue, 'random').code, 'E_BAD_ROTATION')
})

test('a round-robin cursor survives a serialize round trip', () => {
  const { ada } = twoSingerRoster()
  const queue = { ...createQueue(), lastSingerId: ada }
  const restored = deserializeQueue(serializeQueue(queue))

  assert.equal(restored.lastSingerId, ada)
})

test('a persisted queue without a cursor restores it as null', () => {
  const queue = { ...createQueue(), lastSingerId: 's_old' }
  const json = JSON.parse(serializeQueue(queue))
  delete json.lastSingerId
  const restored = deserializeQueue(JSON.stringify(json))

  assert.equal(restored.lastSingerId, null)
  assert.equal(restored.rotation, 'fifo')
})
