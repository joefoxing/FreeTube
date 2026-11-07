# FreeTube Transcribe Feature — Design

Date: 2026-11-07
Branch: `freetube-transcribe` (off `development`, FreeTube 0.26.0, ee191b0a2)
Status: awaiting review

## 1. Goal

While a video is playing, the user clicks a Transcribe button in the player. The
app produces a timestamped transcript of the audio around the current playback
position — default window `[t − 60 s, t + 180 s]` — and shows it in an overlay
over the player, with a copy button. The video keeps playing while transcription
runs.

Success criteria:

- Click → timestamped text in the overlay in well under a minute for a 4-minute
  window, with the video never pausing.
- Text corresponds to the video's own audio at the requested time offsets.
- Nothing about the feature changes playback behaviour or blocks the UI.

## 2. Non-goals (v1)

- No live/streaming transcription, no word-level karaoke timing.
- No translation, no speaker diarization, no transcript persistence/history.
- No replacing FreeTube's existing caption/subtitle pipeline.
- No transcript for Invidious-API playback paths beyond what the window requires
  (the fetch is by video ID, so it is independent of the playback API).
- No bundled STT in the app: this is explicitly not the "ship whisper.cpp inside
  the Electron app" design. Revisit only if the service dependency proves
  unacceptable.

## 3. What the probe established (measured, not assumed)

All numbers below come from runs on this host (i7-4770, 8 threads, no GPU,
ffmpeg 7.1.5, Debian 13) during the design probe; artifacts in
`/home/joefox/developer/freetube-devweb/probe/`.

### 3.1 The app cannot fetch the audio itself (as of this checkout)

`streaming_data.adaptive_formats` returns 44 audio-only formats for every
InnerTube client tried (WEB, ANDROID, IOS, MWEB, TV, WEB_EMBEDDED), with
`playability_status = OK`, but no decipherable URL — `format.decipher()` throws
`No valid URL to decipher` and youtubei.js's `download()` range path has no URL
to range-request. This is consistent with the app's own playback: FreeTube
streams through `SabrSchemePlugin` against `server_abr_streaming_url` (SABR/UMP),
so there is no per-track HTTP URL in play. Consequence: "the app downloads the
audio slice itself" is not a v1 option; it would mean implementing a SABR/UMP
harvester in the app.

### 3.2 A service-side fetch of the exact window works, and is fast

```
yt-dlp --js-runtimes node --no-playlist -f "bestaudio[abr<=80]/bestaudio" \
  --download-sections "*<start>-<end>" -o "<tmp>/%(id)s.%(ext)s" \
  "https://www.youtube.com/watch?v=<id>"
```

- 240 s window (the production window): 1.6 MB, fetched in 7.9 s.
- 190 s window at a higher audio itag: 3.2 MB, 1 m 43 s — itag choice matters;
  keep the low-bitrate selector and allow a fallback chain.
- Requested offsets are honoured exactly: a `*0-30` slice of a test video opens
  with that video's real first line, while a `*60-240` slice opens with different
  content.
- A window running past the end of the video degrades to the whole video
  (19 s video, `*0-20` → 19.0 s file) instead of erroring.
- Cuts land on segment boundaries and overshoot at the END by up to ~10 s
  (60 s request → 70.0 s; 240 s → 250.0 s). The service must trim with ffmpeg.
- `--js-runtimes node` is mandatory on this host: without a JS runtime yt-dlp
  exposes only m3u8-bound formats and the audio itags are unavailable
  ("Requested format is not available"). `--js-runtimes node` uses the installed
  Node 22; no deno install needed.
- Pinned version used: yt-dlp 2026.10.26 (installed via `uv tool install yt-dlp`).

### 3.3 CPU speech-to-text is fast enough

faster-whisper 1.2.1, model `base`, `compute_type=int8`, `cpu_threads=4`:

- 250 s of audio → 17.8 s (14x realtime), 45 timestamped segments, language
  detected `en` p=1.00, model load 0.5–0.7 s.
- 190 s of audio → 13.7 s (13.8x realtime), 33 segments.
- Accuracy on sampled English speech was clean at `base`.

Hard dependency found: **faster-whisper 1.2.1 is incompatible with PyAV 19**
(`av.open() got an unexpected keyword argument 'metadata_errors'`; PyAV removed
it, 17/18 accept it). `av==18.0.0` is required and must be pinned. `small` is
better quality but unmeasured here and likely at or below realtime on this CPU —
it stays a config option, not the default.

### 3.4 End-to-end

~26 s from click to transcript for the 4-minute production window (7.9 s fetch +
17.8 s transcribe + overhead), CPU-only, video unaffected.

## 4. Architecture

Two deliverables:

1. **The app change** — in this checkout: a player button, a main-process HTTP
   client with progress plumbing, an overlay component, settings and i18n.
2. **The transcription service** — a new project at
   `/home/joefox/developer/freetube-stt/`: FastAPI + faster-whisper + yt-dlp,
   run as a systemd user unit on this host, reachable over the tailnet at
   `100.77.173.63:9099`, bearer-token authenticated.

Division of responsibility: the app is a thin client — it sends the video ID and
window, renders what comes back. All YouTube fetching, audio decoding and STT
happen in the service. This keeps the Electron app free of native dependencies,
which is what makes the Windows build work without per-platform binaries, and it
keeps the media bytes off the tailnet entirely (only JSON crosses).

Data flow:

```
player button (renderer)
  -> CustomEvent 'transcribe' from the shaka control bar
  -> ft-shaka-video-player emits 'transcribe' to Watch.js
  -> Watch.js: window = [clamp(t - pre), clamp(t + post)] from store settings
  -> window.ftElectron.transcribeStart({videoId, startSeconds, endSeconds, serviceUrl, token})
  -> main: POST /jobs, then poll GET /jobs/{id} every 1 s
     -> 'transcribe-status' events back to the renderer
  -> Watch.js state -> FtTranscript overlay (spinner/stage -> segments -> copy)
```

Service pipeline per job: queue → yt-dlp section fetch to a temp dir → ffmpeg
trim to the exact window, downmix mono 16 kHz WAV → faster-whisper → segments
with absolute video timestamps (service adds `startSeconds`) → temp cleanup.

## 5. Interfaces

### 5.1 Service HTTP API

Auth: `Authorization: Bearer <token>` on every route except `/health`
(constant-time compare). All errors are JSON `{error: {code, message}}`.

- `GET /health` → `{status, ytdlpVersion, whisperModel, modelLoaded, queueDepth}`
- `POST /jobs` body `{videoId, startSeconds, endSeconds, language?}` →
  `201 {jobId, state: "queued", startSeconds, endSeconds}`
- `GET /jobs/{jobId}` →
  `{jobId, state, stage, progress, segments[], language, error, timings}`
  - `state`: `queued | running | done | error | cancelled`
  - `stage`: `queued | fetching | decoding | transcribing`
  - `progress`: 0..1, monotonic per stage
  - `segments`: `[{start, end, text}]`, `start`/`end` in **absolute video
    seconds**, so the renderer can seek directly
  - `timings`: `{fetchMs, decodeMs, transcribeMs}`
- `POST /jobs/{jobId}/cancel` → `200 {state: "cancelled"}`

Status codes: `401` bad/missing token, `404` unknown job, `409` queue full,
`422` invalid window (`end <= start`, window > `FT_MAX_WINDOW_SECONDS`),
`503` model not loaded yet.

Config via env (defaults shown): `FT_TRANSCRIBE_TOKEN` (required),
`FT_TRANSCRIBE_HOST=100.77.173.63`, `FT_TRANSCRIBE_PORT=9099`,
`FT_WHISPER_MODEL=base`, `FT_WHISPER_THREADS=4`,
`FT_MAX_WINDOW_SECONDS=600`, `FT_JOB_RETENTION_SECONDS=600`,
`FT_QUEUE_DEPTH=4`.

Concurrency: one worker (whisper is configured for 4 threads of 8 cores; two
concurrent jobs would slow each other more than they help), FIFO queue, jobs
retained 10 minutes then evicted.

### 5.2 App IPC contract

`src/constants.js` → `IpcChannels`:
`TRANSCRIBE_START: 'transcribe-start'` (invoke),
`TRANSCRIBE_CANCEL: 'transcribe-cancel'` (send),
`TRANSCRIBE_STATUS: 'transcribe-status'` (main → renderer event).

`src/preload/interface.js`:
`transcribeStart(payload)` → `Promise<{jobId}>`, rejects with
`{code, message}`; `transcribeCancel(jobId)`; `onTranscribeStatus(cb)`.

`src/main/index.js` handler responsibilities: validate the payload, refuse a
second job while one is running, POST to the service, poll at 1 s, forward
stage/progress/segments to the sender, enforce a total timeout
(`fetch 120 s + transcribe 240 s`), cancel the service job on timeout or
`TRANSCRIBE_CANCEL`, and map every failure to a code the UI can localise
(`E_SERVICE_UNREACHABLE`, `E_UNAUTHORIZED`, `E_FETCH_FAILED`,
`E_TRANSCRIBE_FAILED`, `E_TIMEOUT`, `E_BUSY`).

The renderer passes `serviceUrl` and `token` in the payload (settings live in the
renderer store, matching how FreeTube handles comparable settings); main holds no
settings state.

### 5.3 Renderer

- `components/ft-shaka-video-player/player-components/TranscribeButton.js` —
  modelled on `ScreenshotButton.js`: a control-bar + overflow-menu button that
  dispatches a `transcribe` CustomEvent. Registered in
  `ft-shaka-video-player.js` next to `registerScreenshotButton()`, with
  `'transcribe'` added to `emits`. The button label uses
  `addKeyboardShortcutToActionTitle(i18n.global.t(...), KeyboardShortcuts.VIDEO_PLAYER.GENERAL.TRANSCRIBE)`
  exactly as the screenshot button does, and the shortcut is wired into
  `keyboardShortcutHandler`.
  - Keyboard shortcut (decided): `TRANSCRIBE: 'ctrl+t'` in
    `VIDEO_PLAYER.GENERAL`. Plain `t` is already THEATRE_MODE, so `ctrl+t` is the
    mnemonic non-colliding choice.
  - Icon (decided): a new `PlayerIcons` entry holding the `d` attribute of the
    Material Symbols `transcribe` glyph — these custom player components use
    Material Symbols, not FontAwesome
    (`https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded/transcribe/default/24px.svg`),
    per the note at the top of the `PlayerIcons` block in `constants.js`.
- `components/FtTranscript/FtTranscript.vue` — overlay anchored inside the player
  container: loading (spinner + stage text + cancel), done (scrollable
  timestamped lines, click a line to seek, Copy, Close), error (message +
  Retry). Rendered from `Watch.vue` inside the existing player wrapper;
  `Watch.js` owns the state and subscribes to status events.
- On completion the plain-text transcript is copied to the clipboard
  automatically (decided), using the same Clipboard API pattern the player
  already uses for screenshots, with a toast confirming it; the Copy button
  re-copies. Clipboard failure is non-fatal — the overlay still shows the text
  and says the copy failed.
- Desktop-only: the button and overlay are hidden when `process.env.IS_ELECTRON`
  is false (the web build has no IPC layer).

### 5.4 Settings and i18n

`components/PlayerSettings/PlayerSettings.vue` gains a Transcribe section:
service URL (text), token (password), seconds before (default 60), seconds after
(default 180). Store keys: `transcriptionServiceUrl` (''),
`transcriptionToken` (''), `transcriptionSecondsBefore` (60),
`transcriptionSecondsAfter` (180). Empty URL = feature hidden/disabled.

New strings go in `static/locales/en-US.yaml` only (per the project docs);
Weblate handles the rest.

## 6. Error handling

- Service unreachable → toast "Transcription service is not reachable" + the URL
  that was tried; overlay closes.
- Fetch failure (gated/removed video, network) → overlay shows the stage that
  failed and a Retry button; partial results are discarded.
- Busy → second click while a job runs is a no-op with a toast ("already
  transcribing"), and switching videos cancels the in-flight job.
- Long windows are clamped to `FT_MAX_WINDOW_SECONDS` with a toast saying so.
- The service never returns a partially-filled transcript as success; a failure
  is a failure.

## 7. Testing and verification

Service (real suite, pytest):
- unit: window validation/clamping, timestamp offsetting, queue depth, cancel,
  auth failure, error mapping — with the fetcher and transcriber stubbed so the
  suite is offline and deterministic.
- integration (opt-in marker `network`): real fetch + real transcribe of a fixed
  video window; asserts the known opening words and that segment timestamps fall
  inside the requested window.

App (honest state): FreeTube ships no test runner in this checkout (no `test`
script, no vitest/jest config), so app-side verification is `pnpm run lint` plus
live verification — not a unit suite. Adding a runner is out of scope for this
feature.

Live verification I will actually perform and report:
1. Start the service; `GET /health` shows the pinned yt-dlp version and a loaded
   model.
2. `pnpm run dev --remote-debug` under Xvfb; attach over CDP to the renderer
   (port 9223), navigate to a watch page, seek to a known `t`, trigger the
   transcribe flow.
3. Read the overlay's DOM text out of the live renderer and compare it against an
   independent service-side transcript of the same window — the words must
   match, and timestamps must map into `[t − 60, t + 180]`.
4. Confirm playback was not interrupted (player still playing, currentTime
   advanced) and that a second click while busy is refused.
5. Press `ctrl+t` in the player and confirm it drives the identical flow.
6. After completion, assert the clipboard actually holds the transcript text
   (`navigator.clipboard.readText()` in the page, else Electron's
   `clipboard.readText()`), and that the confirmation toast appeared.

## 8. Deployment / ops

- Service dir `/home/joefox/developer/freetube-stt` (uv project, venv inside it),
  model cache in `~/.cache/huggingface` — both under `/home` per the host's disk
  rule (the root filesystem is small).
- systemd user unit `freetube-transcribe.service`, bound tailnet-only, logs to the
  journal. Token generated at install and printed once.
- Runbook for yt-dlp drift: pin the version in the project's lockfile; upgrade
  deliberately with `uv tool upgrade yt-dlp` and re-run the network test; the
  health endpoint reports the version in use so drift is visible.

## 9. Risks and limitations

- yt-dlp can break when YouTube changes (the single biggest external
  dependency). Mitigation: pinned version, health-visible version, one-command
  upgrade path, and the failure surfaces as a clear overlay error.
- Signed/gated content (age-restricted, login-only) may fail service-side even
  though the app can play it — the service fetches from this host with no
  account.
- CPU contention: ~4 of 8 threads for ~20 s per job; a 10-minute window would
  take roughly a minute.
- `base` model accuracy is limited on music, heavy accents, or overlapping
  speech; `small` is available via config with unmeasured (likely worse than
  realtime) speed here.
- Bandwidth: ~1.6 MB per 240 s window at the low-bitrate selector.
- The feature is desktop-only by design.

## 10. Build order

1. Service: API skeleton, auth, job store/queue → fetch → ffmpeg → whisper, unit
   suite, network test, systemd unit. Prove `/health` and one real job end to end
   with curl.
2. App plumbing: `IpcChannels`, preload methods, main handler + polling.
3. UI: TranscribeButton + player event, `FtTranscript` overlay in `Watch`,
   settings section, i18n strings.
4. Live verification per section 7, then lint, then hand over for review.

## 11. Decisions taken from review

- Keyboard shortcut: yes — `ctrl+t` (plain `t` is THEATRE_MODE).
- Auto-copy: yes — a finished transcript is copied to the clipboard
  automatically, with the overlay's Copy button as the manual re-copy.
