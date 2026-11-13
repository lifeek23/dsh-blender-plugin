import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

export function createHttp(options = {}) {
  const baseUrl = new URL(
    options.baseUrl || process.env.CODEX_BLENDER_GATEWAY_URL || 'http://127.0.0.1:39878',
  )
  if (
    baseUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)
  ) {
    throw new AdapterError(
      'invalid_gateway',
      'The local Blender Gateway must use a loopback HTTP URL.',
    )
  }
  const identity = {
    hostId: process.env.CODEX_BLENDER_HOST_ID || `codex-${hostname()}`,
    dshSessionId: process.env.CODEX_BLENDER_SESSION_ID || `codex-${randomUUID()}`,
    agentId: process.env.CODEX_BLENDER_AGENT_ID || `codex-agent-${process.pid}`,
    ...options.identity,
  }
  const headers = {
    'x-dsh-host-id': identity.hostId,
    'x-dsh-session-id': identity.dshSessionId,
    'x-dsh-agent-id': identity.agentId,
    'x-dsh-agent-role': 'main',
    'x-dsh-display-name': 'Codex',
  }
  async function request(route, body, { signal, timeoutMs = 30000, image = false } = {}) {
    await options.beforeRequest?.({ path: route, body, signal })
    const timed = AbortSignal.timeout(timeoutMs)
    const response = await (options.fetchImpl || fetch)(new URL(route, baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timed]) : timed,
    })
    if (image && response.ok && response.headers.get('content-type')?.includes('image/png')) {
      const data = Buffer.from(await response.arrayBuffer())
      return { png: data, meta: response.headers.get('x-dsh-view') }
    }
    const text = await response.text()
    const lines = text.trim().split('\n').filter(Boolean)
    let result
    for (const line of lines) {
      const parsed = JSON.parse(line)
      if (!parsed.heartbeat) result = parsed
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new AdapterError('invalid_response', `Gateway ${route} returned no JSON result.`)
    }
    if (!response.ok || result.ok === false) {
      throw new AdapterError(
        result.code || result.error || 'gateway_error',
        `Gateway ${route} rejected the request.`,
        result,
      )
    }
    if (image)
      throw new AdapterError('invalid_image', `Gateway ${route} did not return a PNG.`, result)
    return result
  }
  return { request, identity }
}
