// Owns the single remote-control socket for the whole app. The player component
// only registers its media element; settings can request a pairing code whether
// or not a video is on screen.

import { createRemoteAgent, getDeviceKey } from './agent.js'

let agent = null
let videoRef = null
let metaRef = () => ({})
let pairing = null
const listeners = new Set()

function emit() {
  const snapshot = status()
  for (const listener of listeners) listener(snapshot)
}

export function status() {
  return {
    enabled: agent !== null,
    connected: agent?.connected === true,
    pairing,
  }
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function registerPlayer(video, getMeta) {
  videoRef = video
  metaRef = getMeta
  agent?.publish()
}

export function unregisterPlayer(video) {
  if (videoRef !== video) return
  videoRef = null
  metaRef = () => ({})
}

export function qrUrl(pairUrl, code) {
  return `${pairUrl.split('#')[0]}qr/${code}.svg`
}

export function start(url) {
  if (agent) return agent
  agent = createRemoteAgent({
    url,
    deviceKey: getDeviceKey(window.localStorage),
    getVideo: () => videoRef,
    getMeta: () => metaRef(),
    onPairCode: (code, pairUrl) => {
      pairing = code ? { code, pairUrl, qr: qrUrl(pairUrl, code) } : null
      emit()
    },
  })
  agent.start()
  emit()
  return agent
}

export function stop() {
  agent?.stop()
  agent = null
  pairing = null
  emit()
}

export function requestPairing() {
  agent?.requestPairing()
  emit()
}

export function cancelPairing() {
  agent?.cancelPairing()
  pairing = null
  emit()
}
