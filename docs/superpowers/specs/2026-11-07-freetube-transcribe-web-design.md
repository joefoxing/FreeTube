# FreeTube transcribe in the browser — the same feature in the web build, over Tailscale HTTPS

**Date:** 2026-11-07
**Status:** Implemented and verified — see `## Verification run` below
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
| Page opened over the old plain-HTTP origin | the transcribe click fails there: that origin is not in the CORS allowlist, so the service refuses the preflight (measured: `OPTIONS /jobs 400`, no `POST`) and the overlay shows the mapped service-unreachable message; the copy call also throws (`navigator.clipboard` is undefined on that origin) and the app shows its existing "copying failed" notice. Serving the preview over Tailscale HTTPS is what fixes both |
| Service unreachable or refused | the existing mapped message; no crash |
| Bogus token | `401` → the existing "the transcription service rejected the token" message |
| Second click while a job runs | the existing busy toast, with the backend's in-flight guard as the backstop |
| Browser reload mid-job | the job completes on the service, the browser loses the handle, the user re-runs — the same outcome as closing the Electron window |
| `ctrl+t` pressed in the browser | Chrome reserves it for a new tab and a page cannot intercept it, so the button is the entry point in the web build; the binding stays correct in Electron |
| A `serve` entry absent or its port taken | the page is not reachable over HTTPS; the settings URL points at an origin that does not answer, which is visible as the unreachable message rather than a silent failure |

## Cost

Measured on this host, not estimated: the app suite is 31 tests in ~0.3 s
(`node --test "tests/**/*.test.cjs"`), the service suite is 39 passed (40 collected, 1
deselected) in ~0.9 s (`uv run pytest tests -q`), and a transcription job's only cost is CPU on
the local service (whisper `base`, 4 threads). Nothing in this design is paid, and the two new
`serve` entries cost nothing.

## What this does not do

* No Windows build, no AppImage rebuild, no packaging change.
* No change to Electron behaviour beyond the one enablement term (the Electron path still uses
  the same IPC, and the settings section stays as it is).
* `ctrl+t` remains unsupported in the browser; a working binding there (a non-reserved key) is
  a separate decision, deliberately not guessed at here.
* No new settings fields, no new UI, no progress bars.
* **Cancelling does not cancel the job on the service.** Both backends abort the app's polling and
  forget the job, while the service's own `POST /jobs/{job_id}/cancel` route is never called: the
  client implements it (`src/main/transcribeClient.js:157`) and only its own test uses it. A
  cancelled job therefore runs to completion and its result is discarded. That is the landed
  Electron behaviour, reproduced deliberately by the web backend rather than changed here — fixing
  it means one call in each backend and a decision about whether a cancelled job should also stop
  the CPU it is using.
* The already-recorded residuals stay: the overlay anchor point on wide viewports, the
  never-built clamp toast, blur-only settings commits, and the renderer's correlation logic
  having no unit test.
* Nothing is merged anywhere without a separate go.

## Verification

* `tests/test_api.py` (service) — extended with the CORS cases: an allowed origin gets
  `access-control-allow-origin`, a disallowed one does not, and the preflight `OPTIONS`
  carrying `Authorization` succeeds. Run `cd /home/joefox/developer/freetube-stt && uv run
  pytest tests -q` (39 pass, 40 collected, 1 deselected today, the new CORS cases included).
* `tests/transcribe-backend-web.test.cjs` (app, new) — with an injected fake client, in the
  style of `tests/transcribe-ipc.test.cjs`: a second `start` while one is in flight rejects
  with the `E_BUSY` shape, and `cancel` aborts the in-flight request. Run `node --test
  "tests/**/*.test.cjs"` (31 today).
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

## Verification run

Date: 2026-11-07 (EST), branch `freetube-transcribe-web` @ `293c668ad` (the commit this run
verifies; the run itself changes only this file). Host: the live dev box. Harness: a real
Chromium driven through the agent browser tool (`HeadlessChrome/153.0.0.0`), against the two
Tailscale HTTPS entries — preview `https://nextcloud.taild1347f.ts.net:9447/`, service
`https://nextcloud.taild1347f.ts.net:9446` — plus the old plain-HTTP preview
`http://100.77.173.63:9080/` for the negative case. Service = the systemd user unit
`freetube-transcribe.service` (yt-dlp 2026.10.26, whisper `base`). Video `arj7oStGLkU`
(TED, 14:04). The token is never printed anywhere in this run; its length (43) is quoted where
relevant, and it was set in the app by reading the unit's `EnvironmentFile` inside the tool and
piping it into the store without ever echoing it.

The checks below are the brief's; each is followed by the raw output that shows its result.

**Check 1 — Settings → Player Settings → Transcript: the URL and token persist across a
reload. PASS.** Set in the live page, then a full `Page.reload`, then read back from the
running store and from the `NeDB` IndexedDB the web build persists settings into:

```
store getter after reload: getTranscriptionServiceUrl = https://nextcloud.taild1347f.ts.net:9446
store getter after reload: getTranscriptionToken.length = 43
IndexedDB "NeDB"/nedbdata settings record:
  [{"_id":"transcriptionServiceUrl"…}, {"_id":"transcriptionToken","len":43}]
```

**Check 2 — open a video, seek to `t≈300`, the Transcribe button is present in the control
bar. PASS.** The player mounts `ft_transcribe` into the shaka control panel once the service
URL is set (it is absent when the URL is empty):

```
.transcribe-button -> {present:true, hidden:false, label:"Transcribe this video (ctrl+t)", width:48}
```

The button is only reachable after the shaka UI finishes mounting, which in this headless
harness requires the tab to be foregrounded (see the limitation below).

**Check 3 — click it and read back the overlay. PASS.** Clicking the button:

```
before click: {state:"idle",    visible:false, window:{start:0,end:0}}
after  click: {state:"running", visible:true,  window:{start:240,end:480}, stage:"fetching"}
...
final: {state:"done", stage:"transcribing", progress:1, segments:60}
```

Overlay as read from the live DOM:

```
window label: "4:00 – 8:00"
line count:   60
first line:   [4:05] There is a difference.
second line:  [4:07] Both brains have a rational decision maker in them, but the procrastinators brain also has an instant gratification monkey.
third line:   [4:14] Now, what does this mean for the procrastinator? Well, it means everything's fine until this happens.
last line:    [7:57] And importantly, he's the only thing...
```

**Check 4 — the same window fetched independently from the service opens with the same words.
PASS.** `POST /jobs {"videoId":"arj7oStGLkU","startSeconds":240,"endSeconds":480}` against the
service directly (host-side, `Bearer <token>`), polled to completion:

```
state=done segments=60
first 3: [(245.39, 'There is a difference.'),
          (247.59, 'Both brains have a rational decision maker in them, but the procrastinators brain also has an instant gratification monkey.'),
          (254.83, "Now, what does this mean for the procrastinator? Well, it means everything's fine until this happens.")]
last 2:  [(475.26, 'a career disaster or some other scary consequence.'),
          (477.9, "And importantly, he's the only thing...")]
```

Character-for-character identical to the overlay's first/second/third and last lines for the
same window.

**Check 5 — click a transcript line and confirm it seeks to that timestamp. PASS.** (The playhead was moved by setting `currentTime` — the same property the app's `setCurrentTime` writes through — because no media plays in this harness; see the caveat below.) Clicking
overlay lines moved the media element (which the app reads through
`$refs.player.getCurrentTime()` / writes through `setCurrentTime`, i.e. `video.currentTime`)
to the line's own timestamp:

```
click line[20] "[5:29] If you're a dog and you spend your whole…" -> currentTime 300    -> 329.52
click line[45] "[7:00] …"                                      -> currentTime 329.52 -> 420.87
```

**Check 6 — a second click while a job runs shows the busy toast and creates no second job.
PASS.** Two `click()`s on `.transcribe-button`, the second while the first job was still
running:

```
after 1st click: {state:"running", stage:"fetching", window:{start:360,end:601}}
busy toast:      ["Already transcribing this video"]   (Video.Player.Transcribe.Busy)
after 2nd click: {state:"running", segments:0}
$ journalctl --user -u freetube-transcribe.service | grep -c 'POST /jobs'
before the two clicks: 55
after  the two clicks: 56
```

The count rose by exactly one across the pair; the second click never reached the service.
(Only *one* `POST /jobs` line, `14:51:21 … 201 Created`, is attributable to the pair.)

**Check 7 — set a deliberately bogus token, run one job, the app shows the rejected-token
message with no crash; restore the real token. PASS.** Store token replaced with the 27-char
string `bogus-token-for-testing-000`, button clicked:

```
after bogus click: {state:"error", code:"E_UNAUTHORIZED"}
overlay error text: "The transcription service rejected the token"   (with a Retry button)
$ journalctl … | grep 'POST /jobs' | tail -1
… "POST /jobs HTTP/1.1" 401 Unauthorized
```

The real token (43 chars) was restored and `store.getters.getTranscriptionToken === <the unit's
token>` re-checked as `true`.

**Check 8 — after the job completes, the clipboard matches the overlay text. PASS.**
`navigator.clipboard.readText()` on the same secure origin, compared against the overlay's own
plain-text form and against the rendered DOM (the later job, window `4:05 – 8:05`, 44 lines):

```
winLabel:"4:05 – 8:05", lines:44
clipboard length : 4097
overlay DOM text : 4097   clipEqualsOverlayDom: true
expected [m:ss] text: 4097   clipEqualsExpected: true
```

(`Video.Player.Transcribe.Copied` fired on completion — `transcriptCopied:true`. The clipboard
served by `navigator.clipboard` rather than `xclip`; this origin is a secure context, so no OS
clipboard was needed.)

**Check 9 — `ctrl+t` on the watch page. NOT VERIFIED HERE (harness limitation); see below.**
Recorded outcome: the harness runs headless Chromium, which has no browser chrome, so Chrome's
reserved-shortcut behaviour (open a new tab, never deliver the key to the page) cannot be
reproduced. A `ctrl+t` injected through CDP is delivered to the renderer, i.e. it is the
opposite of the real-browser path:

```
keys seen by the page: ["key=t ctrl=true defaultPrevented=false"]
tabs before == tabs after (no new tab opened)
app state after: {state:"running", visible:true, segments:0}   <- the page's own binding fired
```

This is a CDP artifact, not the recorded browser limitation and not evidence for it. The
limitation itself (Chrome reserves `ctrl+t`, so the web build's entry point is the button)
stands by inspection of the browser model; it could not be exercised on this host.

**Check 10 — negative case on the old `http://100.77.173.63:9080` origin. PASS.** Same URL and
token set in that origin's store, then Transcribe clicked:

```
window.isSecureContext: false
typeof navigator.clipboard: "undefined"
after click: {state:"error", code:"E_SERVICE_UNREACHABLE"}
overlay error text: "Transcription service is not reachable"   (with a Retry button)
$ journalctl … --since '14:53' | grep 'OPTIONS /jobs'
… "OPTIONS /jobs HTTP/1.1" 400 Bad Request     <- the preflight is refused (origin not in the allowlist)
… "OPTIONS /jobs HTTP/1.1" 400 Bad Request
$ journalctl … --since '14:54' | tail
-- No entries --                               <- no POST /jobs ever arrives from that origin
```

The copy path on that origin, exercised through the app's own `copyTranscript`:

```
typeof navigator.clipboard: "undefined"
direct navigator.clipboard.writeText -> TypeError: Cannot read properties of undefined (reading 'writeText')
app toast: "Transcript is shown, but copying to the clipboard failed"   (transcriptCopied:false)
```

**Automated suites.**

```
$ cd /home/joefox/developer/freetube && node --test "tests/**/*.test.cjs"
1..31
# tests 31
# pass 31
# fail 0
# duration_ms 200.266359
```

```
$ cd /home/joefox/developer/freetube-stt && uv run pytest tests -q
39 passed, 1 deselected, 34 warnings in 0.84s
```

(The brief predicted 41 service tests here; the actual collection is `39/40 tests collected
(1 deselected)`, the deselected one being the `-m "not network"` case. 39 pass.)

**Known limitations / not verified here.**

- **Video playback of the YouTube source could not be demonstrated on this host, and so
  "playback uninterrupted" is NOT VERIFIED HERE.** The configured Invidious instance
  (`yt.chocolatemoo53.com`) 302-redirects the DASH manifest (`/api/manifest/dash/id/<id>?local=true`)
  to a companion host that answers `403`, and the non-proxied manifest's segments are
  `googlevideo.com` URLs that send no `access-control-allow-origin`; both paths are unusable
  from the browser, so the `<video>` element never receives media
  (`readyState:0`, `duration:null`) and cannot play. Every other reachable Invidious instance
  was probed for the same manifest and none returned a usable `application/dash+xml` either
  (`502`/`530`/timeout/`text/html`). Checks 3–6 therefore run against a mounted, configured
  player with no playing media: the playhead was positioned by setting the media element's
  `currentTime` (`=300`, which is exactly what the app's `getCurrentTime()` reads), and
  click-to-seek was verified as the playhead moving to the segment timestamp — not as a video
  re-position during playback. Nothing here touches the transcribe path, which drives the
  service by `videoId` and is independent of playback.
- **The player mount is foreground-sensitive in this headless harness.** With the tab hidden
  (`document.visibilityState === 'hidden'`), the shaka UI never finishes mounting (the
  `MediaSource` `sourceopen` never fires), so `registerTranscribeButton` is never reached and
  the button does not appear — the same is true for the pre-existing screenshot/theatre
  buttons. Bringing the tab to the front (`Page.bringToFront` + focus emulation) makes the
  button appear and is required for every check above. This is a harness/timing property, not
  a defect in the diff; it is recorded because a run that skips it will wrongly conclude the
  button is missing.
- **The automatic copy on completion is focus-dependent in this harness.** In the first job
  the auto-copy left `transcriptCopied:false` (the write was refused while the tab had lost
  focus); with the tab foregrounded, a later job's auto-copy set `transcriptCopied:true` and
  left the formatted transcript on the clipboard (check 8). Both the auto path and the manual
  "Copy Transcript" button were observed to produce an exact match.
- **`ctrl+t` is not verifiable here** (check 9): headless Chromium has no browser chrome, and a
  CDP-dispatched key is delivered to the page rather than intercepted, so the recorded
  limitation could not be reproduced. A real browser is required.
- **The negative-case origin's settings were set in the headless browser's own storage only.**
  The user's preview at `http://100.77.173.63:9080` was neither restarted, stopped nor
  reconfigured; the two origins' settings live in separate per-origin IndexedDB and the
  headless profile is separate from the user's browser.
