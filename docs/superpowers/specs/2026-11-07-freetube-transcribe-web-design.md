# FreeTube transcribe in the browser — the same feature in the web build, over Tailscale HTTPS

**Date:** 2026-11-07
**Status:** Approved (design approved in chat this session; NOT yet implemented)
**Repo:** `/home/joefox/developer/freetube` (app) and `/home/joefox/developer/freetube-stt`
(service), plus tailnet `serve` configuration
**Closes:** the Electron-only gap that made the landed transcribe feature unreachable from
Windows — the app branch merged as `0cdffb1f1`, spec
`docs/superpowers/specs/2026-11-07-freetube-transcribe-design.md`

## The request (user, verbatim)

> "how do i use the feature, i don't see any button to transcribe"

Two decisions taken from the offered options (recorded as decisions, not as quotes):

* Make it work in the browser preview already in use, rather than a Windows build or a
  forwarded server window.
* Serve the preview over Tailscale HTTPS with a new `tailscale serve` entry, and give the
  service its own HTTPS entry too, so the clipboard works properly and the token stops
  crossing the tailnet in plaintext.

## The problem

The landed feature is Electron-only by construction, and the user's only route to FreeTube
from Windows is the browser preview. `_scripts/webpack.web.config.js:181` hard-sets
`process.env.IS_ELECTRON = false` for the web build; `Watch.js:226` computes
`transcribeEnabled = process.env.IS_ELECTRON && this.transcriptionServiceUrl !== ''`, so
neither the button nor the `ctrl+t` binding can appear there; and `Watch.js` calls
`window.ftElectron` directly at `:417` (`onTranscribeStatus`), `:458` (`transcribeStart`) and
`:606` (`transcribeCancel`) — a preload-only object. Measured on the running preview in a real
Chromium: `typeof window.ftElectron === 'undefined'`. The symptom the user reported is the
first of these: no button.

Two further consequences of that origin, both measured on the same page:
`navigator.clipboard` is **undefined** (`http://100.77.173.63:9080` is not a secure context —
not HTTPS, not localhost), so the copy path at `Watch.js:572` cannot work at all in the
browser; and the service on `:9099` speaks plain HTTP with a bearer token, so the token
crosses the tailnet in the clear.

## The decision

Add a **transcribe backend**: one renderer-side object with the three members `Watch.js`
already calls — `start(payload)` returning `{jobId, startSeconds, endSeconds, view}`,
`cancel(jobId)`, `onStatus(handler)` returning an unsubscribe — with two implementations
selected at **build** time by a webpack alias, following the pattern the data layer already
uses (`DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$`, aliased at
`_scripts/webpack.renderer.config.js:198` and `_scripts/webpack.web.config.js:207`):

```
TRANSCRIBE_BACKEND_ELECTRON_OR_WEB
  -> src/renderer/transcribe/backend/electron.js   (renderer build; wraps window.ftElectron — the existing IPC, unchanged)
  -> src/renderer/transcribe/backend/web.js        (web build; drives the existing electron-free client directly)
```

`src/renderer/transcribe/backend/index.js` is the single import site, mirroring
`src/datastores/handlers/index.js`. `Watch.js` keeps its state machine, its overlay and its
click-to-seek untouched: only its three call sites move, and its `transcribeEnabled` drops the
`IS_ELECTRON` term.

Serving: the preview and the service each get their own `tailscale serve` HTTPS entry
(ports `9446` and `9447`; `9443`–`9445` are already taken by the three existing entries), the
service's allowlist gains the resulting HTTPS preview origin, and the settings' service URL
becomes the HTTPS one.

Rejected alternatives: a Windows build of the app (needs a Node/pnpm toolchain on the Windows
side and does not help the preview the user actually uses); a forwarded server window (`xvfb`
plus an X server or VNC on the Windows side); and the same-origin variant (one HTTPS entry
with the service mounted under a path, needing no CORS at all) — rejected because it ties the
service URL to the preview's origin, so the same build breaks if the preview is ever reached
differently.

## The rules (and why)

| rule | reason |
|---|---|
| The backend is an aliased module pair chosen at build time, never a runtime `IS_ELECTRON` branch | the web build has no preload and no `ipcRenderer`; a runtime branch would still pull the Electron implementation into the web bundle and fail there rather than at build time |
| `Watch.js` talks only to the backend, never to `window.ftElectron` | that object does not exist in the web build (measured `undefined`), so each direct call is a `TypeError` there |
| The web backend drives `src/main/transcribeClient.js` unchanged | the client has zero imports and uses global `fetch`, so it already runs in a browser; reusing it keeps a single implementation of polling, timeout, cancel, window arithmetic and error mapping between the two builds |
| `transcribeEnabled` keeps the service-URL term and drops only `IS_ELECTRON` | the two builds then differ only by environment, and a profile with no service URL still hides the button instead of failing at click time |
| The web backend enforces its own single in-flight job and emits the same view shape | main's reservation, `E_BUSY` and status gating have no counterpart in the browser; matching the shape keeps `Watch.js`'s state machine and the overlay unchanged |
| CORS is an explicit allowlist held in `Config`, defaulting to the HTTPS preview origin | the browser refuses a request from an origin that is not allowed, and a refused preflight is indistinguishable from an unreachable service to the user; a config value means adding an origin is not a code edit |
| The preview and the service are each served over Tailscale HTTPS | `navigator.clipboard` exists only in a secure context (measured absent on the http origin), and an HTTPS page cannot fetch `http://` (mixed content, which would block the service call) |
| The bearer token is unchanged, but now travels over TLS | authentication does not change; only the transport does, closing the plaintext-token exposure the http service has today |

## Failure modes

| case | behaviour |
|---|---|
| Preview origin missing from the allowlist | the browser blocks the request before it reaches the service; the overlay shows the mapped service-unreachable message; the fix is the `Config` line |
| Page opened over the old plain-HTTP origin | the copy call throws and the app shows its existing "copying failed" notice; the rest of the feature works |
| Service unreachable or refused | the existing mapped message; no crash |
| Bogus token | `401` → the existing "the transcription service rejected the token" message |
| Second click while a job runs | the existing busy toast, with the backend's in-flight guard as the backstop |
| Browser reload mid-job | the job completes on the service, the browser loses the handle, the user re-runs — the same outcome as closing the Electron window |
| `ctrl+t` pressed in the browser | Chrome reserves it for a new tab and a page cannot intercept it, so the button is the entry point in the web build; the binding stays correct in Electron |
| A `serve` entry absent or its port taken | the page is not reachable over HTTPS; the settings URL points at an origin that does not answer, which is visible as the unreachable message rather than a silent failure |

## Cost

Measured on this host, not estimated: the app suite is 28 tests in ~0.3 s
(`node --test "tests/**/*.test.cjs"`), the service suite is 35 tests in 0.89 s
(`uv run pytest tests -q`), and a transcription job's only cost is CPU on the local service
(whisper `base`, 4 threads). Nothing in this design is paid, and the two new `serve` entries
cost nothing.

## What this does not do

* No Windows build, no AppImage rebuild, no packaging change.
* No change to Electron behaviour beyond the one enablement term (the Electron path still uses
  the same IPC, and the settings section stays as it is).
* `ctrl+t` remains unsupported in the browser; a working binding there (a non-reserved key) is
  a separate decision, deliberately not guessed at here.
* No new settings fields, no new UI, no progress bars.
* The already-recorded residuals stay: the overlay anchor point on wide viewports, the
  never-built clamp toast, blur-only settings commits, and the renderer's correlation logic
  having no unit test.
* Nothing is merged anywhere without a separate go.

## Verification

* `tests/test_api.py` (service) — extended with the CORS cases: an allowed origin gets
  `access-control-allow-origin`, a disallowed one does not, and the preflight `OPTIONS`
  carrying `Authorization` succeeds. Run `cd /home/joefox/developer/freetube-stt && uv run
  pytest tests -q` (35 today; the count rises by the new cases).
* `tests/transcribe-backend-web.test.cjs` (app, new) — with an injected fake client, in the
  style of `tests/transcribe-ipc.test.cjs`: a second `start` while one is in flight rejects
  with the `E_BUSY` shape, and `cancel` aborts the in-flight request. Run `node --test
  "tests/**/*.test.cjs"` (28 today).
* A mutation pass for each new gate: break it (remove the origin from the allowlist; remove
  the in-flight guard), expect RED, restore, and confirm the suite is green and the file is
  unchanged.
* Live, in a real browser against the HTTPS origin (not the `xvfb` Electron harness): set the
  service URL and token in Settings → Player Settings → Transcript, open a video, click
  Transcribe, and read back the overlay's line count, its first and last lines, the same window
  fetched independently from the service (`probes/b6-window-fetch.py`) compared against those
  lines, the busy toast on a second click, the bogus-token message, and the clipboard contents
  after the automatic copy.
* The negative case as evidence for the secure-context claim: load the page once over the old
  `http://100.77.173.63:9080` origin and confirm the copy fails with the app's notice.
