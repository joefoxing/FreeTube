// tests/remote-karaoke.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/remote/agent.js')

function karaokeState(overrides = {}) {
  const item = (id, videoId, title, priority) => ({
    id, videoId, title, channel: 'c', durationSeconds: 200, thumbnail: 't', priority, requester: 'ph_1', addedAt: 1
  })

  return {
    active: true,
    rotation: 'fifo',
    current: item('c1', 'ccccccccccc', 'Current', false),
    items: [item('a1', 'aaaaaaaaaaa', 'Next up', true), item('b1', 'bbbbbbbbbbb', 'Later', false)],
    played: [item('p1', 'ppppppppppp', 'Played', false)],
    settings: { filterOn: true, minSeconds: 90, maxSeconds: 720, priorityCap: 2 },
    ...overrides
  }
}

test('the queue frame carries the current song, the upcoming ones and the counts', async () => {
  const { buildQueueFrame } = await load()

  const frame = buildQueueFrame(karaokeState())

  assert.equal(frame.active, true)
  assert.equal(frame.rotation, 'fifo')
  assert.equal(frame.current.title, 'Current')
  assert.deepEqual(frame.upcoming.map(item => item.title), ['Next up', 'Later'])
  assert.equal(frame.priorityCount, 1)
  assert.equal(frame.playedCount, 1)
})

test('the frame is capped and strips fields the phone has no use for', async () => {
  const { buildQueueFrame, UPCOMING_LIMIT } = await load()

  const items = []
  for (let i = 0; i < UPCOMING_LIMIT + 5; i++) {
    items.push({ id: `i${i}`, videoId: `v${String(i).padStart(10, '0')}`, title: `t${i}`, priority: false, addedAt: i, extra: 'drop me' })
  }

  const frame = buildQueueFrame(karaokeState({ items, current: null }))

  assert.equal(frame.upcoming.length, UPCOMING_LIMIT)
  assert.equal(frame.upcoming[0].title, 't0')
  assert.equal('extra' in frame.upcoming[0], false)
  assert.equal(frame.current, null)
})

test('a queue with no item is still a frame', async () => {
  const { buildQueueFrame } = await load()

  const frame = buildQueueFrame(karaokeState({ items: [], current: null, played: [] }))

  assert.deepEqual(frame.upcoming, [])
  assert.equal(frame.current, null)
  assert.equal(frame.priorityCount, 0)
})

test('queue commands reach the karaoke actions and a missing handler is refused', async () => {
  const { applyKaraokeCommand } = await load()

  const seen = []
  const actions = {
    queueAdd: message => {
      seen.push(message)
      return 'E_DUPLICATE'
    },
    queueClear: () => null
  }

  assert.equal(await applyKaraokeCommand({ cmd: 'queueAdd', videoId: 'aaaaaaaaaaa' }, () => actions), 'E_DUPLICATE')
  assert.equal(seen[0].videoId, 'aaaaaaaaaaa')
  assert.equal(await applyKaraokeCommand({ cmd: 'queueClear' }, () => actions), null)
  assert.equal(await applyKaraokeCommand({ cmd: 'queueClear' }, () => null), 'E_NO_KARAOKE')
  assert.equal(await applyKaraokeCommand({ cmd: 'notAKaraokeCommand' }, () => actions), 'E_UNKNOWN_CMD')
})
