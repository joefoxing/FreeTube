# FreeTube Remote — Stage 3 (search and queue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search YouTube from the phone and play a result on the TV, and skip the TV to the next/previous video, without the phone ever talking to Invidious directly.

**Architecture:** Two additions on top of the existing relay. (1) The bridge grows one authenticated read endpoint, `GET /api/search`, which calls the Invidious instance the app already uses and returns a normalized list; the phone holds a bearer token, the Funnel is public, so an open proxy is not an option. (2) The renderer agent grows `next` / `prev`, wired to the same `emit('skip-to-next' | 'skip-to-prev')` the on-screen skip buttons use, so playlist and autoplay semantics stay in `Watch.js` where they already live.

**Tech Stack:** existing bridge (FastAPI + uvicorn + segno) plus `httpx` as a runtime dependency; phone client stays plain ESM; renderer stays Vue 3 composition API with `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-09-freetube-remote-design.md` (Stages, item 3)

**Bridge repo:** `/home/joefox/developer/freetube-remote`
**App repo:** `/home/joefox/developer/freetube`, branch `freetube-remote`

## Global Constraints

- The bridge stays loopback-only behind `https://nextcloud.taild1347f.ts.net:10000/remote/`; no new ingress.
- Every new bridge route that reaches outside must require the phone token (`Authorization: Bearer …`)
  and be rate limited. The token never appears in a URL, a log line, or a response body.
- The phone never calls Invidious or YouTube: only `https://nextcloud.taild1347f.ts.net:10000/remote/api/*`.
- `next` / `prev` must reuse `handleSkipToNext` / `handleSkipToPrev` in `Watch.js`; no second
  playlist implementation in the agent.
- No new npm dependency in `/home/joefox/developer/freetube`. `httpx` becomes a bridge runtime
  dependency (it is already in the dev group for `TestClient`).
- `httpx` timeout is 8 s; an upstream failure is `502 E_UPSTREAM`, never a hang.
- Commits in the FreeTube repo use `--no-verify` (lefthook's eslint is broken repo-wide).
- Nothing is pushed.

---

### Task 1: `GET /api/search` — token-gated Invidious proxy

**Files:**
- Create: `~/developer/freetube-remote/app/invidious.py`
- Modify: `~/developer/freetube-remote/app/config.py` (add `invidious_base`)
- Modify: `~/developer/freetube-remote/app/main.py` (`create_app(..., search=None)`, the route, a second limiter)
- Modify: `~/developer/freetube-remote/pyproject.toml` (`httpx` to main dependencies)
- Test: `~/developer/freetube-remote/tests/test_search.py`

**Interfaces:**
- Produces: `search(query: str, page: int) -> list[dict]` — an injected coroutine in tests,
  `make_search(base)` in production. Each result:
  `{"videoId": str, "title": str, "author": str, "lengthSeconds": int, "thumbnail": str}`
  with `thumbnail` absolute.
- Produces: `Config.invidious_base` (env `FREETUBE_REMOTE_INVIDIOUS`,
  default `https://invidious.joefoxing.it.com`).
- Produces: `GET /api/search?q=&page=` →
  `{"query": str, "page": int, "results": [...]}`; `401 E_UNAUTHORIZED`, `400 E_BAD_QUERY`,
  `400 E_BAD_PAGE`, `429 E_RATE_LIMITED`, `502 E_UPSTREAM`.

- [x] **Step 1: Write the failing tests**

`tests/test_search.py`:

```python
import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Config
from app.invidious import UpstreamError, normalize
from app.main import create_app
from app.rooms import Rooms

RESULT = {
    "videoId": "arj7oStGLkU",
    "title": "Why do prime numbers make these spirals?",
    "author": "3Blue1Brown",
    "lengthSeconds": 1325,
    "videoThumbnails": [{"url": "/vi/arj7oStGLkU/mqdefault.jpg", "width": 320}],
}


def client(tmp_path: Path, search):
    config = Config(
        host="127.0.0.1",
        port=9098,
        state_path=tmp_path / "state.json",
        allowed_origins=("https://nextcloud.taild1347f.ts.net:10000",),
        invidious_base="https://invidious.example",
    )
    app = create_app(config, search=search)
    return TestClient(app), app


def paired_token(app, tmp_path: Path) -> str:
    rooms: Rooms = app.state.rooms
    player_id = rooms.register_player("device-key")
    rooms.open_pairing(player_id)
    return rooms.claim(rooms.open_pairing(player_id))[1]


def test_search_requires_the_phone_token(tmp_path):
    calls = []

    async def fake(query, page):
        calls.append((query, page))
        return [normalize(RESULT, "https://invidious.example")]

    test_client, app = client(tmp_path, fake)
    assert test_client.get("/api/search?q=prime").status_code == 401
    assert test_client.get("/api/search?q=prime", headers={"authorization": "Bearer nope"}).status_code == 401
    assert calls == []


def test_search_returns_normalized_results(tmp_path):
    async def fake(query, page):
        return [normalize(RESULT, "https://invidious.example")]

    test_client, app = client(tmp_path, fake)
    token = paired_token(app, tmp_path)
    body = test_client.get(
        "/api/search?q=  prime spirals  ", headers={"authorization": f"Bearer {token}"}
    ).json()
    assert body["query"] == "prime spirals"
    assert body["page"] == 1
    assert body["results"] == [
        {
            "videoId": "arj7oStGLkU",
            "title": "Why do prime numbers make these spirals?",
            "author": "3Blue1Brown",
            "lengthSeconds": 1325,
            "thumbnail": "https://invidious.example/vi/arj7oStGLkU/mqdefault.jpg",
        }
    ]


def test_search_rejects_a_bad_query_and_page(tmp_path):
    async def fake(query, page):
        return []

    test_client, app = client(tmp_path, fake)
    token = paired_token(app, tmp_path)
    headers = {"authorization": f"Bearer {token}"}
    assert test_client.get("/api/search?q=", headers=headers).json()["error"] == "E_BAD_QUERY"
    assert test_client.get("/api/search?q=" + "x" * 101, headers=headers).status_code == 400
    assert test_client.get("/api/search?q=ok&page=0", headers=headers).json()["error"] == "E_BAD_PAGE"
    assert test_client.get("/api/search?q=ok&page=11", headers=headers).status_code == 400


def test_search_rate_limits_per_phone(tmp_path):
    async def fake(query, page):
        return []

    test_client, app = client(tmp_path, fake)
    token = paired_token(app, tmp_path)
    headers = {"authorization": f"Bearer {token}"}
    codes = [test_client.get("/api/search?q=ok", headers=headers).status_code for _ in range(31)]
    assert codes[:30] == [200] * 30
    assert codes[30] == 429


def test_search_reports_an_upstream_failure_as_502(tmp_path):
    async def fake(query, page):
        raise UpstreamError("boom")

    test_client, app = client(tmp_path, fake)
    token = paired_token(app, tmp_path)
    response = test_client.get("/api/search?q=ok", headers={"authorization": f"Bearer {token}"})
    assert response.status_code == 502
    assert response.json()["error"] == "E_UPSTREAM"
    assert "boom" not in response.text
```

- [x] **Step 2: Run to watch them fail**

Run: `cd ~/developer/freetube-remote && uv run pytest tests/test_search.py -q`
Expected: `ModuleNotFoundError: app.invidious`; after that, `TypeError: create_app() got an unexpected keyword argument 'search'`.

- [x] **Step 3: Write the Invidious client**

`app/invidious.py`:

```python
"""One Invidious call, normalized. No web framework here either."""

import httpx

SEARCH_TIMEOUT_S = 8.0


class UpstreamError(Exception):
    """The instance did not answer with a usable list."""


def normalize(item: dict, base: str) -> dict:
    thumbnails = item.get("videoThumbnails") or []
    pick = next((t for t in thumbnails if t.get("width", 0) >= 320), None) or (thumbnails[0] if thumbnails else {})
    url = str(pick.get("url") or "")
    if url.startswith("/"):
        url = base.rstrip("/") + url
    return {
        "videoId": str(item.get("videoId") or ""),
        "title": str(item.get("title") or ""),
        "author": str(item.get("author") or ""),
        "lengthSeconds": int(item.get("lengthSeconds") or 0),
        "thumbnail": url,
    }


def make_search(base: str, timeout: float = SEARCH_TIMEOUT_S):
    async def search(query: str, page: int) -> list[dict]:
        url = f"{base.rstrip('/')}/api/v1/search"
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    url, params={"q": query, "type": "video", "page": page}
                )
        except httpx.HTTPError as error:
            raise UpstreamError(str(error)) from error
        if response.status_code != 200:
            raise UpstreamError(f"status {response.status_code}")
        try:
            items = response.json()
        except ValueError as error:
            raise UpstreamError("not json") from error
        if not isinstance(items, list):
            raise UpstreamError("not a list")
        return [normalize(item, base) for item in items if item.get("videoId")]

    return search
```

- [x] **Step 4: Wire config, the route and the limiter**

`app/config.py` — add the field and the env read:

```python
DEFAULT_INVIDIOUS = "https://invidious.joefoxing.it.com"
# in the dataclass, after public_base:
    invidious_base: str = DEFAULT_INVIDIOUS
# in from_env():
            invidious_base=os.environ.get("FREETUBE_REMOTE_INVIDIOUS", DEFAULT_INVIDIOUS),
```

`app/main.py`:

```python
SEARCH_LIMIT = 30
SEARCH_WINDOW_S = 60.0

def create_app(config: Config | None = None, search=None) -> FastAPI:
    ...
    search = search or make_search(config.invidious_base)
    search_limiter = AttemptLimiter(limit=SEARCH_LIMIT, window_s=SEARCH_WINDOW_S)
    app.state.search_limiter = search_limiter

    @app.get("/api/search")
    async def api_search(request: Request, q: str = "", page: int = 1) -> JSONResponse:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        player_id = rooms.lookup_token(token)
        if player_id is None:
            return JSONResponse({"error": "E_UNAUTHORIZED"}, status_code=401)
        query = q.strip()
        if not 1 <= len(query) <= 100:
            return JSONResponse({"error": "E_BAD_QUERY"}, status_code=400)
        if not 1 <= page <= 10:
            return JSONResponse({"error": "E_BAD_PAGE"}, status_code=400)
        key = f"search:{player_id}"
        if not search_limiter.allow(key):
            return JSONResponse({"error": "E_RATE_LIMITED"}, status_code=429)
        search_limiter.record(key)
        try:
            results = await search(query, page)
        except UpstreamError:
            return JSONResponse({"error": "E_UPSTREAM"}, status_code=502)
        return JSONResponse({"query": query, "page": page, "results": results})
```

`pyproject.toml`: move `httpx>=0.28` from `[dependency-groups].dev` into `[project].dependencies`
(keep it in dev too — `TestClient` needs it either way).

- [x] **Step 5: Run the suite**

Run: `uv run pytest tests -q`
Expected: 35 passed (29 + 6). Then `uv run --with httpx python -c "from app.invidious import make_search"`.

- [x] **Step 6: One live call against the real instance**

```bash
uv run python - <<'PY'
import asyncio
from app.invidious import make_search
print(asyncio.run(make_search("https://invidious.joefoxing.it.com")("3blue1brown", 1))[:1])
PY
```

Expected: one dict with an absolute `thumbnail`; red if the instance is down (then say so, do not fake it).

- [x] **Step 7: Commit**

```bash
cd ~/developer/freetube-remote
git add app/invidious.py app/config.py app/main.py pyproject.toml uv.lock tests/test_search.py
git commit -m "feat(bridge): token-gated Invidious search proxy"
```

---

### Task 2: The phone's search sheet

**Files:**
- Modify: `~/developer/freetube-remote/web/index.html`, `web/app.js`, `web/app.css`
- Test: `~/developer/freetube-remote/tests/test_static.py` (shell serves the sheet and app.js posts to `api/search`)

**Interfaces:**
- Consumes: `GET /api/search` from Task 1; `requestOpen(videoId)` (the refactor of Stage 2's `openLink`).
- Produces: DOM ids `find-open`, `find` (sheet), `find-input`, `find-submit`, `find-results`, `find-error`, `find-close`.

- [x] **Step 1: Write the failing test**

```python
def test_the_shell_offers_a_search_sheet(tmp_path):
    page = client(tmp_path).get("/")
    for dom_id in ("find-open", "find-input", "find-results", "find-close"):
        assert f'id="{dom_id}"' in page.text
    assert "api/search" in (WEB_DIR / "app.js").read_text()
```

- [x] **Step 2: Run to watch it fail** — `uv run pytest tests/test_static.py -q`, 1 failure.

- [x] **Step 3: Markup** — a button beside the pill and a sheet after `main#remote`:

```html
  <section class="find">
    <button id="find-open" type="button">Search</button>
  </section>
  <section id="find" class="sheet" hidden>
    <header><input id="find-input" type="search" placeholder="Search YouTube" autocomplete="off">
      <button id="find-submit" type="button">Go</button>
      <button id="find-close" type="button" class="quiet">Close</button></header>
    <p id="find-error" class="error" role="alert"></p>
    <ul id="find-results"></ul>
  </section>
```

- [x] **Step 4: Behaviour** — in `app.js`, next to `openLink`:

```js
async function search() {
  const query = $('find-input').value.trim()
  $('find-error').textContent = ''
  if (!query) return
  const response = await fetch(`${BASE}api/search?q=${encodeURIComponent(query)}`, {
    headers: { authorization: `Bearer ${store.token}` },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    $('find-error').textContent =
      body.error === 'E_RATE_LIMITED' ? 'Too many searches. Wait a minute.' : 'Search failed.'
    return
  }
  $('find-results').replaceChildren(...body.results.map(result => {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'result'
    const img = document.createElement('img'); img.src = result.thumbnail; img.alt = ''
    const text = document.createElement('span')
    const title = document.createElement('strong'); title.textContent = result.title
    const author = document.createElement('em'); author.textContent = result.author
    text.append(title, author)
    button.append(img, text)
    button.addEventListener('click', () => { requestOpen(result.videoId); showFind(false) })
    li.append(button)
    return li
  }))
}
function showFind(open) { $('find').hidden = !open; if (open) $('find-input').focus() }
```

with `openLink()` split into `requestOpen(videoId)` (validate/await/ack handling, now taking an id)
plus the input-reading wrapper, and `document.addEventListener('keydown', e => { if (e.key === 'Escape') showFind(false) })`.

- [x] **Step 5: Next/prev buttons** — the transport row becomes
  `prev · −10 s · play · +10 s · next`, sending `command('next')` / `command('prev')`.

- [x] **Step 6: Run both suites** — `uv run pytest tests -q && node --test "tests-web/*.test.mjs"`.
  Expected: 36 pytest, 3 node.

- [x] **Step 7: Commit** — `feat(phone): search sheet and skip buttons`.

---

### Task 3: `next` / `prev` in the agent, wired to the skip events

**Files:**
- Modify: `~/developer/freetube/src/renderer/remote/agent.js`, `src/renderer/remote/index.js`,
  `src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js`
- Test: `~/developer/freetube/tests/remote-agent-connection.test.cjs`

**Interfaces:**
- Consumes: `registerPlayer(video, getMeta, actions)` where
  `actions = { next(): void, prev(): void }`.
- Produces: agent commands `next`, `prev`; `E_NO_PLAYER` when no actions are registered.

- [x] **Step 1: Failing tests**

```js
test('next and prev call the registered actions', async () => {
  FakeSocket.instances = []
  const calls = []
  const video = new EventTarget()
  Object.assign(video, { paused: true, currentTime: 0, duration: 100, volume: 1, muted: false, playbackRate: 1 })
  const agent = await makeAgent({
    video,
    getActions: () => ({ next: () => calls.push('next'), prev: () => calls.push('prev') }),
  })
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 20, cmd: 'next' })
  socket.receive({ t: 'cmd', id: 21, cmd: 'prev' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['next', 'prev'])
  assert.deepEqual(socket.sent.filter(m => m.t === 'ack'), [
    { t: 'ack', id: 20, ok: true }, { t: 'ack', id: 21, ok: true }
  ])
})

test('next without a player element is E_NO_PLAYER', async () => {
  FakeSocket.instances = []
  const agent = await makeAgent()
  agent.start()
  const socket = FakeSocket.instances.at(-1)
  socket.open()
  socket.sent.length = 0
  socket.receive({ t: 'cmd', id: 22, cmd: 'next' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(socket.sent.find(m => m.t === 'ack'), { t: 'ack', id: 22, ok: false, code: 'E_NO_PLAYER' })
})
```

- [x] **Step 2: Run to watch them fail** — `node --test "tests/remote-agent-connection.test.cjs"`.

- [x] **Step 3: Implement** — in `agent.js` add `getActions = () => null` to the options and, in
  `onCommand`, before the media element lookup:

```js
    if (message.cmd === 'next' || message.cmd === 'prev') {
      const action = getActions()?.[message.cmd]
      if (typeof action !== 'function') {
        send({ t: 'ack', id: message.id, ok: false, code: 'E_NO_PLAYER' })
        return
      }
      action()
      send({ t: 'ack', id: message.id, ok: true })
      return
    }
```

  `index.js`: hold `actions` in a module variable, set by
  `registerPlayer(video, getMeta, actions = null)`, and pass `getActions: () => actions` to
  `createRemoteAgent`. `ft-shaka-video-player.js`, in the existing `onMounted`:

```js
      registerPlayer(video.value, () => ({ ... }), {
        next: () => emit('skip-to-next'),
        prev: () => emit('skip-to-prev'),
      })
```

- [x] **Step 4: Run the app suite** — `node --test "tests/**/*.test.cjs"`. Expected: 64 passed.

- [x] **Step 5: Commit (app repo)** — `feat(remote): next and prev through the skip buttons`.

---

### Task 4: A share target, so a shared link lands in the phone app

**Files:**
- Modify: `~/developer/freetube-remote/web/manifest.webmanifest` (`share_target`),
  `app/main.py` (`GET /share` serves the shell), `web/app.js` (BASE from `import.meta.url`,
  read `?url=` on load)

**Interfaces:**
- Produces: `https://…/remote/share?url=<link>` renders the app; when paired and the link parses,
  it opens on the TV immediately, otherwise the link is prefilled in the open box.

- [x] **Step 1: Failing test** — `/share?url=https://youtu.be/arj7oStGLkU` returns 200 and the shell
  `<script src="app.js">`; the manifest contains `"share_target"`.
- [x] **Step 2: Implement** — `BASE` becomes `new URL('.', import.meta.url).pathname` (this also
  fixes any deep link, which the old `location.pathname` derivation broke); `start()` reads the
  `url` param and calls `requestOpen(parseVideoId(value))` when paired, else fills `#open-link`.
- [x] **Step 3: Run both suites, then commit.**

---

### Task 5: Live evidence and documentation

- [x] **Step 1:** restart the bridge (`systemctl --user restart freetube-remote`), confirm health 200.
- [x] **Step 2:** with a paired phone context, `fetch('/remote/api/search?q=…')` without the header
  → 401; with the token → results with absolute thumbnails (record count and one videoId).
- [x] **Step 3:** tap a result on the phone → the player's hash becomes `#/watch/<that id>`;
  record the milliseconds from tap to hash change.
- [x] **Step 4:** press next → the player's route/video changes (or, with no playlist and no
  recommendation, the ack is still `ok` and nothing changes — record which happened, honestly).
- [x] **Step 5:** append a "Stage 3" section to `~/developer/freetube-remote/docs/verification.md`,
  change the spec's Stage 3 line to measured, commit both repos.

---

## Self-Review

- Spec Stage 3 ("next/prev over the playing playlist, browse/search proxied by the bridge that
  holds the Invidious base URL") maps to Tasks 1–3; Task 4 closes the Stage 2 share-target gap
  the spec listed but the Stage 2 build did not ship.
- Abuse: the only new public surface is a token-gated, rate-limited, 8 s-bounded proxy; no
  unauthenticated path to Invidious exists.
- Type consistency: `search(query, page)` is the same name in the client, the tests and the
  route; `getActions()` returns the `{next, prev}` object used by both the agent and `index.js`.
- No placeholders: every step names files, code and the command that proves it.

---

## Build log

* `registerPlayer` gained a third argument (`actions = {next, prev}`) instead of the agent
  importing the store: the shaka player component already emits `skip-to-next` / `skip-to-prev`,
  so the remote reuses the exact path the on-screen buttons take and `Watch.js` keeps its
  playlist-vs-autoplay decision.
* `next`/`prev` run before the media-element lookup (like `open`), and answer `E_NO_PLAYER`
  when no actions are registered — consistent with what the phone already understands.
* Search results need no new phone code path: a row is `requestOpen(result.videoId)`, so it
  inherits the ack/awaiting behaviour and the "The TV has not opened that link." guard.
* `BASE` moved to `new URL('.', import.meta.url).pathname`. The old `location.pathname`
  derivation produced `/remote/share/` on the share target, which would have pointed the
  socket at `/remote/share/ws`.
