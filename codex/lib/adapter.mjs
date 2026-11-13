import Ajv from 'ajv'
import { TOOL_DEFINITIONS } from './tools.mjs'
import { AdapterError, createHttp } from './http.mjs'
import { submitPayload } from './headless.mjs'
import { createSceneTools } from './scene-tools.mjs'
import { textResult } from './results.mjs'
import { createSessionTools } from './session-tools.mjs'

export { TOOL_DEFINITIONS }
const ajv = new Ajv({ allErrors: true })
const validators = new Map(
  TOOL_DEFINITIONS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
)
function validateArguments(name, args) {
  const validator = validators.get(name)
  if (!validator) throw new AdapterError('unknown_tool', `Unknown tool: ${name}`)
  if (!validator(args)) throw new AdapterError('invalid_params', ajv.errorsText(validator.errors))
  if (name === 'blender_py' && Number(Boolean(args.code)) + Number(Boolean(args.file)) !== 1) {
    throw new AdapterError('invalid_params', 'Provide exactly one of code or file.')
  }
  if (name === 'blender_run') {
    const action = args.action || (args.kind ? 'submit' : 'list')
    if (!['submit', 'list'].includes(action) && !args.id)
      throw new AdapterError('invalid_params', `${action} requires id.`)
    if (action === 'submit' && args.kind !== 'headless')
      throw new AdapterError('invalid_params', 'submit requires kind=headless.')
    if (action === 'submit' && !args.script && !args.script_file && !args.file)
      throw new AdapterError('invalid_params', 'headless requires script, script_file, or file.')
    if (args.script && args.script_file)
      throw new AdapterError('invalid_params', 'Provide script or script_file, not both.')
  }
  if (name === 'blender_see' && args.viewpoint === 'custom' && (!args.from || !args.look_at)) {
    throw new AdapterError('invalid_params', 'A custom viewpoint requires from and look_at.')
  }
}

export function createAdapter(options = {}) {
  const http = createHttp(options)
  let closed = false
  const submittedJobs = new Set()
  const request = http.request
  const sessions = createSessionTools(request)
  const { ready, session } = sessions
  async function run(args, context) {
    const action = args.action || (args.kind ? 'submit' : 'list')
    const payload =
      action === 'submit'
        ? await submitPayload(args)
        : {
            surface: 'queue',
            op: action,
            ...(args.id ? { id: args.id } : {}),
            ...(action === 'wait'
              ? { timeout_ms: Math.min(args.wait_ms || args.timeout_ms || 60000, 60000) }
              : {}),
            ...(args.tail ? { tail: args.tail } : {}),
          }
    const body = await request('/job', payload, {
      ...context,
      timeoutMs: action === 'wait' ? payload.timeout_ms + 10000 : 60000,
    })
    if (action === 'submit' && body.job?.id) submittedJobs.add(body.job.id)
    if (body.job && ['completed', 'failed', 'canceled'].includes(body.job.state))
      submittedJobs.delete(body.job.id)
    if (action === 'cancel') submittedJobs.delete(args.id)
    return textResult(
      body,
      body.job?.state === 'failed' || (body.job?.state === 'canceled' && action !== 'cancel'),
    )
  }
  const { inspect, see, py } = createSceneTools({ request, ready, run })
  const handlers = {
    blender_session: session,
    blender_run: run,
    blender_inspect: inspect,
    blender_see: see,
    blender_py: py,
  }
  return {
    identity: http.identity,
    async callTool(name, args = {}, context = {}) {
      try {
        if (closed) throw new AdapterError('adapter_closed', 'The MCP adapter has closed.')
        validateArguments(name, args)
        return await handlers[name](args, context)
      } catch (error) {
        return textResult(
          {
            ok: false,
            code: String(error.code || 'adapter_error'),
            error: error.message,
            ...(error.details || {}),
          },
          true,
        )
      }
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled(
        [...submittedJobs].map((id) =>
          request('/job', { surface: 'queue', op: 'cancel', id }, { timeoutMs: 5000 }),
        ),
      )
      submittedJobs.clear()
      await sessions.close()
    },
  }
}
