const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createRoster, normalizeName, findByName, findByPhone, claimSinger, renameSinger,
  releaseSinger, setSingerActive, setHost, recordSong, nextSingerId, SINGER_COLORS
} = require('../src/renderer/helpers/karaoke-roster.js')

test('the first claimed name becomes the host', () => {
  const { roster, singer, code } = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })

  assert.equal(code, null)
  assert.equal(singer.name, 'Ada')
  assert.equal(singer.host, true)
  assert.equal(singer.source, 'phone')
  assert.equal(singer.phoneId, 'ph_a')
  assert.equal(roster.length, 1)
})

test('a second claim is not the host and gets the next colour', () => {
  const first = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const second = claimSinger(first.roster, { name: 'Grace', phoneId: 'ph_b' })

  assert.equal(second.singer.host, false)
  assert.equal(second.singer.color, SINGER_COLORS[1])
})

test('names are trimmed, whitespace-collapsed and case-insensitively unique', () => {
  const first = claimSinger(createRoster(), { name: '  Ada   Lovelace ', phoneId: 'ph_a' })

  assert.equal(first.singer.name, 'Ada Lovelace')
  assert.equal(claimSinger(first.roster, { name: 'ada lovelace', phoneId: 'ph_b' }).code, 'E_NAME_TAKEN')
  assert.equal(findByName(first.roster, 'ADA LOVELACE').id, first.singer.id)
})

test('a claim needs a name and a phone id', () => {
  assert.equal(claimSinger(createRoster(), { name: '   ', phoneId: 'ph_a' }).code, 'E_BAD_NAME')
  assert.equal(claimSinger(createRoster(), { name: 'Ada' }).code, 'E_NO_PHONE')
})

test('name normalization caps the length at 24 characters', () => {
  assert.equal(normalizeName('x'.repeat(40)).length, 24)
})

test('a phone that already claimed keeps its row and cannot claim a second', () => {
  const first = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const again = claimSinger(first.roster, { name: 'Grace', phoneId: 'ph_a' })

  assert.equal(again.code, 'E_ALREADY_CLAIMED')
  assert.equal(again.roster.length, 1)
  assert.equal(findByPhone(again.roster, 'ph_a').name, 'Ada')
})

test('renaming is refused onto a name another singer holds, and allowed onto your own', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })

  assert.equal(renameSinger(grace.roster, { singerId: grace.singer.id, name: 'Ada' }).code, 'E_NAME_TAKEN')
  assert.equal(renameSinger(grace.roster, { singerId: grace.singer.id, name: 'Grace' }).code, null)

  const renamed = renameSinger(grace.roster, { singerId: grace.singer.id, name: 'Grace Hopper' })
  assert.equal(findByPhone(renamed.roster, 'ph_b').name, 'Grace Hopper')
})

test('releasing a name keeps the row but frees the phone', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const released = releaseSinger(ada.roster, { singerId: ada.singer.id })

  assert.equal(released.code, null)
  assert.equal(released.roster.length, 1)
  assert.equal(findByPhone(released.roster, 'ph_a'), null)
  assert.equal(released.roster[0].active, true)
})

test('a released name can be claimed by another phone', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const released = releaseSinger(ada.roster, { singerId: ada.singer.id })
  const taken = claimSinger(released.roster, { name: 'Ada', phoneId: 'ph_b' })

  assert.equal(taken.code, null)
  assert.equal(taken.roster.length, 1)
  assert.equal(taken.singer.phoneId, 'ph_b')
})

test('exactly one singer is the host at a time', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  const moved = setHost(grace.roster, { singerId: grace.singer.id })

  assert.equal(moved.roster.filter(singer => singer.host).length, 1)
  assert.equal(findByPhone(moved.roster, 'ph_b').host, true)
  assert.equal(findByPhone(moved.roster, 'ph_a').host, false)
})

test('a second claim does not take the host, and setHost moves it to another singer', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })

  assert.equal(grace.singer.host, false)
  assert.equal(grace.roster.filter(singer => singer.host).length, 1)
  assert.equal(grace.roster.filter(singer => singer.host)[0].name, 'Ada')

  const moved = setHost(grace.roster, { singerId: grace.singer.id })

  assert.equal(moved.code, null)
  assert.equal(moved.roster.filter(singer => singer.host).length, 1)
  assert.equal(moved.roster.filter(singer => singer.host)[0].name, 'Grace')
  assert.equal(findByPhone(moved.roster, 'ph_b').host, true)
  assert.equal(findByPhone(moved.roster, 'ph_a').host, false)
})

test('setHost on an unknown singer is refused', () => {
  assert.equal(setHost(createRoster(), { singerId: 's_nope' }).code, 'E_NOT_FOUND')
})

test('recording a song keeps the best score and totals', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const once = recordSong(ada.roster, { singerId: ada.singer.id, score: 70 })
  const twice = recordSong(once.roster, { singerId: ada.singer.id, score: 55 })

  assert.equal(twice.roster[0].stats.songsSung, 2)
  assert.equal(twice.roster[0].stats.totalScore, 125)
  assert.equal(twice.roster[0].stats.bestScore, 70)
})

test('rotation steps one singer past the last one, skipping singers with nothing pending', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  const linus = claimSinger(grace.roster, { name: 'Linus', phoneId: 'ph_c' })
  const roster = linus.roster
  const [a, g, l] = roster

  const everyone = [a.id, g.id, l.id]
  assert.equal(nextSingerId(roster, { lastSingerId: null, pendingSingerIds: everyone }), a.id)
  assert.equal(nextSingerId(roster, { lastSingerId: a.id, pendingSingerIds: everyone }), g.id)
  assert.equal(nextSingerId(roster, { lastSingerId: g.id, pendingSingerIds: everyone }), l.id)
  assert.equal(nextSingerId(roster, { lastSingerId: l.id, pendingSingerIds: everyone }), a.id)

  assert.equal(nextSingerId(roster, { lastSingerId: a.id, pendingSingerIds: [l.id] }), l.id)
  assert.equal(nextSingerId(roster, { lastSingerId: l.id, pendingSingerIds: [a.id] }), a.id)
})

test('rotation returns null when nobody has a pending song', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })

  assert.equal(nextSingerId(ada.roster, { lastSingerId: null, pendingSingerIds: [] }), null)
})

test('rotation ignores singers that are switched off', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })
  const off = setSingerActive(grace.roster, { singerId: grace.singer.id, active: false })
  const [a, g] = off.roster

  assert.equal(nextSingerId(off.roster, { lastSingerId: null, pendingSingerIds: [a.id, g.id] }), a.id)
  assert.equal(nextSingerId(off.roster, { lastSingerId: a.id, pendingSingerIds: [g.id] }), null)
})

test('renaming an unknown singer is refused and leaves the roster untouched', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })
  const grace = claimSinger(ada.roster, { name: 'Grace', phoneId: 'ph_b' })

  const result = renameSinger(grace.roster, { singerId: 's_nope', name: 'Linus' })

  assert.equal(result.code, 'E_NOT_FOUND')
  assert.equal(result.roster.length, 2)
  assert.deepEqual(result.roster.map(singer => singer.name), ['Ada', 'Grace'])
})

test('renaming a singer to a blank name is refused and leaves the roster untouched', () => {
  const ada = claimSinger(createRoster(), { name: 'Ada', phoneId: 'ph_a' })

  const result = renameSinger(ada.roster, { singerId: ada.singer.id, name: '   ' })

  assert.equal(result.code, 'E_BAD_NAME')
  assert.equal(result.roster.length, 1)
  assert.equal(result.roster[0].name, 'Ada')
})

test('releasing an unknown singer is refused', () => {
  assert.equal(releaseSinger(createRoster(), { singerId: 's_nope' }).code, 'E_NOT_FOUND')
})

test('switching an unknown singer on or off is refused', () => {
  assert.equal(setSingerActive(createRoster(), { singerId: 's_nope', active: false }).code, 'E_NOT_FOUND')
})

test('recording a song for an unknown singer is refused', () => {
  assert.equal(recordSong(createRoster(), { singerId: 's_nope', score: 50 }).code, 'E_NOT_FOUND')
})

test('the colour palette wraps once the roster is longer than it', () => {
  let roster = createRoster()

  for (let index = 0; index < SINGER_COLORS.length + 1; index += 1) {
    roster = claimSinger(roster, { name: `Singer ${index}`, phoneId: `ph_${index}` }).roster
  }

  assert.equal(roster.length, SINGER_COLORS.length + 1)
  assert.equal(roster[0].color, SINGER_COLORS[0])
  assert.equal(roster[SINGER_COLORS.length].color, SINGER_COLORS[0])
})
