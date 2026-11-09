// Drives the FreeTube player from a remote-control bridge.
//
// The media element is the whole surface: every command below is an
// HTMLMediaElement property or method the player already writes, so this module
// works in the Electron build and in the browser build with no fork.

export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const VOLUME_RANGE = [0, 1]
const RATE_RANGE = [0.25, 3]
const DEVICE_KEY_STORAGE = 'freetube-remote-device-key'

function clamp(value, [low, high]) {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, value))
}

/**
 * @param {Storage} storage
 * @returns {string}
 */
export function getDeviceKey(storage) {
  const existing = storage.getItem(DEVICE_KEY_STORAGE)
  if (existing) return existing
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const key = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  storage.setItem(DEVICE_KEY_STORAGE, key)
  return key
}

/**
 * @param {object} meta
 * @param {HTMLVideoElement} video
 * @param {number} now
 */
export function buildState(meta, video, now) {
  return {
    videoId: meta.videoId ?? '',
    title: meta.title ?? '',
    channel: meta.channel ?? '',
    thumbnail: meta.thumbnail ?? '',
    duration: Number.isFinite(video.duration) ? video.duration : null,
    position: video.currentTime ?? 0,
    playing: !video.paused,
    volume: video.volume,
    muted: video.muted,
    rate: video.playbackRate,
    at: now
  }
}

async function play(video) {
  try {
    await video.play()
    return null
  } catch (error) {
    if (error && error.name === 'NotAllowedError') return 'E_NOT_ALLOWED'
    return 'E_PLAY_FAILED'
  }
}

/**
 * @param {{cmd: string, [key: string]: any}} command
 * @param {HTMLVideoElement} video
 * @param {{navigate?: (videoId: string) => void}} [options]
 * @returns {Promise<string|null>} an error code, or null when the command was applied
 */
export async function applyCommand(command, video, options = {}) {
  const { navigate } = options
  switch (command.cmd) {
    case 'play':
      return play(video)
    case 'pause':
      video.pause()
      return null
    case 'toggle':
      return video.paused ? play(video) : (video.pause(), null)
    case 'seek':
      video.currentTime = clamp(command.to, [0, Number.isFinite(video.duration) ? video.duration : 0])
      return null
    case 'seekBy':
      video.currentTime = clamp(
        video.currentTime + (Number.isFinite(command.by) ? command.by : 0),
        [0, Number.isFinite(video.duration) ? video.duration : 0]
      )
      return null
    case 'volume':
      video.volume = clamp(command.value, VOLUME_RANGE)
      video.muted = video.volume === 0
      return null
    case 'mute':
      video.muted = Boolean(command.value)
      return null
    case 'rate':
      video.playbackRate = clamp(command.value, RATE_RANGE)
      return null
    case 'open':
      if (!VIDEO_ID.test(String(command.videoId ?? ''))) return 'E_BAD_VIDEO_ID'
      navigate?.(command.videoId)
      return null
    default:
      return 'E_UNKNOWN_CMD'
  }
}

/**
 * @param {{
 *   url: string,
 *   deviceKey: string,
 *   getVideo: () => HTMLVideoElement|null,
 *   getMeta: () => object,
 *   onPairCode?: (code: string|null, pairUrl: string|null) => void,
 *   navigate?: (videoId: string) => void,
 *   WebSocketImpl?: typeof WebSocket,
 *   now?: () => number,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval,
 * }} options
 */
export function createRemoteAgent(options) {
  const {
    url,
    deviceKey,
    getVideo,
    getMeta,
    onPairCode = () => {},
    onStatus = () => {},
    navigate = videoId => { window.location.hash = `#/watch/${videoId}` },
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval
  } = options

  let socket = null
  let stopped = true
  let attempt = 0
  let retryTimer = null
  let ticker = null
  let detach = null
  const MEDIA_EVENTS = ['play', 'pause', 'seeked', 'volumechange', 'ratechange', 'ended', 'loadedmetadata']

  function send(message) {
    if (socket && socket.readyState === WebSocketImpl.OPEN) socket.send(JSON.stringify(message))
  }

  function publish() {
    const video = getVideo()
    if (video) send({ t: 'state', state: buildState(getMeta(), video, now()) })
  }

  function attach(video) {
    for (const name of MEDIA_EVENTS) video.addEventListener(name, publish)
    return () => {
      for (const name of MEDIA_EVENTS) video.removeEventListener(name, publish)
    }
  }

  function startTicker() {
    clearIntervalImpl(ticker)
    ticker = setIntervalImpl(publish, 1000)
  }

  function schedule() {
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
    attempt += 1
    retryTimer = setTimeoutImpl(connect, wait)
  }

  async function onCommand(message) {
    const video = getVideo()
    if (!video) {
      send({ t: 'ack', id: message.id, ok: false, code: 'E_NO_PLAYER' })
      return
    }
    const code = await applyCommand(message, video, { navigate })
    send({ t: 'ack', id: message.id, ok: code === null, ...(code ? { code } : {}) })
    publish()
  }

  function onMessage(event) {
    const message = JSON.parse(event.data)
    if (message.t === 'hello') {
      onPairCode(null, null)
      if (message.state) publish()
    }
    if (message.t === 'pair-code') onPairCode(message.code, message.pairUrl)
    if (message.t === 'cmd') onCommand(message)
  }

  function connect() {
    if (stopped) return
    const next = new WebSocketImpl(url)
    socket = next

    next.onopen = () => {
      attempt = 0
      onStatus(true)
      // Nothing secret goes in the URL: the bridge reads this first frame and
      // rejects the socket with 4403 if the key is unknown.
      next.send(JSON.stringify({ t: 'auth', role: 'player', key: deviceKey }))
      detach?.()
      const video = getVideo()
      detach = video ? attach(video) : null
      startTicker()
      publish()
    }
    next.onmessage = onMessage
    next.onclose = () => {
      onStatus(false)
      detach?.()
      detach = null
      clearIntervalImpl(ticker)
      if (!stopped) schedule()
    }
  }

  return {
    start() {
      stopped = false
      attempt = 0
      connect()
    },
    stop() {
      stopped = true
      clearTimeoutImpl(retryTimer)
      clearIntervalImpl(ticker)
      detach?.()
      socket?.close()
      socket = null
    },
    requestPairing() {
      send({ t: 'pair-open' })
    },
    cancelPairing() {
      send({ t: 'pair-close' })
    },
    publish,
    get connected() {
      return socket?.readyState === WebSocketImpl.OPEN
    }
  }
}
