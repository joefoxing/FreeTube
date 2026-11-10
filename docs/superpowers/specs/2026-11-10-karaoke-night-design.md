# Karaoke Night — a karaoke mode, a fair queue, singers, voting, and a score

**Date:** 2026-11-10
**Status:** PROPOSED — design approved in conversation; no code written.
**Repo:** `/home/joefox/developer/freetube` (renderer, router, stores, remote agent) and
`/home/joefox/developer/freetube-remote` (bridge + phone PWA).
**Builds on:** `2026-11-09-freetube-remote-design.md` — the pairing, relay and phone PWA this
feature rides on, all of which exist today.

## The request (user, verbatim)

> "I want to plan a karaoke mode for the freetube app. in this mode search for karaoke only and
> have a queue with priority mode."

Asked what priority mode means, how strict "karaoke only" is, and where the queue should live,
the answers were:

> "Priority jumps the line: a priority request plays next, ahead of waiting normal requests
> (FIFO inside each tier)"
> "Append 'karaoke' to every query and keep only video results whose title/channel look like
> karaoke; default duration filter ~2-10 min"
> "FreeTube renderer (web + desktop) owns the queue; phone remote drives it over the existing
> bridge"

Then, on the same day, the scope was widened explicitly:

> "I want to include these: singer accounts/rotation, drag reordering, voting, queue as a saved
> playlist, karaoke grading/scoring."

With these shapes:

> grading: "Auto score from the phone mic (technique + line coverage), with host/peer judging as
> fallback when a phone has no mic"
> accounts: "Persistent singer roster per profile; a phone claims a roster name when it pairs
> (no passwords)"
> voting: "One upvote per singer per song, toggleable"

## The constraint that shapes everything

FreeTube has a search view and a player, and **no queue of any kind**. Measured this session:

| what | where | state today |
|---|---|---|
| Search route | `src/renderer/router/index.js:104` `/search/:query` | route-driven, filters in query string |
| Search view | `src/renderer/views/SearchPage/SearchPage.vue` | loads via `getInvidiousSearchResults` (`:288`) on the web build |
| Search filters | `components/FtSearchFilters/FtSearchFilters.vue` | sort/time/type/duration/features; no karaoke notion |
| Invidious search | `helpers/api/invidious.js:632` | builds `sort_by/date/duration/type/features`, maps durations at `:633`, keeps videos/channels/playlists/hashtags at `:659` |
| Playback order | `views/Watch/Watch.js:1742` `handleVideoEnded`, `:1807` `handleSkipToNext`, `:1819` `handleSkipToPrev` | playlist, else next recommended video, else nothing |
| Autoplay flags | `Watch.js:165-180` | `autoplayNextRecommendedVideo`, `autoplayNextPlaylistVideo`, countdown interrupt |
| Media events out | `remote/agent.js:151` `MEDIA_EVENTS`, `:157` `publish`, `:169` 1 s ticker | state frames already carry `duration`/`position` (`:47-48`) |
| Remote actions | `remote/index.js:33` `registerPlayer(video, getMeta, actions)`; `ft-shaka-video-player.js:3458` | `play/pause/toggle/seek/seekBy/volume/mute/rate/open/next/prev` (`agent.js:75-105`) |
| Bridge relay | `app/hub.py:126` (`t:'cmd'`), `:138` payload | relays blindly: strips only `t`, no sender identity |
| Player → phone frames | `app/hub.py:80-100` | only `state` and `ack`; a new frame type is a bridge change |
| Search proxy | `app/main.py:79` `/api/search` | bearer token, 1-100 chars, page 1-10, rate-limited, 8 s timeout |
| Chroma of storage | `src/datastores/index.js` | nedb: `settings`, `profiles`, `playlists`, `history`; handlers per target in `datastores/handlers/{base,web,electron}.js` |
| Locales | `static/locales/en-US.yaml` | compiled by `ProcessLocalesPlugin` at build time → dev-server restart |
| Transcript (needed by scoring) | `Watch.js:202/526` `transcriptSegments`, shape `{start,end,text}` (`helpers/transcript.js:60`) | only after the user transcribes via the STT service |
| Test baselines, measured | `node --test "tests/*.test.cjs"` → 64 pass; bridge `uv run pytest tests` → 38 pass; `node --test "tests-web/*.test.mjs"` → 3 pass | |

So this is not a filter on SearchPage: it is a scheduling subsystem, a second identity (singers),
a phone-side audio pipeline, and a bridge protocol extension. One spec, six stages, each
shippable.

## The design

### 1. Karaoke is a mode, not a fork of the app

- New route `/karaoke` (`views/Karaoke/`), side-nav entry, and a persisted `karaoke.active` flag.
- Entering the mode changes three things and nothing else: search becomes karaoke-only, the queue
  panel becomes visible (view + a compact bar on `/watch`), and playback order is owned by the
  queue instead of playlists/recommendations.
- Leaving the mode pauses queue advancement but keeps the queue; re-entering resumes it.
- The new route renders its component directly, not inside `<Transition mode="out-in">`: a hidden
  window never fires `transitionend`, and the route freezes with no error (a pitfall this repo has
  already paid for).

### 2. Karaoke-only search (`helpers/karaoke.js`)

- **Rewrite:** if the query contains no karaoke token, append ` karaoke`. Existing tokens are left
  alone, so "bohemian rhapsody karaoke" is not doubled.
- **Filter:** videos only; `durationSeconds` in 90-720 (adjustable 30-1200 in the panel); title or
  channel must match
  `karaoke|instrumental|backing track|sing[ -]?along|minus[ -]?one|off[ -]?vocal|ktv|lyrics`.
- **Paging:** request pages until 8 kept results or 3 pages fetched, so a filtered page is not an
  empty page.
- **Escape hatch:** a "Show unfiltered" toggle. Heuristics lose real karaoke tracks (a channel
  named "Sing King" with no keyword), and a party that cannot find a song is worse than a loose
  filter.
- **One rule set, two runtimes:** the token list and duration bounds live in
  `tests/fixtures/karaoke-titles.json`; the renderer and the phone PWA each implement the matcher,
  and both suites run the same fixture so they cannot drift (the duet-parser parity pattern
  already used in this workspace).
- The phone's `/api/search` proxy stays dumb: the phone appends the token and filters locally,
  exactly as the renderer does. No bridge-side karaoke logic.

### 3. The queue: one ordered array, explicit scheduling

State (`store/modules/karaoke.js`):

```
queue: {
  items: [ { id, videoId, title, channelName, channelId, thumbnail,
             durationSeconds, singerId, priority, votes: [singerId], addedAt,
             source: 'search' | 'remote' | 'playlist' } ],
  currentId, playedIds: [],          // played = LIFO for "previous"
  rotation: 'fifo' | 'round_robin',
  active: false,
  settings: { priorityCap: 2, filterOn: true, minSeconds: 90, maxSeconds: 720 }
}
```

The array **is** the order, and every mutation moves a row; there is no shadow sort key.

- normal add → append.
- priority add → insert at the END of the priority block (after the current item, behind earlier
  priority requests): priority jumps the line, FIFO inside the tier.
- promote (★) → same reposition as a priority add.
- duplicate `videoId` in the queue → refused with a toast, no silent dedupe of a different singer's
  request.
- vote → the item moves up to sit after the last item with a strictly higher vote count: within the
  normal tier under `fifo`, and within that singer's normal items under `round_robin` (a vote
  cannot outrank another singer's turn, that is what rotation means).
- drag → explicit move; last writer wins (a later vote can move a dragged item; documented, not a
  bug).
- play → the current item stays in `items` as `currentId` until it ends or is skipped; leaving
  removes it and pushes its id onto `playedIds` (capped at 50).
- previous → the current item returns to the FRONT of the normal tier, and the last `playedIds`
  entry becomes current again, so prev-then-next is an identity.
- `next()`:

```
pick():
  if any priority item:            return first priority item in array order
  if rotation == 'fifo':           return first normal item in array order
  # round_robin: first pending song of the next active singer in rotation order
  for singer in rotationOrderFrom(cursor):
      if not singer.active: continue
      song = first item in array order with singerId == singer.id
      if song: advanceCursorPast(singer); return song
  return null
```

Priority is served in strict array order regardless of rotation: "jumps the line" is the user's
word for it, and the fairness cap below is what stops one singer monopolising it.
- **Fairness cap:** at most `priorityCap` (2) outstanding priority items per requester. A third
  demotes to the normal tier with a toast. Without it, one phone tapping ★ twice per song owns the
  night. The requester is the singer from P2 onwards; in P1 (no singers yet) it is the bridge's
  `from` hash, so the cap exists from the first shippable stage.
- **Exhausted queue:** stop, and do not fall back to recommended videos — that is how non-karaoke
  leaks into a karaoke party.
- Persistence: Vuex in memory, mirrored (debounced ~1 s) to `localStorage` per profile id, so a
  reload mid-party does not lose the queue. Queue persistence deliberately does **not** use a nedb
  datastore: a party queue is high-churn state, while singers and scores (below) are records.

### 4. Singers and rotation

- Singer record: `{ id, name, color, source: 'roster' | 'phone', phoneId?, host, active,
  createdAt, stats: { songsSung, totalScore, bestScore, votesCast } }`. `host` is granted on the
  TV, defaults to the first claimed name, and gates destructive commands (clear queue, peer
  scoring, renaming others). Persisted per profile in a new `karaoke.db` nedb store (records, not
  churn).
- Phones claim a name: on first pairing in karaoke mode the phone shows "Who are you?" — pick a
  roster name, or create one. No passwords; the TV host can reassign or rename any singer,
  including releasing a name from a lost phone.
- Identity on the wire: the bridge stamps `from` on every relayed command — `sha256(phone token)`
  truncated to 12 hex chars, computed once at socket auth. The token itself never reaches the
  player. Without this stamp, "your songs" and voting are self-declared and worthless.
  `singerClaim` binds the sender's hash to the roster row (`singer.phoneId`), which is how the
  player resolves `from` to a singer, a host, and a vote.
- Rotation: `round_robin` advances a cursor over active singers who have pending songs, skipping
  empty ones so there is no dead air; `fifo` is the plain queue.
- One singer may hold the current song and a queue; the phone shows "your songs" first.

### 5. Voting

- One upvote per singer per song, toggleable. Voters are `singerId`s, so re-pairing a phone does
  not buy a second vote, and one phone switching names does not either (the roster row, not the
  device, is the voter).
- Upvotes only. Downvotes on a shared TV invite dogpiling; a host can remove an item instead.
- Votes order the normal tier (see `pick`); priority items display counts but do not move.
- Phone: ▲ with count on each queued row. TV: count, plus a "top voted" badge on the leader.
- Casting a vote on a song that has already played is refused (`E_NOT_QUEUED`).

### 6. Drag reordering

- Pure reducer `moveItem(items, fromId, toIndex)` in the karaoke module; all callers go through it.
- TV: pointer-events drag on the queue panel (no new dependency; FreeTube's `helpers/dragAndDrop.js`
  is tab-specific). The current song is pinned and not draggable; crossing the priority boundary
  promotes or demotes the row.
- Phone: move up / move down / promote / remove, and only for the singer's own songs. Host
  authority on the TV covers everything else.
- Every reorder is a single reducer call, so the tests exercise the same code the UI does.

### 7. Playback wiring (the only place order changes)

- `karaoke.active` and a non-empty queue change `handleVideoEnded` (`Watch.js:1742`): take
  `pick()`, route to `/watch/<id>`, and skip the autoplay countdown entirely. Queue order is not
  a suggestion with a 10-second timer.
- `handleSkipToNext` (`:1807`) uses `pick()`; `handleSkipToPrev` (`:1819`) pops `playedIds` and
  navigates back.
- A queue item played by any path (next, prev, direct click) is recorded in `playedIds` and the
  item leaves the queue only when it has actually ended.
- **A playlist watch does not survive the mode.** If karaoke is active and the queue is non-empty,
  the queue owns next/prev even on a page reached from a playlist; the page shows a one-line notice
  with a "leave karaoke mode" action. Two competing orderings on one screen is the bug this rule
  exists to prevent.
- Autoplay settings are untouched when the mode is off; karaoke mode does not rewrite the user's
  preferences.

### 8. The queue as a saved playlist

- **Save queue** → a normal FreeTube user playlist through the existing playlists store
  (`store/modules/playlists.js` + `DBPlaylistHandlers`), default name `Karaoke — <YYYY-MM-DD HH:mm>`,
  containing current + upcoming in display order; an option includes played songs.
- **Load playlist** in the karaoke view → pushes the playlist's videos into the normal tier,
  attributed to the host.
- **Boundary, shown in the UI:** a playlist keeps the video list only. Priority, votes, singer and
  scores are party state and are not written into the playlist (playlist rows have no fields for
  them, and inventing a sidecar format would break sync plans for upstream playlists).

### 9. Grading

**Honest constraint.** A karaoke backing track has no lead melody to grade against — the tune
being sung is not in the audio. Note-accurate scoring needs a paired reference (the original
song), which is audio-service work, not a renderer feature. What P6 scores is what can be measured
truthfully:

- Runs entirely on the phone: `getUserMedia({ audio })`, 40 ms frames, YIN autocorrelation
  (60-1200 Hz), RMS gate with an adaptive noise floor. Only derived numbers cross the relay —
  audio never leaves the phone.
- Song clock: the state frame's `position` plus a one-tap latency calibration per phone (stored on
  the singer row, ±150 ms target), because the mic's audio pipeline and the TV's video are not in
  step.
- Components (initial constants, pinned by tests):
  - **line coverage, 40** — fraction of the song's lyric-line windows with enough voicing. Line
    windows come from the existing transcript segments `{start,end,text}`; the host can trigger the
    existing transcribe action from the queue screen.
  - **pitch stability, 30** — fraction of voiced frames within ±50 cents of the nearest scale
    degree around the singer's own detected tonic.
  - **sustained voicing, 15** — voiced-frame ratio over the sung span.
  - **range, 10** — p95 pitch span, mapped 500→1700 cents.
  - **vibrato/note change, 5** — 4-8 Hz modulation depth present in sustained notes.
- No transcript: technique-only, weights renormalised, with a visible notice — never a silent zero.
- Labelled **Performance score** with the component breakdown. It does not claim note accuracy and
  the UI must not imply it.
- Peer fallback: host taps 0-5 stars (×20); rows are marked `auto` or `peer`. This is the path when
  a phone has no usable mic.
- Records: `karaoke.db` history `{ nightId, singerId, videoId, title, score, kind: 'auto'|'peer',
  components, at }` → per-night leaderboard, best-per-song, and `singer.stats`.
- Known limitation, stated in the UI: TV audio bleeding into the phone mic inflates line coverage.
  Headphones are recommended in the singing screen; the score is lenient by design rather than
  dishonest about what it measures.

### 10. Protocol

New player → phone frame `t:'queue'`, sent when the queue changes (not inside every 1 s state
frame: the queue with 20 upcoming rows is ~2.4 KB and state frames ride media events):

```
{ t:'queue',
  karaoke: { active, rotation, current: {...}, upcoming: [...≤20],
             priorityCount, singers: [...], votes: { itemId: [singerId] },
             scores: {...} } }
```

`buildState` stays as it is; `karaoke.active` is added to the state frame so the phone can show the
mode without the queue.

New phone → player commands (relayed like the existing ones, validated in `agent.js`):

| command | payload | rules |
|---|---|---|
| `karaokeSet` | `{ active }` | persists `karaoke.active` |
| `queueAdd` | `{ videoId, title, channel, durationSeconds, thumbnail, priority }` | `videoId` `/^[\w-]{11}$/`; duplicate refused; cap enforced |
| `queuePromote` / `queueRemove` / `queueClear` | `{ id }` / `{}` | `queueClear` requires the host singer |
| `queueMove` | `{ id, toIndex }` | own songs only, unless the sender is the host |
| `queueNext` / `queuePrev` | `{}` | goes through `pick()`, same as the on-screen buttons |
| `vote` | `{ id }` | toggles the singer's vote; `E_NOT_QUEUED` after play |
| `singerClaim` | `{ name }` | creates or claims a roster row |
| `scoreSubmit` | `{ videoId, score, kind: 'peer' }` | peer only; auto scores are computed phone-side and submitted as numbers |
| `playlistSave` / `playlistLoad` | `{ name?, includePlayed? }` / `{ playlistId }` | uses the playlists store |

Bridge changes (the only Python in the feature):

- `hub.py`: stamp `from` (12-hex hash of the phone token) on relayed `cmd`; relay the new `queue`
  frame from player to phones via `_to_phones`; store the last queue in `rooms` so `hello` gives a
  reconnecting phone the queue immediately (the existing "subscribe with an immediate snapshot"
  pitfall).
- Per-phone command rate limit alongside the existing search limiter (queue ops are cheap; votes
  are the spam surface).
- `tests/test_hub.py` gains cases for `from` stamping, `queue` relay, and offline phone commands.

### 11. Storage

- `karaoke.db` nedb store: `singers`, `history`, `nights` (night = a party session id, created when
  the mode is switched on after being off).
- Handler classes must be exported from `datastores/handlers/index.js` alongside the existing six,
  and from both `web.js` and `electron.js` (base classes are inherited as-is; the `Settings`
  wrapper is not used).
- Queue and mode flag: `localStorage`, keyed by profile id (see §3). Not a datastore.

### 12. Settings and surfaces

- SideNav: "Karaoke" under the existing navigation.
- Karaoke view: search box + filters (duration, unfiltered toggle), results with "＋ Queue" and
  "★ Play next", queue panel with drag, singers strip, save/load playlist, score panel.
- Watch page: a compact queue bar while the mode is active — current, next, priority count, and a
  "queue empty" state that carries the pairing QR so a phone can fill it.
- Phone PWA: a Karaoke tab (search, queue, vote, promote, singers, singing screen with score) next
  to the existing transport controls.
- Locale keys in `static/locales/en-US.yaml`; a new key needs `systemctl --user restart
  freetube-web` before it renders (compiled at build time).

## What this changes for behaviour that exists today

- Search, playlists, history, recommended videos: untouched unless `karaoke.active`.
- The remote protocol gains one frame type and a dozen commands; existing transport commands keep
  their shapes, and the bridge's relay stays generic.
- The hub now attaches `from` to relayed commands. For the player that is additive; for a phone it
  is invisible.
- Autoplay countdown, playlist next/prev and recommendation fallback are bypassed only in karaoke
  mode with a non-empty queue.

## Stages

Each stage is its own plan and its own shippable increment.

**P1 — core.** Mode flag + `/karaoke` route + karaoke search + queue reducer, priority tier and
the per-requester cap + Watch wiring + remote commands/queue frame + localStorage persistence.
*Proves:* a party can run from the TV alone.

**P2 — singers and rotation.** Roster datastore, phone claim screen, `from` stamping in the hub,
rotation scheduling, fairness cap, singers strip on the TV.
*Proves:* two phones, two names, alternating turns, and a third priority request demoted.

**P3 — voting.** Vote command, ordering rule, counts in both UIs.
*Proves:* a vote moves a song and cannot be repeated by re-pairing.

**P4 — drag reordering.** `moveItem`, TV drag, phone move up/down, boundary promotion.
*Proves:* dragging across the boundary changes both display and the next pick.

**P5 — saved playlist.** Save/load through the playlists store, with the metadata boundary stated.
*Proves:* save, reload the app, load, and the order survives with no party metadata invented.

**P6 — grading.** Phone DSP helper with synthetic-signal tests, singing screen, line coverage from
transcript segments, peer fallback, history/leaderboard, stats.
*Proves:* a known synthetic pitch signal scores as designed; a real phone sings a real song; the
leaderboard matches the history rows.

## Evidence (the contract)

- Renderer: `node --test "tests/*.test.cjs"` — 64 passing today; each stage adds files, never
  lowers the count. Queue/scheduling/moveItem/search/scoring-math tests are pure Node.
- Bridge: `uv run pytest tests` (38 today) for hub/routing, `node --test "tests-web/*.test.mjs"`
  (3 today) for the phone client.
- Parity: both runtimes run `tests/fixtures/karaoke-titles.json`; a divergence is a failing test,
  not a judgement call.
- UI: CDP against the dev server for the route, drag and queue bar; packaged Electron under xvfb for
  real end-of-song auto-advance and skip (`pnpm run pack`, `xvfb-run … --remote-debugging-port`);
  funnel health for the phone side.
- Scoring: synthetic signals with known f0 (steady tone, stepped arpeggio, vibrato at 5 Hz,
  silence) pin the maths; the mic path itself is verified by hand on a phone and reported as
  manual.
- Locale keys verified by reloading the page after a dev-server restart, not by reading the YAML.
- eslint only runs under Node 24 (`devEngines.runtime`); a commit that needs `--no-verify` is a
  finding.

## Cost

No paid services. Scoring runs on the phone's own CPU; the only server work is the existing local
STT service when the host transcribes a song, at no marginal cost. The bridge stays on the existing
tailnet host.

## Out of scope

Real accounts/passwords, note-accurate scoring against a reference track, downvotes, multiple
simultaneous TVs in one room, party metadata written into playlists, singer photos/avatars, and
any moderation beyond the host's remove/promote powers.

## Follow-ups this spec creates

- Reference-track pairing (original song + karaoke version) as a scoring upgrade.
- Upstreamability: FreeTube has no queue; this is a candidate feature to propose upstream once it
  is stable here, and the reducer/scheduling split is deliberately framework-free for that reason.
- A "night recap" export (who sang what, scores) if the leaderboard proves useful.

## Risks

- **Priority vs fairness** is the one rule users will argue with; the cap is configurable and the
  toast explains the demotion.
- **Heuristic filtering** can miss real karaoke tracks; the unfiltered toggle and a shared fixture
  keep that honest.
- **Echo** inflates line coverage; headphones are recommended and the limitation is stated in the
  UI rather than hidden.
- **Frame size**: queue frames are pushed on change only; `upcoming` is capped at 20 and stripped
  of search-only fields.
- **Identity by hash**: if a phone is re-paired its hash changes and it must re-claim its name —
  the host can reassign, so the failure is recoverable without a password system.
