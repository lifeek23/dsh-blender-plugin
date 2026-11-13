import { AdapterError } from './http.mjs'
import { textResult } from './results.mjs'

export function createSessionTools(request) {
  let sessionId
  let heartbeat
  function rememberSession(body) {
    sessionId = body.session?.id
    clearInterval(heartbeat)
    if (sessionId) {
      heartbeat = setInterval(() => {
        request('/lease', { action: 'heartbeat', sessionId }).catch(() => {})
      }, 30000)
      heartbeat.unref()
    }
  }
  async function ready(requested, signal) {
    const body = await request('/lease', { action: 'list' }, { signal })
    const candidates = (body.sessions || []).filter(
      (row) => row.status === 'ready' && row.instanceId,
    )
    const selected = requested || sessionId
    const row = selected
      ? candidates.find((item) => item.id === selected)
      : candidates.length === 1
        ? candidates[0]
        : null
    if (!row)
      throw new AdapterError(
        'session_required',
        'Attach a connected GUI with blender_session(action=attach); for a NAS use blender_run(kind=headless).',
        { sessions: body.sessions || [] },
      )
    return row
  }
  async function session(args, context) {
    const action = args.action || 'status'
    if (action === 'status' || action === 'doctor')
      return textResult(await request(`/${action}`, undefined, { ...context, timeoutMs: 60000 }))
    const body = await request(
      '/lease',
      {
        action,
        ...(args.session_id || sessionId ? { sessionId: args.session_id || sessionId } : {}),
        ...(args.instance_id ? { instanceId: args.instance_id } : {}),
      },
      context,
    )
    if (action === 'attach' || action === 'claim') rememberSession(body)
    if (action === 'release') {
      sessionId = undefined
      clearInterval(heartbeat)
    }
    return textResult(body)
  }
  return {
    ready,
    session,
    async close() {
      clearInterval(heartbeat)
      if (sessionId) {
        try {
          await request('/lease', { action: 'release', sessionId }, { timeoutMs: 5000 })
        } catch {
          /* Owner TTL is the fallback when the Gateway is unavailable. */
        }
      }
    },
  }
}
