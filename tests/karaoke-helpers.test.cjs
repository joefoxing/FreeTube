// tests/karaoke-helpers.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/renderer/helpers/karaoke.js')
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'karaoke-titles.json'), 'utf8'))

test('every fixture query is rewritten as the fixture expects', async () => {
  const { buildKaraokeQuery } = await load()

  for (const entry of fixture.queries) {
    assert.equal(buildKaraokeQuery(entry.input), entry.expected, JSON.stringify(entry.input))
  }
})

test('every fixture video is kept or dropped as the fixture expects', async () => {
  const { isKaraokeVideo } = await load()

  for (const video of fixture.videos) {
    assert.equal(isKaraokeVideo(video), video.karaoke, `${video.title} (${video.author})`)
  }
})

test('filterKaraokeResults keeps exactly the flagged videos, in order', async () => {
  const { filterKaraokeResults } = await load()

  const kept = filterKaraokeResults(fixture.videos)
  const expected = fixture.videos.filter(video => video.karaoke).map(video => video.title)

  assert.deepEqual(kept.map(video => video.title), expected)
})

test('the duration bounds are adjustable', async () => {
  const { filterKaraokeResults } = await load()

  const long = { type: 'video', title: 'Karaoke marathon', author: 'X', lengthSeconds: 1800 }

  assert.equal(filterKaraokeResults([long]).length, 0)
  assert.equal(filterKaraokeResults([long], { maxSeconds: 3600 }).length, 1)
})

test('paging stops at eight results or three pages', async () => {
  const { needsAnotherPage } = await load()

  assert.equal(needsAnotherPage(0, 1), true)
  assert.equal(needsAnotherPage(7, 2), true)
  assert.equal(needsAnotherPage(8, 1), false)
  assert.equal(needsAnotherPage(2, 3), false)
})
