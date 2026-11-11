// src/main/transcribeClient.js
//
// Main-process HTTP client for the local transcription service. This is the
// only place the app speaks HTTP to the service. It must stay importable in
// plain Node (no Electron imports) so it can be exercised against a stub
// server in tests.

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function transcribeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function createTranscribeClient({ fetchImpl = globalThis.fetch, sleep = defaultSleep } = {}) {
  /**
   * @param {string} serviceUrl
   * @param {string} token
   * @param {string} path
   * @param {{ method?: string, body?: object, fetchTimeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async function request(serviceUrl, token, path, { method = 'GET', body, fetchTimeoutMs = 15000, signal } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs)

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    let response
    try {
      response = await fetchImpl(joinUrl(serviceUrl, path), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
    } catch (error) {
      if (signal?.aborted) {
        throw transcribeError('E_CANCELLED', 'cancelled')
      }
      throw transcribeError('E_SERVICE_UNREACHABLE', `${serviceUrl}: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      const code = payload?.error?.code ?? payload?.detail?.code ?? (response.status === 401 ? 'E_UNAUTHORIZED' : 'E_TRANSCRIBE_FAILED')
      const message = payload?.error?.message ?? payload?.detail?.message ?? `HTTP ${response.status}`
      throw transcribeError(code, message)
    }

    return payload
  }

  return {
    /**
     * @param {{ serviceUrl: string, token: string, videoId: string, startSeconds: number, endSeconds: number, signal?: AbortSignal }} options
     */
    async startJob({ serviceUrl, token, videoId, startSeconds, endSeconds, signal }) {
      const payload = await request(serviceUrl, token, '/jobs', {
        method: 'POST',
        body: { videoId, startSeconds, endSeconds },
        signal
      })

      if (!payload?.jobId) {
        throw transcribeError('E_TRANSCRIBE_FAILED', 'service returned no job id')
      }

      return payload
    },

    /**
     * @param {{
     *   serviceUrl: string,
     *   token: string,
     *   jobId: string,
     *   onUpdate?: (view: object) => void,
     *   signal?: AbortSignal,
     *   pollIntervalMs?: number,
     *   fetchTimeoutMs?: number,
     *   transcribeTimeoutMs?: number
     * }} options
     */
    async waitForJob({
      serviceUrl,
      token,
      jobId,
      onUpdate,
      signal,
      pollIntervalMs = 1000,
      // These budgets must stay ABOVE the service's own limits, or the client
      // abandons a job the service still considers healthy. The service allows a
      // fetch to run FETCH_TIMEOUT_SECONDS (300s) plus a 120s decode before it
      // ever reports `transcribing`, and on a throttled connection a fetch of a
      // 4-minute section really does take ~124s. With the old 120s budget the
      // client threw E_TIMEOUT while the service went on to finish the job.
      fetchTimeoutMs = 480000,
      transcribeTimeoutMs = 300000
    }) {
      const startedAt = Date.now()

      for (;;) {
        if (signal?.aborted) {
          throw transcribeError('E_CANCELLED', 'cancelled')
        }

        const view = await request(serviceUrl, token, `/jobs/${jobId}`, { signal })

        onUpdate?.(view)

        if (view.state === 'done' || view.state === 'error' || view.state === 'cancelled') {
          return view
        }

        const elapsed = Date.now() - startedAt
        const budget = view.stage === 'transcribing' ? fetchTimeoutMs + transcribeTimeoutMs : fetchTimeoutMs
        if (elapsed > budget) {
          throw transcribeError('E_TIMEOUT', `job ${jobId} exceeded its ${Math.round(budget / 1000)}s budget`)
        }

        if (signal?.aborted) {
          throw transcribeError('E_CANCELLED', 'cancelled')
        }

        await sleep(pollIntervalMs)
      }
    },

    /**
     * @param {{ serviceUrl: string, token: string, jobId: string }} options
     */
    async cancelJob({ serviceUrl, token, jobId }) {
      try {
        await request(serviceUrl, token, `/jobs/${jobId}/cancel`, { method: 'POST', fetchTimeoutMs: 5000 })
      } catch {
        // cancellation is best effort: the job may already be gone
      }
    }
  }
}
