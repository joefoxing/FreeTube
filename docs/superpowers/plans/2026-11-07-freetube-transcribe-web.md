# FreeTube Transcribe — Web Build Implementation Plan (Phase C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the transcribe feature work in the web build the user reaches from Windows — the button appears there when a service URL is set, the browser talks to the service directly, and the clipboard works because the page is served over Tailscale HTTPS.

**Architecture:** The renderer stops calling `window.ftElectron` directly and calls a *transcribe backend* instead: one module with `start`/`cancel`/`onStatus`, implemented twice and selected at build time by a webpack alias (the pattern `src/datastores/handlers/index.js` already uses). The Electron implementation wraps the existing IPC; the web implementation drives the same electron-free service client the main process uses, enforcing one job at a time in browser-local form. The service learns an explicit CORS allowlist from its own config, and both the preview and the service are exposed over Tailscale HTTPS so the page is a secure context.

**Tech Stack:** Vue 3 (Options API in `Watch.js`), webpack 5 aliases, FastAPI + Starlette `CORSMiddleware`, Node 22's built-in test runner (`node:test`), Tailscale `serve` for TLS.

**Spec:** `docs/superpowers/specs/2026-11-07-freetube-transcribe-web-design.md`

**Depends on:** the landed Phase B feature (app `development` @ `0cdffb1f1`) and the Phase A service (`/home/joefox/developer/freetube-stt`, `master` @ `427953c`). The task numbers continue the earlier plans, which used `(B1)`…`(B8)`.

## Global Constraints

- App repo: work on a new branch `freetube-transcribe-web` created from `development` @ `0cdffb1f1`. Never commit to `development`.
- Service repo: `/home/joefox/developer/freetube-stt` has only `master`; commit there, as Phase A did.
- No new npm dependencies, no new Python dependencies.
- App unit tests live in `tests/*.test.cjs`, use `node:test` + `node:assert/strict`, and load application modules with a dynamic `import()` inside the test body. Run them as `node --test "tests/**/*.test.cjs"` (28 tests today).
- Service tests: `cd /home/joefox/developer/freetube-stt && uv run pytest tests -q` (35 tests today).
- `pnpm run lint` cannot run on this checkout (`ERR_REQUIRE_CYCLE_MODULE`, pre-existing and unrelated) — commit with `git commit --no-verify`.
- `src/renderer/transcribe/backend/index.js` is the ONLY place the alias `TRANSCRIBE_BACKEND_ELECTRON_OR_WEB` is imported. `Watch.js` must not reference `window.ftElectron` at all after Task 1 (grep must come back empty).
- Any layer that emits status views must gate delivery on the job still being the live one: a torn-down job's late view must never reach the renderer. This is the invariant `src/main/transcribeIpc.js` enforces at the `send` closure and the web backend must reproduce — the Phase B fix wave exists because it was once missing.
- The alias pair must be added to BOTH `_scripts/webpack.renderer.config.js` and `_scripts/webpack.web.config.js`; a one-sided alias resolves in one build and fails in the other.
- i18n: `static/locales/en-US.yaml` only, and this phase adds no keys.
- The worker path must never run two jobs at once: main enforces it with `activeJobs`, the web backend with its own `current` entry, and the service's queue is the backstop.

---

### Task 1 (C1): The transcribe backend pair, and the web build's enablement

**Files:**
- Create: `src/renderer/transcribe/backend/index.js`
- Create: `src/renderer/transcribe/backend/electron.js`
- Create: `src/renderer/transcribe/backend/web.js`
- Create: `tests/transcribe-backend-web.test.cjs`
- Modify: `_scripts/webpack.renderer.config.js` (alias block, after line 198)
- Modify: `_scripts/webpack.web.config.js` (alias block, after line 207)
- Modify: `src/renderer/views/Watch/Watch.js` (imports after line 47; `transcribeEnabled` at 226; `mounted` at 416-420; `transcribeStart` at 458; `transcribeCancel` at 606)

**Interfaces:**
- Consumes: `window.ftElectron.transcribeStart/transcribeCancel/onTranscribeStatus` (preload, Electron build only — `src/preload/interface.js:147-172`); `createTranscribeClient()` from `src/main/transcribeClient.js`, which returns `{ startJob({serviceUrl, token, videoId, startSeconds, endSeconds, signal}), waitForJob({serviceUrl, token, jobId, onUpdate, signal, pollIntervalMs, fetchTimeoutMs, transcribeTimeoutMs}), cancelJob(...) }` and has zero imports.
- Produces: `start(payload) -> Promise<{jobId, startSeconds, endSeconds, view}>`, `cancel(jobId) -> void`, `onStatus(handler) -> () => void`, and (web module only, for tests) `createWebBackend({ client })` returning those three.

- [ ] **Step 1: Create the aliased backend pair**

`src/renderer/transcribe/backend/index.js`:

```js
// src/renderer/transcribe/backend/index.js
//
// The renderer's only handle on transcription. The implementation behind the
// alias is chosen at build time — the Electron renderer talks to the main
// process over IPC, the web build talks to the service directly — exactly as
// the datastore handlers are selected.
export {
  start,
  cancel,
  onStatus
} from 'TRANSCRIBE_BACKEND_ELECTRON_OR_WEB'
```

`src/renderer/transcribe/backend/electron.js`:

```js
// src/renderer/transcribe/backend/electron.js
//
// Electron renderer backend: everything goes through the preload's IPC surface,
// which is what the app used directly before this backend existed.

/**
 * @param {{ videoId: string, startSeconds: number, endSeconds: number, serviceUrl: string, token: string }} payload
 * @returns {Promise<{ jobId: string, startSeconds: number, endSeconds: number, view: object }>}
 */
export function start(payload) {
  return window.ftElectron.transcribeStart(payload)
}

/**
 * @param {string} [jobId]
 */
export function cancel(jobId) {
  window.ftElectron.transcribeCancel(jobId)
}

/**
 * @param {(view: object) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onStatus(handler) {
  return window.ftElectron.onTranscribeStatus(handler)
}
```

- [ ] **Step 2: Create the web backend**

`src/renderer/transcribe/backend/web.js`:

```js
// src/renderer/transcribe/backend/web.js
//
// Web build backend. There is no preload and no ipcRenderer in the browser, so
// this drives the electron-free service client directly — the same module the
// main process uses, so polling, timeouts, window arithmetic and error mapping
// have one implementation rather than two.
//
// It reproduces main's rules in browser-local form: one job at a time, cancel by
// id, and status views pushed with the same shape the IPC backend delivers.
// Delivery is gated on the job still being the live one, so a torn-down job's
// late view can never reach the renderer.
import { createTranscribeClient } from '../../../main/transcribeClient.js'

/**
 * @param {{ client?: ReturnType<typeof createTranscribeClient> }} [options]
 */
export function createWebBackend({ client = createTranscribeClient() } = {}) {
  /** @type {Set<(view: object) => void>} */
  const listeners = new Set()

  /** @type {{ jobId: string | null, controller: AbortController } | null} */
  let current = null

  function emit(view) {
    for (const listener of listeners) {
      listener(view)
    }
  }

  return {
    /**
     * @param {{ videoId: string, startSeconds: number, endSeconds: number, serviceUrl: string, token: string }} payload
     * @returns {Promise<{ jobId: string, startSeconds: number, endSeconds: number, view: object }>}
     */
    async start({ videoId, startSeconds, endSeconds, serviceUrl, token }) {
      if (current !== null) {
        const error = new Error('a transcription is already running')
        error.code = 'E_BUSY'
        throw error
      }

      const entry = { jobId: null, controller: new AbortController() }
      current = entry

      const emitIfCurrent = view => {
        if (current === entry) {
          emit(view)
        }
      }

      try {
        const job = await client.startJob({
          serviceUrl,
          token,
          videoId,
          startSeconds,
          endSeconds,
          signal: entry.controller.signal
        })
        entry.jobId = job.jobId

        const view = await client.waitForJob({
          serviceUrl,
          token,
          jobId: job.jobId,
          onUpdate: emitIfCurrent,
          signal: entry.controller.signal
        })

        return { jobId: job.jobId, startSeconds, endSeconds, view }
      } catch (error) {
        // Gated like every other view: a job the user already cancelled must not
        // surface as a failure on whatever request is current now.
        emitIfCurrent({
          jobId: entry.jobId,
          state: 'error',
          stage: 'error',
          progress: 0,
          error: { code: error.code ?? 'E_TRANSCRIBE_FAILED', message: error.message }
        })
        throw error
      } finally {
        if (current === entry) {
          current = null
        }
      }
    },

    /**
     * @param {string} [jobId]
     */
    cancel(jobId) {
      const entry = current

      if (entry === null) {
        return
      }
      if (jobId !== undefined && jobId !== null && jobId !== entry.jobId) {
        return
      }

      // Tear the job down BEFORE aborting: the abort makes waitForJob reject, and
      // the catch above must not be able to deliver a view for a job the user has
      // already dismissed. (This is the opposite order to main's cancel handler,
      // where the abort cannot emit synchronously — here the gate is the guarantee.)
      current = null
      entry.controller.abort()
    },

    /**
     * @param {(view: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onStatus(handler) {
      listeners.add(handler)

      return () => {
        listeners.delete(handler)
      }
    }
  }
}

const backend = createWebBackend()

export const start = backend.start
export const cancel = backend.cancel
export const onStatus = backend.onStatus
```

- [ ] **Step 3: Write the failing test**

`tests/transcribe-backend-web.test.cjs`:

```js
// tests/transcribe-backend-web.test.cjs
//
// Unit tests for the web-build transcribe backend. The service client is
// injected, so a stub drives it exactly as a browser would.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const loadBackend = () => import('../src/renderer/transcribe/backend/web.js')

const payload = {
  videoId: 'abc',
  startSeconds: 0,
  endSeconds: 30,
  serviceUrl: 'https://example.invalid:9446',
  token: 't'
}

function cancelledError() {
  return Object.assign(new Error('cancelled'), { code: 'E_CANCELLED' })
}

// A waitForJob that resolves on demand: keeps one job "in flight" until the test
// says otherwise, and pushes one running view immediately.
function makeClient() {
  let settle = null

  return {
    startJob: async () => ({ jobId: 'j1' }),
    waitForJob: ({ onUpdate, signal }) => {
      onUpdate({ jobId: 'j1', state: 'running', stage: 'fetching', progress: 10 })

      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(cancelledError())
          return
        }

        signal.addEventListener('abort', () => reject(cancelledError()), { once: true })
        settle = () => resolve({ jobId: 'j1', state: 'done', stage: 'done', progress: 100, segments: [] })
      })
    },
    finish: () => settle()
  }
}

test('start returns main-process shaped result and pushes views to subscribers', async () => {
  const { createWebBackend } = await loadBackend()
  const client = makeClient()
  const backend = createWebBackend({ client })

  const seen = []
  const unsubscribe = backend.onStatus(view => seen.push(view))

  const running = backend.start(payload)
  await new Promise(resolve => setTimeout(resolve, 10))

  client.finish()

  const result = await running

  assert.equal(result.jobId, 'j1')
  assert.equal(result.startSeconds, 0)
  assert.equal(result.endSeconds, 30)
  assert.equal(result.view.state, 'done')
  assert.deepEqual(seen.map(view => view.state), ['running'])

  unsubscribe()
})

test('a second start while one is in flight rejects as busy', async () => {
  const { createWebBackend } = await loadBackend()
  const backend = createWebBackend({ client: makeClient() })

  const first = backend.start(payload)
  await new Promise(resolve => setTimeout(resolve, 10))

  await assert.rejects(backend.start(payload), error => error.code === 'E_BUSY')

  backend.cancel()
  await assert.rejects(first, error => error.code === 'E_CANCELLED')
})

test('cancel delivers no further status once the job is torn down', async () => {
  const { createWebBackend } = await loadBackend()
  const backend = createWebBackend({ client: makeClient() })

  const seen = []
  backend.onStatus(view => seen.push(view))

  const running = backend.start(payload)
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(seen.length, 1)

  backend.cancel()
  await assert.rejects(running, error => error.code === 'E_CANCELLED')

  // The catch's error view must be gated out: the user already dismissed the job.
  assert.equal(seen.length, 1)
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd /home/joefox/developer/freetube && node --test tests/transcribe-backend-web.test.cjs`
Expected: FAIL — `Cannot find module '../src/renderer/transcribe/backend/web.js'`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/transcribe-backend-web.test.cjs`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 6: RED-check the live-job gate**

Temporarily change `emitIfCurrent` in `web.js` to call `emit(view)` unconditionally, run the third test, and confirm it fails with `1 !== 2` (the error view now lands). Restore the gate and re-run: green.

- [ ] **Step 7: Register the alias in both webpack configs**

In `_scripts/webpack.renderer.config.js`, after the `DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$` line (198), add:

```js
      TRANSCRIBE_BACKEND_ELECTRON_OR_WEB$: path.resolve(__dirname, '../src/renderer/transcribe/backend/electron.js'),
```

In `_scripts/webpack.web.config.js`, after its `DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$` line (207), add:

```js
      TRANSCRIBE_BACKEND_ELECTRON_OR_WEB$: path.resolve(__dirname, '../src/renderer/transcribe/backend/web.js'),
```

- [ ] **Step 8: Point Watch.js at the backend**

Add to the import block, directly after line 47 (`import { clampTranscriptWindow, formatTranscriptText } from '../../helpers/transcript'`):

```js
import { start as transcribeStart, cancel as transcribeCancel, onStatus as onTranscribeStatus } from '../../transcribe/backend/index.js'
```

Replace `transcribeEnabled` (line 226):

```js
    transcribeEnabled: function () {
      return this.transcriptionServiceUrl !== ''
    },
```

Replace the `mounted` subscription (lines 416-420):

```js
  mounted: function () {
    this.onMountedDependOnLocalStateLoading()

    this.transcribeStatusUnsubscribe = onTranscribeStatus(this.handleTranscribeStatus)
  },
```

Replace the start call (line 458) — `const result = await window.ftElectron.transcribeStart({` becomes:

```js
        const result = await transcribeStart({
```

Replace the cancel call (line 606) — `window.ftElectron.transcribeCancel(this.transcriptJobId)` becomes:

```js
      transcribeCancel(this.transcriptJobId)
```

- [ ] **Step 9: Verify no direct preload use remains, and the whole suite is green**

Run: `grep -n "ftElectron" src/renderer/views/Watch/Watch.js`
Expected: no matches.

Run: `node --test "tests/**/*.test.cjs"`
Expected: `# tests 31`, `# pass 31`, `# fail 0` (28 before, plus the 3 new).

- [ ] **Step 10: Commit**

```bash
git add src/renderer/transcribe src/renderer/views/Watch/Watch.js _scripts/webpack.renderer.config.js _scripts/webpack.web.config.js tests/transcribe-backend-web.test.cjs
git commit --no-verify -m "feat(transcribe): build-time backend pair so the web build can transcribe"
```

---

### Task 2 (C2): The service's CORS allowlist

**Files:**
- Modify: `/home/joefox/developer/freetube-stt/app/config.py` (`Config` + `load_config`)
- Modify: `/home/joefox/developer/freetube-stt/app/main.py` (`create_app`)
- Modify: `/home/joefox/developer/freetube-stt/tests/test_config.py` (default + env override)
- Modify: `/home/joefox/developer/freetube-stt/tests/test_api.py` (the CORS cases)

**Interfaces:**
- Consumes: `Config` and `load_config(env=...)` as they exist today; `create_app(config, pipeline_factory, autostart)`.
- Produces: `Config.cors_origins: tuple[str, ...]` and the module constant `DEFAULT_CORS_ORIGINS`; every response now carries `access-control-allow-origin` for an allowlisted origin.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
ALLOWED_ORIGIN = CONFIG.cors_origins[0]


def test_cors_allows_the_configured_origin():
    client, _ = make_client()

    preflight = client.options(
        "/jobs",
        headers={
            "Origin": ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
        },
    )

    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == ALLOWED_ORIGIN
    assert "authorization" in preflight.headers["access-control-allow-headers"].lower()

    response = client.get("/health", headers={**HEADERS, "Origin": ALLOWED_ORIGIN})

    assert response.headers["access-control-allow-origin"] == ALLOWED_ORIGIN


def test_cors_refuses_an_unconfigured_origin():
    client, _ = make_client()

    response = client.get("/health", headers={**HEADERS, "Origin": "http://evil.example"})

    assert "access-control-allow-origin" not in response.headers
```

Append to `tests/test_config.py`:

```python
def test_cors_origins_default_to_the_https_preview_origin():
    config = load_config(env={"FT_TRANSCRIBE_TOKEN": "t"})

    assert config.cors_origins == ("https://nextcloud.taild1347f.ts.net:9447",)


def test_cors_origins_come_from_the_environment_as_a_comma_separated_list():
    config = load_config(env={"FT_TRANSCRIBE_TOKEN": "t", "FT_TRANSCRIBE_CORS_ORIGINS": "https://a.example, https://b.example ,"})

    assert config.cors_origins == ("https://a.example", "https://b.example")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /home/joefox/developer/freetube-stt && uv run pytest tests/test_api.py tests/test_config.py -q`
Expected: FAIL — `AttributeError: 'Config' object has no attribute 'cors_origins'`.

- [ ] **Step 3: Add the config field**

In `app/config.py`, add the module constant above `@dataclass`:

```python
# The browser build of the app calls this service from its own origin; the
# Tailscale HTTPS preview is the only one allowed unless the environment says
# otherwise, so a stray page cannot reach a token-protected service.
DEFAULT_CORS_ORIGINS = "https://nextcloud.taild1347f.ts.net:9447"
```

Add the field to `Config` (last, so the existing keyword construction is unaffected):

```python
    ytdlp_js_runtime: str
    cors_origins: tuple[str, ...]
```

In `load_config`, before the `return Config(`:

```python
    cors_origins = tuple(
        origin.strip()
        for origin in env.get("FT_TRANSCRIBE_CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
        if origin.strip()
    )
```

and pass it in the constructor:

```python
        ytdlp_js_runtime=env.get("FT_YTDLP_JS_RUNTIME", "node"),
        cors_origins=cors_origins,
```

- [ ] **Step 4: Add the middleware**

In `app/main.py`, add to the imports:

```python
from fastapi.middleware.cors import CORSMiddleware
```

and inside `create_app`, immediately after `app = FastAPI(title="freetube-transcribe")`:

```python
    # The web build of the app calls this service from the page's own origin;
    # the allowlist lives in Config so adding an origin is not a code edit.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.cors_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests -q`
Expected: `39 passed, 1 deselected` (35 before, plus 4 new: two api, two config).

- [ ] **Step 6: RED-check both gates**

Remove the `add_middleware` call, run `uv run pytest tests/test_api.py -q`, confirm the new CORS test fails (`KeyError: 'access-control-allow-origin'`), restore it. Then set `DEFAULT_CORS_ORIGINS = "https://evil.example"`, confirm `test_cors_refuses_an_unconfigured_origin` still passes but the config default test fails, and restore.

- [ ] **Step 7: Commit**

```bash
cd /home/joefox/developer/freetube-stt
git add app/config.py app/main.py tests/test_api.py tests/test_config.py
git commit -m "feat(cors): explicit origin allowlist from config"
```

---

### Task 3 (C3): Tailscale HTTPS for the preview and the service

This task changes host configuration only; it commits nothing. Its deliverable is two reachable HTTPS origins and the recorded URLs.

**Files:** none in either repo (operations only). `tailscale serve` state is the artifact.

**Interfaces:**
- Consumes: the running preview (`100.77.173.63:9080`, the webpack dev server) and the running service (`100.77.173.63:9099`, systemd user unit `freetube-transcribe.service`).
- Produces: `https://nextcloud.taild1347f.ts.net:9446` (service) and `https://nextcloud.taild1347f.ts.net:9447` (preview), both tailnet-only, both with a Tailscale-issued certificate.

- [ ] **Step 1: Confirm the ports are free and the pattern matches the existing entries**

Run: `ss -lntp | grep -E ':944[0-9]'`
Expected: 9443, 9444, 9445 listening on the tailscale interface; 9446 and 9447 absent. (`tailscale serve status` shows the three existing proxies to ports 5055, 5000 and 8000.)

- [ ] **Step 2: Add the two entries**

```bash
tailscale serve --bg --https=9446 http://100.77.173.63:9099
tailscale serve --bg --https=9447 http://100.77.173.63:9080
tailscale serve status
```

- [ ] **Step 3: Verify both origins answer over TLS**

```bash
curl -sS -o /dev/null -w "service %{http_code}\n" https://nextcloud.taild1347f.ts.net:9446/health
curl -sS -o /dev/null -w "preview %{http_code}\n" https://nextcloud.taild1347f.ts.net:9447/
```

Expected: `service 200` and `preview 200`, with no certificate warning on stderr.

- [ ] **Step 4: Verify the CORS default matches the preview origin**

Run: `curl -sS -D - -o /dev/null -H "Origin: https://nextcloud.taild1347f.ts.net:9447" https://nextcloud.taild1347f.ts.net:9446/health | grep -i access-control`
Expected: `access-control-allow-origin: https://nextcloud.taild1347f.ts.net:9447`.

If the preview's host or port differs from the default (because 9447 was taken, say), set the real origin and restart the unit instead of editing code:

```bash
systemctl --user edit freetube-transcribe.service   # Environment=FT_TRANSCRIBE_CORS_ORIGINS=https://<host>:<port>
systemctl --user daemon-reload && systemctl --user restart freetube-transcribe.service
```

- [ ] **Step 5: Verify the page is now a secure context**

Open `https://nextcloud.taild1347f.ts.net:9447/` in a real browser and evaluate:

```js
({ secure: window.isSecureContext, clipboard: typeof navigator.clipboard })
```

Expected: `{ secure: true, clipboard: 'object' }`. On the old `http://100.77.173.63:9080` origin the same expression returns `{ secure: false, clipboard: 'undefined' }` — that difference is the whole reason for this task.

---

### Task 4 (C4): Live end-to-end verification over HTTPS

**Files:**
- Modify: `docs/superpowers/specs/2026-11-07-freetube-transcribe-web-design.md` (append a `## Verification run` section)

**Interfaces:**
- Consumes: Tasks 1-3 (the backend, the allowlist, the two HTTPS origins).
- Produces: the recorded evidence, with real output quoted, and one commit touching only the spec.

- [ ] **Step 1: Run both suites and quote the counts**

```bash
cd /home/joefox/developer/freetube && node --test "tests/**/*.test.cjs"
cd /home/joefox/developer/freetube-stt && uv run pytest tests -q
```

Expected: 31 app tests; the service suite is `39 passed, 1 deselected` (40 collected — the `41` this step predicted was a miscount, corrected here), all passing.

- [ ] **Step 2: Drive the real browser against the HTTPS origin**

In a real Chromium (not the `xvfb` Electron harness), against `https://nextcloud.taild1347f.ts.net:9447/`:

1. Settings → Player Settings → Transcript: set the service URL to `https://nextcloud.taild1347f.ts.net:9446` and paste the token. Confirm both persist across a page reload.
2. Open a video, seek to roughly `t=300`, and confirm the Transcribe button is present in the control bar (it is absent on the `http` origin only when no URL is set — with the URL set it must be there in the web build).
3. Click it and read back from the overlay: the line count, the window label, and the first and last lines.
4. Fetch the same window independently from the service and compare the opening words character-for-character against the overlay's first lines.
5. Click a transcript line and confirm playback seeks to that timestamp.
6. Click Transcribe again while the job runs and confirm the busy toast appears and no second job is created (compare the service's `POST /jobs` count in `journalctl --user -u freetube-transcribe.service` before and after — it must rise by exactly one across the two clicks).
7. Set a deliberately bogus token, run one job, and confirm the "rejected the token" message with no crash; restore the real token (never print it).
8. Confirm the clipboard: after the job completes, read the clipboard contents back and check they match the overlay text (`navigator.clipboard.readText()` in the same page, or the OS clipboard with `xclip` on the harness display).
9. Press `ctrl+t` on the watch page and record what happens. Expected: Chrome opens a new tab and the page never receives the key, so no overlay appears — the recorded browser limitation, not a defect.

- [ ] **Step 3: Record the negative case**

On the old `http://100.77.173.63:9080` origin, set the same URL and token and click Transcribe: the service call is blocked (cross-origin, since that origin is not in the allowlist) and the copy path fails for want of a secure context. Record both exact messages.

- [ ] **Step 4: Append the verification run to the spec**

Add a `## Verification run` section in the style of the Phase B spec section 12: the date, the exact commands, the observed output per check (quoting it), and an explicit list of what did NOT pass or could not be verified. Never write "verified" without the output that shows it.

- [ ] **Step 5: Commit**

```bash
cd /home/joefox/developer/freetube
git add docs/superpowers/specs/2026-11-07-freetube-transcribe-web-design.md
git commit --no-verify -m "docs: web-build transcribe verification run"
```
