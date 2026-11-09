# A phone web app that drives the FreeTube preview — pairing, transport, and a bridge

**Date:** 2026-11-09
**Status:** BUILT (Stage 1) — branch `freetube-remote` in the FreeTube checkout, bridge in
`~/developer/freetube-remote`, live at `https://nextcloud.taild1347f.ts.net:10000/remote/`.
Stages 2–4 remain designed only.
Amended 2026-11-09: ingress moved from a tailnet-only Caddy vhost to **Tailscale Funnel**, because
the phone must work with Tailscale off.
**Repo:** `/home/joefox/developer/freetube` (renderer + settings), plus a new
`/home/joefox/developer/freetube-remote` (bridge service + phone PWA), plus a Funnel path on the
existing public port and a systemd user unit on this host.
**Addresses:** the use case in FreeTubeApp/FreeTube#7350 ("I was looking for a way to remote
control freetube on my PC from my phone; a simple web interface to play/pause, rewind/forward,
mute/unmute, change volume, would be great"), which is open upstream and unimplemented.

## The request (user, verbatim)

> "I want to design a remote control module using mobile phone. research and write a plan for that."

Then, asked what the phone should control, the answer was:

> "a phone web app that control the freetube app"

Scope taken from that: the phone is a **browser app on the phone** (no app store, no native
build), and the thing under control is **this FreeTube checkout as it is used today** — the web
build served at `https://metube.joefoxing.it.com` and watched from the Windows machine.

Then, on 2026-11-09:

> "i want it to work off-tailnet."

That reverses the first draft's ingress decision, so the bridge is published through **Tailscale
Funnel** (the house preference over Cloudflare) instead of a tailnet-only Caddy vhost. The player
page stays tailnet-only; only the bridge is public.

## What FreeTube holds today

| what | where | state today |
|---|---|---|
| The media element every control ends up at | `ft-shaka-video-player.vue:11` — `<video ref="video">` with `@play`, `@pause`, `@timeupdate`, `@volumechange`, `@ended` | present; the element is the whole surface a remote needs |
| The component's public surface | `ft-shaka-video-player.js:3452` — `expose({ hasLoaded, isPaused, pause, getCurrentTime, setCurrentTime, destroyPlayer })` | five members; nothing that seeks, changes volume, or plays |
| Internal transport helpers | same file: `handlePlay:1225`, `handlePause:1233`, `changeVolume:2092`, `seekBySeconds:2181` | component-private, not callable from outside |
| Hardware media keys | same file `:971` shaka `uiConfig.mediaSession.supportedActions = ['pause','play','seekbackward','seekforward','seekto']` | **already working** — this is what KDE Connect rides on, and it is why "media control" is not the gap |
| Routing | `src/renderer/router/index.js:19` — `createWebHashHistory()`; `/watch/:id` at `:125` | hash routes, so a video is reachable as `#/watch/<id>` |
| PWA shell | `src/index.ejs:9` manifest link, `:34-40` service-worker registration; `static/manifest.json`, `static/pwabuilder-sw.js` | installable shell already exists for the app itself |
| Settings defaults | `src/renderer/store/modules/settings.js:302` (`transcriptionServiceUrl`) | no remote-related key exists |
| Settings UI pattern | `PlayerSettings.vue:257-300` — `FtFlexBox` + `FtInput` rows under a heading, transcript block | the shape a Remote section copies |
| Build split | `_scripts/webpack.web.config.js:181` `IS_ELECTRON: false`; alias pattern at `:207`; precedent modules `src/renderer/transcribe/backend/{web,electron}.js` | the web build has no preload and no IPC; anything the phone needs must work in a plain browser |
| Any socket code | measured: `grep -rn 'WebSocket|socket.io' src` → 1 hit, `src/renderer/i18n/index.js`, unrelated | none; this is a new mechanism |
| Tests | `tests/*.test.cjs`, `node --test "tests/**/*.test.cjs"` | 37 tests before this work, 59 after, `node:test` only |

Deployment as it stands, measured this session:

* `freetube-web.service` (user unit) runs the webpack dev server on `100.77.173.63:9080`;
  `WorkingDirectory` must be the repo or the bundle compiles with 17 errors (the cwd trap).
* `/srv/proxy/Caddyfile` binds `default_bind 100.77.173.63 fd7a:…` — every site is reachable
  **only over Tailscale**, never on the wifi LAN, never publicly. The `(metube)` snippet at
  `:106` proxies to `:9080`; `reverse_proxy` carries WebSocket upgrades unchanged (the HMR
  socket already rides through it).
* `freetube-transcribe.service` on `:9099` is the precedent for "a small service next to the
  app, its own unit, its own env file".
* Ports in use near the choice: 9080, 9099; **9098 is free** (measured `ss -tln`).
* Node `v24.22.2` at `~/.local/node24/bin/node`; `uv` present; FastAPI is **not** in the system
  Python, so a `uv` project is required.

## The rule

**The player page is the only authority for playback; the bridge is a dumb authenticated relay
that holds the last state; the phone renders what the player last said and sends commands.** No
component owns a second copy of the truth, and the bridge never synthesises a position — it
forwards `position`, `playing`, `rate` and lets the phone extrapolate from the moment it received
them. Every consequence below follows from that one rule.

## Research: prior art, and why it does not settle this

| approach | what it gives | why it is not the answer here |
|---|---|---|
| KDE Connect (Linux/Windows + phone) | transport keys, volume, over the LAN | only transport, no browse/queue UI, and it needs a desktop session and a pairing daemon on the viewing machine; it is also already available and the user still asked for this |
| `fa7ad/freetube-tv` | a "smart-TV" YouTube web UI so the **official YouTube app** acts as the remote | it does not control FreeTube at all; it bypasses FreeTube's Invidious-backed data source and its own UI |
| YouTube Cast receiver (`yt-cast-receiver` family) | the polished TV-code pairing UX, official-app remote | needs DIAL/mDNS discovery, which does not cross the tailnet; the receiver speaks YouTube's protocol, not FreeTube's state; large surface for a self-hosted client |
| mpv `--input-ipc-server` / JSON IPC | proof that "player + socket + thin remote" is a standard shape | desktop-process-shaped: a browser page has no listening socket, so the socket has to live outside the page anyway |
| Pure deep links (`#/watch/<id>` opened on the TV) | zero new infrastructure | no transport control, which is the actual complaint |

What the research does settle: pairing by a short code shown on the big screen and entered on
the phone is the model users already know (YouTube's TV pairing), and a WebSocket relay is the
shape that works when neither side can accept an inbound connection.

## The design

### 1. Topology — three parts, one new process

```
phone, any network, Tailscale off
   │  https://nextcloud.taild1347f.ts.net:10000/remote/
   v
Tailscale Funnel relay  ──>  tailscaled on this box :10000  (TLS ends here)
   ^                             │  path /remote, prefix stripped before proxying (measured)
   │ wss .../remote/ws           v
player page (tailnet)  ──>  http://127.0.0.1:9098  freetube-remote.service
metube.joefoxing.it.com          │   loopback only: not on the LAN, not on the tailnet
                                 v
                             state file ~/.local/state/freetube-remote/state.json (0600):
                             players and phone tokens only; live playback state is memory-only
```

Measured this session, and the reason the ingress is shaped this way: Funnel may only listen on
`443`, `8443`, `10000`; `443` and `8443` are already Caddy's on this host and `10000` is already
the Nextcloud Funnel. So the bridge gets a **path on the existing Funnel port**, which is additive
and leaves Nextcloud untouched. `tailscale serve --set-path` strips the prefix before proxying
(measured: `/remote/app.js` arrived at the backend as `/app.js`), so the bridge's own routes stay
`/`, `/ws`, `/pair`, `/health`.

* The **bridge** is a new `uv` Python project: FastAPI + uvicorn, serving `GET /` (phone PWA
  static files), `GET /qr/{code}.svg` (pairing QR, `segno`), `POST /pair`, `GET /health`, and
  `WS /ws`.
* The **player agent** is new renderer code inside FreeTube (`src/renderer/remote/agent.js`,
  owned by a singleton in `src/renderer/remote/index.js` that `App.vue` starts); the player
  component registers its `<video>` element with it, so pairing can be started from Settings
  without a video open.
* The **phone client** is static HTML/CSS/JS in the bridge repo — no bundler, no framework, no
  install step. It is a PWA so it can be added to the home screen.

Python rather than Node because the host already runs a `uv` service next to FreeTube
(`freetube-stt`), and the bridge has no FreeTube code in it — nothing about it wants the app's
toolchain. Rejected: putting the socket server inside the webpack dev server (the HMR socket is
not an app protocol and does not exist in a production build).

### 2. Identity, pairing, tokens

* The player page generates a **device key** once (32 random bytes, base64url) and keeps it in
  `localStorage` under `freetube-remote-device-key` — deliberately *not* in the settings store,
  so it is not exported, synced, or shown in settings backups.
* The player's first frame is `{"t":"auth","role":"player","key":<device key>}`; the bridge maps
  it to a stable `playerId` (`p_…`) and stores only `sha256(key)`. Nothing goes in the query
  string, so no secret can reach an access log or a Referer.
* **Pairing is user-initiated.** The Settings block has a **Pair a phone** button; only then does
  the bridge open a pairing window — an **8-digit** code, TTL 300 s, single use, closed when
  claimed or expired. Nothing is guessable while the window is shut, which is almost always.
* The code is shown in Settings with its QR
  (`https://nextcloud.taild1347f.ts.net:10000/remote/#/pair?code=<code>`) and as plain digits.
* The phone exchanges the code via `POST /pair` for a **phone token** (32 random bytes), stored
  hashed on the bridge and in the phone's `localStorage`; it is presented in the first WS frame,
  never a URL, and is revocable ("Unpair all phones").
* Both roles are origin-checked: `Origin` must be in `FREETUBE_REMOTE_ALLOWED_ORIGINS` — default
  `https://metube.joefoxing.it.com` (player) and `https://nextcloud.taild1347f.ts.net:10000`
  (phone, port included) — else the socket closes 4403. Codes are compared with
  `secrets.compare_digest`.
* Pairing attempts are limited **globally** (20 per minute), because Funnel hides the client IP:
  measured, the backend sees the tunnel peer in `X-Forwarded-For`, not the person. With the
  window shut by default and 10⁸ codes, a sustained attacker gets ~10⁻⁷ per open window; the
  limit exists to bound the CPU and log noise, not to carry the security.

Rejected: per-IP limits (measured useless behind Funnel — every internet client looks like the
relay); PROXY protocol (`tailscale funnel --proxy-protocol` exists, but uvicorn cannot consume it
without a shim); Cloudflare Tunnel (house preference is Funnel); a PIN typed on the phone only (no
proof the person is in the room — the code must be read off the screen); a token in the URL path
(leaks in history, Referer and logs).

### 3. Protocol — one message family, JSON, versioned by field

Both roles open with an `auth` frame (above); an unauthenticated socket is closed with 4408 after
5 s. Then:

Player → bridge: `state` · `ack` · `pair-open` · `pair-close`.
Bridge → player: `hello` (playerId, last state) · `pair-code{code,pairUrl,expiresIn}` · `cmd` (with `id`).
Phone → bridge: `cmd` (bridge assigns `id`) · `ping`.
Bridge → phone: `hello` (playerId, online, last state) · `state` · `player` (online/offline) ·
`ack{id,ok,code?}` · `pong`.

State, published by the player, is the only mutable payload:

```json
{"videoId":"arj7oStGLkU","title":"…","channel":"…","thumbnail":"https://…",
 "duration":754.2,"position":123.4,"playing":true,"volume":0.8,"muted":false,
 "rate":1,"at":1762700000000}
```

It lives in the bridge's memory, not on disk: the player publishes about once a second, and a
JSON rewrite per frame is disk churn for data that a player reconnect refreshes within a second.
A bridge restart therefore shows the phone "nothing playing" until the player reconnects (which
it does automatically) — the state file holds players and phone tokens, never playback.

Writes to that file are serialised behind a lock with a per-write temp name, because FastAPI runs
sync routes like `POST /pair` in a threadpool while socket handlers run on the event loop and both
can save at once (measured: a shared `state.tmp` made the second `replace()` raise
`FileNotFoundError`).

`at` is the player's `Date.now()`. The phone uses **its own receipt time** for extrapolation, so
clock skew between phone and server cannot bend the progress bar; the error is one network hop.

Commands (the entire Stage-1 set, each mapped straight onto the media element):

| cmd | args | effect |
|---|---|---|
| `toggle` | — | `paused ? play() : pause()` |
| `play` / `pause` | — | `play()` / `pause()`; a rejected `play()` (autoplay policy) acks `E_NOT_ALLOWED` |
| `seek` | `to` seconds | clamp to `[0, duration]`, set `currentTime` |
| `seekBy` | `by` seconds | `currentTime ± by`, same clamp |
| `volume` | `value` 0–1 | `video.volume` |
| `mute` | `value` bool | `video.muted` |
| `rate` | `value` 0.25–3 | `video.playbackRate` |
| `open` | `videoId` | `location.hash = '#/watch/' + id` (the hash router navigates) |

Unknown commands ack `E_UNKNOWN_CMD` and change nothing — the bridge does not validate semantics,
the player does, so there is exactly one validator.

### 4. The player agent

`createRemoteAgent({ url, deviceKey, getVideo, getMeta, onPairCode, WebSocketImpl, now, timers })`
returns `{ start, stop, connected, pairCode }`. It is plain JS with no Vue and no Electron, so it
runs identically in the web build and in the packaged app (which is why Stage 4 is a verification
job, not a rewrite).

It is wired into `ft-shaka-video-player.js` next to the existing `expose(...)`, roughly 30 lines:
create on mount when the setting is on, `stop()` on unmount, and pass `getMeta` from the props
already in scope (`videoId`, `title`, `channelId`, `thumbnail`).

Publishing: on `play`, `pause`, `seeked`, `volumechange`, `ratechange`, `ended`,
`loadedmetadata`, plus a 1 s interval while playing and a 10 s heartbeat while paused — event-
driven first, because a background tab throttles timers and a timer-only design would freeze the
phone's progress bar.

Reconnect: exponential backoff 1, 2, 5, 10, 30 s with jitter; on `visibilitychange → visible`
reconnect immediately. The device key makes re-pairing unnecessary after a reload.

Autoplay is a named failure, not an assumption: a programmatic `play()` on a page with no user
activation may reject with `NotAllowedError`, so the agent catches it, acks `E_NOT_ALLOWED`, and
the phone renders "The TV page needs one tap to allow playback". This host's usual pattern
(Chrome media engagement on a site the user watches daily) makes it rare, not impossible.

### 5. The phone client

Two screens:

* **Pair** — 8-digit input (auto-filled from `#/pair?code=` when the QR is scanned), error text
  for expired/used codes, and the bridge's `/health` dot.
* **Remote** — thumbnail, title, channel; a scrubber with elapsed/total; transport row
  (−10 s, play/pause, +10 s); volume slider + mute; rate chips (0.5/1/1.5/2); a connection pill
  (live / reconnecting / TV offline); "Unpair".

It is a PWA served from the Funnel sub-path, so every URL is relative and derived from
`location.pathname` (`/remote/`): `manifest.webmanifest` uses `start_url: "./"` and `scope: "./"`,
the service worker registers with `scope: "./"`, and the socket is `${origin}/remote/ws`. It caches
the shell only (never `/ws`) and requests `navigator.wakeLock` while the remote screen is visible
(released on hide; failure is non-fatal). No framework: ~400 lines of
HTML/CSS/JS keeps the whole client auditable and removes a build step from a service that must
start on boot.

Position rendering is extrapolated locally between state frames:
`pos = state.position + (now − receivedAt)/1000 × state.rate` while playing, re-anchored on every
frame, so a 1 s publish interval still reads as a smooth clock.

### 6. Settings and enablement

New keys in `settings.js` defaults: `remoteControlEnabled: false`, `remoteControlUrl: ''`. A
**Remote Control** block in Settings → Player Settings, modelled on the Transcript block
(`FtFlexBox` rows), with: enable toggle, bridge URL field, a status line (`Connected as p_ab12` /
`Not connected`), a **Pair a phone** button, the 8-digit code plus QR while the window is open, and
an **Unpair all phones** button.

Because pairing must be startable from Settings while no video is open, the agent is owned by the
app, not by the player: `src/renderer/remote/index.js` is a singleton started by `App.vue`, and
`ft-shaka-video-player.js` registers its `<video>` element and metadata with it on mount and
clears them on unmount. That is also why the settings block can show connection status at all.

Disabled by default and off unless a URL is set, mirroring `transcribeEnabled`: the two builds
then differ only by environment, and a profile with no bridge configured never opens a socket.

Electron is included in Stage 1 by construction (the agent is environment-agnostic) but is not
verified until Stage 4; the settings block is visible in both builds, since hiding it would be a
second code path for no benefit.

### 7. Deployment

* New `freetube-remote.service` user unit: `Restart=always`, `Environment=FREETUBE_REMOTE_HOST=127.0.0.1`,
  `…_PORT=9098`, `…_STATE`, `…_ALLOWED_ORIGINS`, `…_PUBLIC_BASE=https://nextcloud.taild1347f.ts.net:10000/remote/`.
  No tailnet wait is needed — it binds loopback, and Funnel's own listener is tailscaled's problem.
* One Funnel command, persistent across reboots (`--bg`):

  ```
  tailscale funnel --bg --https=10000 --set-path /remote http://127.0.0.1:9098
  ```

  Resulting public URL: `https://nextcloud.taild1347f.ts.net:10000/remote/`. The Nextcloud Funnel
  stays at `/` on the same port; `tailscale funnel status` must still show
  `|-- / proxy http://127.0.0.1:8099` beside the new path.
* No Caddy change: `443` and `8443` belong to Caddy and may not be taken by Funnel, and the bridge
  is not reachable on the LAN or the tailnet at all — only through the relay.
* The player page is unchanged and stays tailnet-only; it dials the same public WSS URL. That
  costs one relay hop for 1 Hz JSON and keeps exactly one canonical origin (a second tailnet URL
  would mean pairing the phone twice, since tokens live in per-origin storage).

## What this changes for behaviour that exists today

| reader | change | safe because |
|---|---|---|
| `ft-shaka-video-player.js` | one import, ~30 lines in mount/unmount, no change to existing functions | the agent only reads the element and writes the same properties the UI writes |
| `expose(...)` surface | unchanged | the remote is internal to the component; the five exposed members stay as they are |
| Media Session / hardware keys | unchanged | the agent does not touch `navigator.mediaSession`; shaka's actions keep priority |
| `Watch.js` / `Watch.vue` | untouched | no Watch-level state is needed; the agent lives inside the player |
| settings store | three new keys with defaults | additive; defaults keep the feature off |
| PlayerSettings | one new block | additive; same components, same i18n discipline |
| web bundle | +~4 KB | measured after the build, not estimated here |
| `metube` vhost | unchanged | the phone client is a different origin |
| Tailscale Funnel :10000 | one added path `/remote` | additive; the existing `/` proxy to Nextcloud is untouched (measured `funnel status` shape) |
| Caddy | unchanged | the bridge is not proxied by Caddy any more; it listens on loopback only |

## Stages

Each stage lands alone and is useful alone.

1. **Transport** — bridge with pairing + relay, agent, settings block, phone Pair/Remote screens.
   Must land together: a bridge without an agent has nothing to talk to, and the settings block
   without the bridge is a dead switch.
2. **Cast a link** — an "Open a link" box on the Remote screen and a PWA share target; `open`
   command (already in the protocol above) plus URL parsing for `youtu.be`, `youtube.com/watch`,
   `#/watch/` and a bare 11-character id. Small, and it makes the phone a browsing device.
3. **Queue and search** — `next` / `prev` over the playing playlist, and browse/search proxied by
   the bridge (it holds the Invidious base URL) so the phone never talks to Invidious directly.
4. **Electron parity** — verify the same agent in the packaged app; no new renderer code unless
   packaging blocks the socket, in which case the transcribe-style backend split is the pattern.

## Evidence (the contract)

Each check must be able to go red. The mutation that removes the property is named for each.

**Stage 1 — bridge, automated (pytest, `uv run pytest tests`)**

* A pairing opened by the player is an 8-digit code with a 300 s TTL; `POST /pair` with it returns
  201 + token; replaying it returns 404 (mutation: drop the single-use flag → replay test goes red).
* No pairing exists until the player asks for one: `POST /pair` before `pair-open` is a 404
  (mutation: open a code at hello → red).
* An expired code returns 404 (`now` injected; mutation: drop the TTL check → red).
* The 21st attempt in a minute returns 429 (mutation: drop the limiter → red).
* An `auth` frame with a bogus token or key closes 4403; an unauthenticated socket closes 4408
  after 5 s; `Origin: https://evil.example` closes 4403 (mutation: skip the origin check → red).
* Player state frame reaches a paired phone verbatim (mutation: drop the broadcast → red).
* Phone `cmd` reaches the player with an assigned `id`; the player's `ack{ok:false,
  code:E_NOT_ALLOWED}` reaches the phone with the same `id` (mutation: reply `ok:true`
  unconditionally → red).
* Command with no player connected acks `E_OFFLINE` without touching the room's last state
  (mutation: clear state on disconnect → red).

**Stage 1 — app, automated (`node --test "tests/**/*.test.cjs"`)**

* `buildState` maps a fake element to the exact state shape (`position` from `currentTime`,
  `playing` from `paused`, `muted`, `rate`), with `duration: null` when `NaN` (mutation: drop the
  NaN guard → red).
* `applyCommand('seek', {to: 1e9})` clamps to `duration`; `seekBy(-1e9)` clamps to 0 (mutation:
  drop the clamp → red).
* `applyCommand('volume', {value: 5})` clamps to 1; `rate` clamps to `[0.25, 3]` (mutation: drop
  the clamp → red).
* A `play()` that rejects `NotAllowedError` produces `ack{ok:false,code:'E_NOT_ALLOWED'}`, and no
  state frame claiming `playing:true` (mutation: swallow the rejection → red).
* Unknown command → `E_UNKNOWN_CMD`, element untouched (mutation: default-allow → red).
* Reconnect backoff sequence is `[1,2,5,10,30,30…]` with the injected timers (mutation: reset the
  counter on failure → red).

**Stage 1 — live, on this host**

* Pair from a second browser context: code shown on the player page, typed on the phone page, and
  the phone renders the currently playing video's title within 2 s.
* Play/pause, ±10 s, volume and rate from the phone each change the player page's element
  (read back `paused`, `currentTime`, `volume`, `playbackRate` from the live DOM, not from the
  phone's own optimistic UI).
* Kill the player tab → phone shows "TV offline" within 2 s; reopen it → the phone is live again
  with no code entry (the device key proves it).
* `journalctl --user -u freetube-remote.service` shows the pair POST and the two socket upgrades,
  and no token value in any logged line (grep the token's first 8 chars → 0 hits).
* **Off-tailnet, on a phone on mobile data with Tailscale switched off:** the PWA loads over
  `https://nextcloud.taild1347f.ts.net:10000/remote/`, pairs, and play/pause + seek change the
  element on the player page. This is the check the whole amendment exists for.
* **The bridge is not directly reachable:** `ss -tlnp | grep 9098` shows `127.0.0.1:9098` only;
  a fetch of `http://192.168.1.80:9098/health` and of `http://100.77.173.63:9098/health` both fail.
* **The path mount is the only way in:** `https://nextcloud.taild1347f.ts.net:10000/remote/health`
  is 200 while `https://nextcloud.taild1347f.ts.net:10000/health` still belongs to Nextcloud — and
  `tailscale funnel status` shows both the `/` proxy and `/remote` (mutation: drop `--set-path`
  → the remote URL 404s).

**Stage 2** — a link pasted on the phone navigates the player to that video within 2 s; a malformed
link shows an error and navigates nothing (mutation: drop the id validation → red).

## Cost

Measured this session, not estimated: the app suite is 31 tests in ~0.2 s; port 9098 is free; the
bridge is one Python process with three dependencies (`fastapi`, `uvicorn[standard]`, `segno`) and
a small JSON state file of players and tokens under `~/.local/state/`, so its idle cost is a few
tens of MB of RSS and no CPU; the phone client is static files. Nothing here is paid and no
external service is contacted; the only new ingress is one path on the Funnel port that is already
public for Nextcloud. Funnel is beta and applies a non-configurable bandwidth limit — irrelevant
for 1 Hz control JSON.

## Out of scope

* No native phone app, no app-store packaging, no Bluetooth/IR, no casting protocol.
* No control of the Windows desktop itself (that is Unified Remote / KDE Connect territory).
* No browse/search on the phone until Stage 3; Stage 1 and 2 are transport + open-a-link.
* No multi-player rooms (several TVs in one room); one playerId, last connection wins, and a
  second player with the same device key replaces the first.
* No Cloudflare Tunnel, no public DNS for a custom hostname: Funnel only serves
  `<node>.<tailnet>.ts.net`.
* No PROXY-protocol shim for real client IPs (Funnel can emit it; uvicorn cannot consume it), so
  no per-IP policy is claimed.
* No public exposure of the player itself — only the bridge; the preview stays tailnet-only.
* No auth beyond the pairing token: one phone token is full control of the player.
* No change to FreeTube's upstream-facing code paths, no PR upstream unless asked.
* Subtitles, chapters, SponsorBlock and the transcript overlay are untouched.

## Follow-ups this spec creates

* Stage 3 needs a decision on whether the bridge proxies Invidious or the phone talks to it
  directly with CORS (proxying is the recommendation: one origin, one token, no CORS allowlist to
  maintain).
* A "wake the TV" story does not exist: if the player page is closed, the phone can only say so.
* If more than one person should control the same player, phone tokens become per-person with
  names — deliberately not built now.
