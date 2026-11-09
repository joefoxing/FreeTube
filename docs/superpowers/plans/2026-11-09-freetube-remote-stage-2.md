# FreeTube Remote — Stage 2 (open a link) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A YouTube link pasted on the phone navigates the player page to that video in under 2 s; a malformed link shows an inline error and navigates nothing.

**Architecture:** The renderer agent already implements `cmd: 'open'` with an id check (`E_BAD_VIDEO_ID`) and a default `navigate` that sets `window.location.hash = '#/watch/<id>'`; the bridge is a pure relay and does not inspect payloads. Stage 2 therefore adds one client-side unit — `web/link.js`, a pure `parseVideoId()` — plus the phone UI that uses it. Validation stays in two places on purpose: the phone explains the error to the human before sending, the agent refuses a bad id even if a client sends one directly.

**Tech Stack:** plain ESM JavaScript (no bundler, no new npm dependency); `node --test` for the parser; pytest for the bridge (unchanged); browser live check in the running DOM.

**Spec:** `docs/superpowers/specs/2026-11-09-freetube-remote-design.md` (Stage 2 evidence, line 380)

**Bridge repo:** `/home/joefox/developer/freetube-remote`
**App repo:** `/home/joefox/developer/freetube`, branch `freetube-remote`

## Global Constraints

- No new npm or Python dependency. `web/link.js` is plain ESM imported by `web/app.js`.
- The phone client never talks to Invidious or YouTube; only the player page loads metadata.
- The bridge stays a relay: no payload validation is added to `app/hub.py`.
- Ids are exactly 11 characters of `[A-Za-z0-9_-]` — the same rule as `VIDEO_ID` in
  `src/renderer/remote/agent.js`. Do not widen one without the other.
- Every user-visible string is plain English in the existing voice; no i18n layer in the phone app.
- Commits use `git commit --no-verify` in the FreeTube repo (lefthook's eslint is broken repo-wide).
- Nothing is pushed.

---

### Task 1: `parseVideoId()` — the one new unit, test-first

**Files:**
- Create: `~/developer/freetube-remote/package.json` (ESM scope for the web client + a test script)
- Create: `~/developer/freetube-remote/web/link.js`
- Test: `~/developer/freetube-remote/tests-web/link.test.mjs`

**Interfaces:**
- Produces: `export function parseVideoId(text: string): string | null`
  - returns the 11-char id for a bare id or any of the accepted YouTube URL shapes
  - returns `null` for anything else, including non-YouTube hosts and non-http(s) schemes

- [x] **Step 1: Write the failing test**

`tests-web/link.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseVideoId } from '../web/link.js'

const ID = 'arj7oStGLkU'

test('a bare id is accepted', () => {
  assert.equal(parseVideoId(ID), ID)
  assert.equal(parseVideoId(`  ${ID}\n`), ID)
})

test('the common watch, short, shorts, live and embed URLs are accepted', () => {
  const urls = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&feature=share`,
    `http://youtu.be/${ID}?si=abc`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `youtu.be/${ID}`,
  ]
  for (const url of urls) assert.equal(parseVideoId(url), ID, url)
})

test('malformed and hostile input returns null', () => {
  const bad = [
    '',
    '   ',
    'not a link',
    ID.slice(0, 10),
    `${ID}x`,
    'https://evil.example/watch?v=arj7oStGLkU',
    'https://youtube.com.evil.example/watch?v=arj7oStGLkU',
    'https://www.youtube.com/watch?v=short',
    'javascript:alert(1)',
    `file:///tmp/${ID}`,
    'https://www.youtube.com/',
  ]
  for (const text of bad) assert.equal(parseVideoId(text), null, text)
})
```

- [x] **Step 2: Run the test to watch it fail**

Run: `cd ~/developer/freetube-remote && node --test "tests-web/*.test.mjs"`
Expected: FAIL — `Cannot find module '.../web/link.js'`.

- [x] **Step 3: Write the minimal implementation**

`package.json` (there is no npm dependency; this only marks the JS as ESM for `node --test`):

```json
{
  "name": "freetube-remote-web",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test "tests-web/*.test.mjs""
  }
}
```

`web/link.js`:

```js
// Turns whatever a human pasted into a YouTube video id, or null. The player
// page is the only thing that loads metadata; this module only decides what to
// ask it for. Same id rule as VIDEO_ID in src/renderer/remote/agent.js.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])
const PREFIXED = new Set(['shorts', 'embed', 'live', 'v'])

export function parseVideoId(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  if (VIDEO_ID.test(value)) return value

  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  if (!HOSTS.has(host)) return null

  let candidate = null
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/')[1]
  } else if (url.pathname === '/watch') {
    candidate = url.searchParams.get('v')
  } else {
    const [, prefix, id] = url.pathname.split('/')
    if (PREFIXED.has(prefix)) candidate = id
  }
  return VIDEO_ID.test(String(candidate ?? '')) ? candidate : null
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd ~/developer/freetube-remote && node --test "tests-web/*.test.mjs"`
Expected: PASS, 3 tests.

- [x] **Step 5: Prove the test can go red**

Temporarily change the final line to `return candidate` and re-run: the malformed-host
and short-id cases must fail. Restore, re-run, PASS.

- [x] **Step 6: Commit**

```bash
cd ~/developer/freetube-remote
git add web/link.js tests-web/link.test.mjs
git commit -m "feat(phone): parse a pasted YouTube link into an id"
```

---

### Task 2: The paste-a-link row on the phone

**Files:**
- Modify: `~/developer/freetube-remote/web/index.html` (a `<section class="open">` after `section.now`)
- Modify: `~/developer/freetube-remote/web/app.js` (import, `openLink()`, ack errors, bind)
- Modify: `~/developer/freetube-remote/web/app.css` (row layout, `.error` already exists)
- Modify: `~/developer/freetube-remote/web/sw.js` (`link.js` in PRECACHE, cache name `ftr-shell-v2`)

**Interfaces:**
- Consumes: `parseVideoId()` from Task 1; `cmd: 'open'` / `{videoId}` already handled by the agent.
- Produces: DOM ids `open-link` (input), `open-submit` (button), `open-error` (status text).

- [x] **Step 1: Write the failing test**

The bridge serves the shell; assert the row and its module are served, in
`tests/test_static.py`:

```python
def test_the_shell_offers_a_paste_a_link_row(tmp_path):
    page = client(tmp_path).get("/")
    assert 'id="open-link"' in page.text
    # The parser is its own module, so the shell must load it and app.js must import it.
    assert (WEB_DIR / "link.js").is_file()
    assert "from './link.js'" in (WEB_DIR / "app.js").read_text()


def test_the_service_worker_precaches_the_link_parser(tmp_path):
    source = client(tmp_path).get("/sw.js").text
    assert "./link.js" in source
```

Add `WEB_DIR` at the top of the test module:

```python
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
```

- [x] **Step 2: Run to watch them fail**

Run: `uv run pytest tests/test_static.py -q`
Expected: 2 failures — `id="open-link"` missing, `./link.js` not in `sw.js`.

- [x] **Step 3: Write the markup**

In `web/index.html`, after `</section>` of `section.now`:

```html
  <section class="open">
    <input id="open-link" type="url" inputmode="url" autocomplete="off" spellcheck="false"
           placeholder="Paste a YouTube link">
    <button id="open-submit" type="button">Open</button>
  </section>
  <p id="open-error" class="error" role="alert"></p>
```

In `web/app.css`:

```css
.open { display: flex; gap: .5rem; margin: .75rem 0 .25rem; }
.open input { flex: 1; min-width: 0; }
```

- [x] **Step 4: Wire the behaviour in `web/app.js`**

At the top, next to the existing constants:

```js
import { parseVideoId } from './link.js'
```

After `applyFrame()`:

```js
function openLink() {
  const text = $('open-link').value
  const videoId = parseVideoId(text)
  $('open-error').textContent = ''
  if (!videoId) {
    $('open-error').textContent = 'That is not a YouTube link.'
    return
  }
  if (state.socket?.readyState !== 1) {
    $('open-error').textContent = 'The TV is offline.'
    return
  }
  command('open', { videoId })
  $('open-link').value = ''
}
```

In the socket message handler, replace the ack line with:

```js
    if (message.t === 'ack') {
      if (message.code === 'E_OFFLINE') $('open-error').textContent = 'The TV is offline.'
      if (message.code === 'E_BAD_VIDEO_ID') $('open-error').textContent = 'That link has no video id.'
      if (message.ok && $('open-error').textContent) $('open-error').textContent = ''
    }
```

In `bind()`:

```js
  $('open-submit').addEventListener('click', openLink)
  $('open-link').addEventListener('keydown', e => { if (e.key === 'Enter') openLink() })
```

- [x] **Step 5: Update the service worker**

`web/sw.js`: `const CACHE = 'ftr-shell-v2'` and add `'./link.js'` to `PRECACHE`.

- [x] **Step 6: Run both suites**

Run: `cd ~/developer/freetube-remote && uv run pytest tests -q && node --test "tests-web/*.test.mjs"`
Expected: pytest 29 passed (27 + 2 new), node 3 passed.

- [x] **Step 7: Commit**

```bash
cd ~/developer/freetube-remote
git add web/index.html web/app.js web/app.css web/sw.js tests/test_static.py
git commit -m "feat(phone): paste a link to open it on the TV"
```

---

### Task 3: Live evidence, then documentation

**Files:**
- Modify: `~/developer/freetube-remote/docs/verification.md`
- Modify: `~/developer/freetube/docs/superpowers/specs/2026-11-09-freetube-remote-design.md` (Stage 2 line → measured)

- [x] **Step 1: Restart nothing, reload the page**

`web/` is served from disk by `StaticFiles`; only the browser needs a reload (the service
worker is network-first, so a plain reload picks up `link.js`).

- [x] **Step 2: Pair a fresh phone context**

Player settings → "Pair a phone" → read the 8-digit code from the DOM → in a second browser
context open `https://nextcloud.taild1347f.ts.net:10000/remote/`, type the code.

- [x] **Step 3: Valid link, timed**

Record `location.hash` and `performance.now()` before, paste
`https://www.youtube.com/watch?v=arj7oStGLkU` into `#open-link`, click `#open-submit`, poll
the player's hash every 100 ms until it equals `#/watch/arj7oStGLkU`. Expected: ≤ 2000 ms,
and the player's `#title`/video title reflects the new video once metadata loads.

- [x] **Step 4: Malformed link, negative**

Set `#open-link` to `https://evil.example/watch?v=arj7oStGLkU`, click. Expected:
`#open-error` reads "That is not a YouTube link.", the player's hash is unchanged, and the
bridge log shows no `cmd` frame for it.

- [x] **Step 5: Bad id sent directly (agent side of the contract)**

From the phone context run `command('open', { videoId: 'https://evil.example/x' })` — the
agent must ack `E_BAD_VIDEO_ID`, `#open-error` must show the ack message, and the hash must
stay unchanged.

- [x] **Step 6: Write the evidence and commit**

Append to `docs/verification.md` a "Stage 2" section with the measured timing, the error
string, and the ack code; change the spec's Stage 2 line to say measured with the date.
Commit the app repo (docs only) with `--no-verify`.

---

## Self-Review

- Spec Stage 2 evidence (line 380) is covered by Task 1 (validation, unit) and Task 3
  (timing, both directions).
- The spec's "Stage 3 = browse/search" boundary is respected: no Invidious call, no listing.
- `VIDEO_ID` stays identical in `web/link.js` and `src/renderer/remote/agent.js`; Task 1
  Step 3 quotes the rule in a comment so a later change knows both places exist.
- No placeholder steps; every code step shows the code.

---

## Build log — what the implementation settled differently

Three defects the live run surfaced, all fixed, plus one pre-existing app bug found on the way.

1. **`open` was refused with no media element.** `onCommand` looked up `getVideo()` first and
   answered `E_NO_PLAYER` for every command, `open` included — so pasting a link while nothing
   was playing (Settings, or the "Nothing playing" state) did nothing. `open` now runs before
   the element lookup: it is navigation, not playback. Tests: "open works with no media element
   on screen", "open with a bad id navigates nowhere…", "a playback command with no media
   element is still E_NO_PLAYER".
2. **A refused command was invisible.** The phone cleared the field before sending and only
   mapped `E_OFFLINE`/`E_BAD_VIDEO_ID`, so an ack failure could look like success. The field is
   now cleared only when the player's state names the new video; any failed ack for an open is
   rendered (known codes mapped, the rest shown verbatim).
3. **The Stage 1 pill lied after the player died.** `render()` recomputed the pill from the
   phone's own socket, overwriting the `player` event, so it read `connected` with the TV gone.
   It now tracks `playerOnline` and reads "TV offline" — measured 116.7 ms after closing the
   player tab (contract: 2 s).

Pre-existing, not ours: leaving the Settings view in the web preview throws in Vue's
`unmountComponent` (`type` / `nextSibling` / `parentNode` on null) and the view stays put.
Reproduced with `development`'s `PlayerSettings.vue` swapped back in, so the remote block is
not the cause. Because that leaves the page unable to navigate, a paste then acks `ok` without
moving the view — which is why the phone waits 10 s for the player's state and says
"The TV has not opened that link." rather than trusting the ack.

Also settled: `node --test` on Node 22.14 takes a glob, not a directory — the suite runs as
`node --test "tests-web/*.test.mjs"` from a root `package.json` that only marks the web client
as ESM (no npm dependency).
