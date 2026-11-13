import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { AdapterError } from './http.mjs'
import { inspectScript } from './headless.mjs'
import { textResult, imageResult } from './results.mjs'

export function createSceneTools({ request, ready, run }) {
  async function inspect(args, context) {
    const command = args.command || 'get_scene_info'
    if (args.blend_file) {
      const script = inspectScript(args.blend_file, command, args.args || {})
      const submitted = await run(
        { action: 'submit', kind: 'headless', script, timeout_ms: args.timeout_ms || 60000 },
        context,
      )
      const body = JSON.parse(submitted.content[0].text)
      if (!body.job?.id)
        throw new AdapterError(
          'invalid_response',
          'Gateway did not return the submitted inspection job ID.',
          body,
        )
      return run({ action: 'wait', id: body.job.id, wait_ms: args.timeout_ms || 60000 }, context)
    }
    const catalog = await request('/commands', undefined, context)
    const readable = (catalog.commands || []).filter((row) => row.access === 'read')
    if (command === 'help') return textResult({ ...catalog, commands: readable })
    const entry = readable.find((row) => row.name === command && row.enabled !== false)
    if (!entry)
      throw new AdapterError(
        'invalid_command',
        'Use command=help to list enabled read-only commands.',
      )
    const row = await ready(undefined, context.signal)
    return textResult(
      await request(
        '/cmd',
        { name: command, params: args.args || {}, sessionId: row.id, timeoutMs: 60000 },
        { ...context, timeoutMs: 70000 },
      ),
    )
  }
  async function see(args, context) {
    if (args.image_path) {
      if (!path.isAbsolute(args.image_path))
        throw new AdapterError('invalid_params', 'image_path must be absolute.')
      const info = await stat(args.image_path)
      if (info.size > 16 * 1024 * 1024)
        throw new AdapterError('image_too_large', 'PNG exceeds 16 MiB.')
      return imageResult(await readFile(args.image_path), { image_path: args.image_path })
    }
    await ready(undefined, context.signal)
    const viewpoint = args.viewpoint || 'viewport'
    const payload =
      viewpoint === 'camera'
        ? { mode: 'camera', camera: args.camera || '', max_size: args.max_size || 800 }
        : {
            mode: viewpoint === 'custom' ? 'viewport' : 'current',
            width: args.width || args.max_size || 800,
            height: args.height || 600,
            ...(viewpoint === 'custom'
              ? {
                  from: args.from,
                  look_at: args.look_at,
                  ortho: args.ortho,
                  ortho_scale: args.ortho_scale,
                }
              : {}),
          }
    const image = await request('/view', payload, { ...context, timeoutMs: 60000, image: true })
    return imageResult(image.png, { viewpoint })
  }
  async function py(args, context) {
    const row = await ready(args.session_id, context.signal)
    const body = await request(
      '/act',
      {
        code: args.code || '',
        file: args.file || null,
        py: true,
        sessionId: row.id,
        waitMs: args.wait_ms || 0,
        timeoutMs: args.timeout_ms || 60000,
      },
      { ...context, timeoutMs: (args.timeout_ms || 60000) + 10000 },
    )
    const result = textResult(body)
    if (args.see) {
      try {
        result.content.push(...(await see({}, context)).content)
      } catch (error) {
        result.content.push({
          type: 'text',
          text: JSON.stringify({
            warning: 'Python succeeded, but screenshot failed.',
            error: error.message,
          }),
        })
      }
    }
    return result
  }
  return { inspect, see, py }
}
