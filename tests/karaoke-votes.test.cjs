// tests/karaoke-votes.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/helpers/karaoke-queue.js')

/** A queue with three normal rows, one of them priority. */
async function fixture() {
  const q = await load()
  let queue = q.createQueue()
  queue = q.addItem(queue, { videoId: 'aaaaaaaaaaa', title: 'One' }, 's1').queue
  queue = q.addItem(queue, { videoId: 'bbbbbbbbbbb', title: 'Two' }, 's2').queue
  queue = q.addItem(queue, { videoId: 'ccccccccccc', title: 'Three' }, 's1').queue
  return { q, queue }
}

const titles = queue => queue.items.map(item => item.title)

test('a vote records the singer on the row and a second vote by the same singer is the same vote', async () => {
  const { q, queue } = await fixture()
  const id = queue.items[0].id

  const once = q.toggleVote(queue, id, 's1')
  assert.equal(once.code, null)
  assert.deepEqual(once.queue.items[0].votes, ['s1'])
  assert.equal(q.voteCount(once.queue.items[0]), 1)

  // The same singer again toggles it OFF — one vote per singer per song.
  const twice = q.toggleVote(once.queue, id, 's1')
  assert.equal(twice.code, null)
  assert.deepEqual(q.itemVotes(twice.queue.items.find(item => item.id === id)), [])
})

test('two singers voting the same song is two votes', async () => {
  const { q, queue } = await fixture()
  const id = queue.items[0].id

  const one = q.toggleVote(queue, id, 's1').queue
  const two = q.toggleVote(one, id, 's2').queue

  assert.equal(q.voteCount(two.items.find(item => item.id === id)), 2)
})

test('a vote moves the row after the last row with more votes, and never past a priority row', async () => {
  const { q, queue } = await fixture()
  // Make the LAST row priority, then vote for the middle one: the vote must land after the
  // priority run (the priority row keeps its place at the top) and after nothing else.
  const promoted = q.promoteItem(queue, queue.items[2].id).queue
  assert.deepEqual(titles(promoted), ['Three', 'One', 'Two'])

  const voted = q.toggleVote(promoted, promoted.items[2].id, 's1')
  assert.equal(voted.code, null)
  assert.deepEqual(titles(voted.queue), ['Three', 'Two', 'One'])
})

test('a second vote on a different row does not outrank the leader, and lands under it', async () => {
  const { q, queue } = await fixture()
  const [first, second] = queue.items

  const leader = q.toggleVote(queue, first.id, 's1').queue
  const leaderTwice = q.toggleVote(leader, first.id, 's2').queue
  const other = q.toggleVote(leaderTwice, second.id, 's3')

  assert.deepEqual(titles(other.queue), ['One', 'Two', 'Three'])
  assert.equal(q.voteCount(other.queue.items[0]), 2)
  assert.equal(q.voteCount(other.queue.items[1]), 1)
})

test('under round_robin a vote stays inside its own singer lane', async () => {
  const { q, queue } = await fixture()
  const rotated = q.setRotation(queue, 'round_robin').queue
  // Order: One(s1), Two(s2), Three(s1). s1 votes for their LAST row: it may pass s1's other
  // row, never s2's — a vote cannot outrank another singer's turn.
  const voted = q.toggleVote(rotated, rotated.items[2].id, 's1')

  assert.equal(voted.code, null)
  assert.deepEqual(titles(voted.queue), ['Three', 'One', 'Two'])
})

test('a vote on a priority row counts but does not move it', async () => {
  const { q, queue } = await fixture()
  const promoted = q.promoteItem(queue, queue.items[2].id).queue
  const voted = q.toggleVote(promoted, promoted.items[0].id, 's2')

  assert.deepEqual(titles(voted.queue), titles(promoted))
  assert.equal(q.voteCount(voted.queue.items[0]), 1)
})

test('an unvote leaves the row where the vote left it', async () => {
  const { q, queue } = await fixture()
  const voted = q.toggleVote(queue, queue.items[2].id, 's1').queue
  assert.deepEqual(titles(voted), ['Three', 'One', 'Two'])

  const unvoted = q.toggleVote(voted, voted.items[0].id, 's1')

  assert.equal(unvoted.code, null)
  assert.deepEqual(titles(unvoted.queue), ['Three', 'One', 'Two'])
  assert.equal(q.voteCount(unvoted.queue.items[0]), 0)
})

test('a song that has already played is refused with E_NOT_QUEUED', async () => {
  const { q, queue } = await fixture()
  const started = q.startItem(queue, queue.items[0].id).queue
  const played = q.completeCurrent(started).queue

  assert.equal(played.played.length, 1)
  assert.equal(q.toggleVote(played, played.played[0].id, 's1').code, 'E_NOT_QUEUED')
})

test('an unknown row id is refused with E_NOT_QUEUED and nothing is written', async () => {
  const { q, queue } = await fixture()
  const result = q.toggleVote(queue, 'k_nope', 's1')

  assert.equal(result.code, 'E_NOT_QUEUED')
  assert.equal(result.queue, queue)
})

test('a vote with no singer is refused with E_NO_SINGER', async () => {
  const { q, queue } = await fixture()
  const result = q.toggleVote(queue, queue.items[0].id, null)

  assert.equal(result.code, 'E_NO_SINGER')
  assert.equal(result.queue, queue)
})

test('topVoted is the normal tier leader, ties going to the row that comes first', async () => {
  const { q, queue } = await fixture()
  let voted = q.toggleVote(queue, queue.items[0].id, 's1').queue
  voted = q.toggleVote(voted, voted.items[1].id, 's2').queue

  assert.equal(q.topVoted(voted).id, voted.items[0].id)
  assert.equal(q.topVoted(queue), null)
})

test('a priority row is never the top-voted row: it already carries the priority badge', async () => {
  const { q, queue } = await fixture()
  const promoted = q.promoteItem(queue, queue.items[2].id).queue
  const voted = q.toggleVote(promoted, promoted.items[0].id, 's1').queue

  assert.equal(q.voteCount(voted.items[0]), 1)
  assert.equal(q.topVoted(voted), null)
})

test('votes survive a serialize round trip and a payload without votes still loads', async () => {
  const { q, queue } = await fixture()
  const voted = q.toggleVote(queue, queue.items[0].id, 's1').queue

  const restored = q.deserializeQueue(q.serializeQueue(voted))
  assert.deepEqual(restored.items[0].votes, ['s1'])

  // A queue written before voting existed: rows with no `votes` field at all.
  const old = JSON.parse(q.serializeQueue(queue))
  delete old.items[0].votes
  const loaded = q.deserializeQueue(JSON.stringify(old))

  assert.equal(q.voteCount(loaded.items[0]), 0)
  assert.equal(q.toggleVote(loaded, loaded.items[0].id, 's1').code, null)
})
