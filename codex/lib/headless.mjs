import { readFile } from 'node:fs/promises'
import { AdapterError } from './http.mjs'

// Upstream's queue does not set --python-exit-code and places --factory-startup
// after file. Open files explicitly and force a nonzero status on script failure.
export function wrapHeadless(script, file, sourceName = '<codex-blender>') {
  const open = file
    ? `import bpy\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(file)})\n`
    : ''
  return [
    'import os, sys, traceback',
    'try:',
    `    exec(compile(${JSON.stringify(open + script)}, ${JSON.stringify(sourceName)}, "exec"), globals())`,
    'except BaseException:',
    '    traceback.print_exc()',
    '    sys.stdout.flush()',
    '    sys.stderr.flush()',
    '    os._exit(1)',
  ].join('\n')
}

export async function submitPayload(args) {
  if (args.kind !== 'headless') {
    throw new AdapterError(
      'invalid_params',
      'This basic MCP version supports kind=headless; use a Python render script for previews.',
    )
  }
  if (args.script && args.script_file) {
    throw new AdapterError('invalid_params', 'Use script or script_file, not both.')
  }
  if (!args.script && !args.script_file && !args.file) {
    throw new AdapterError('invalid_params', 'headless requires script, script_file, or file.')
  }
  const script = args.script_file ? await readFile(args.script_file, 'utf8') : args.script || 'pass'
  return {
    surface: 'queue',
    op: 'submit',
    kind: 'headless',
    script: wrapHeadless(script, args.file, args.script_file || '<codex-blender>'),
    ...(args.outdir ? { outdir: args.outdir } : {}),
    ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}),
  }
}

export function inspectScript(file, command, args) {
  if (!['get_scene_info', 'get_object_info', 'get_collections'].includes(command)) {
    throw new AdapterError(
      'invalid_params',
      'blend_file inspection supports get_scene_info, get_object_info, or get_collections.',
    )
  }
  const name = JSON.stringify(args?.name || '')
  const lines = [
    'import bpy, json',
    `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(file)})`,
    'bpy.context.view_layer.update()',
    'def describe(o):',
    '    return {"name":o.name,"type":o.type,"dimensions":list(o.dimensions),"location":list(o.location),"scale":list(o.scale),"vertices":len(o.data.vertices) if o.type=="MESH" else None,"polygons":len(o.data.polygons) if o.type=="MESH" else None}',
  ]
  if (command === 'get_object_info') {
    if (!args?.name) throw new AdapterError('invalid_params', 'get_object_info requires args.name.')
    lines.push(
      `o=bpy.data.objects.get(${name})`,
      'if o is None: raise ValueError("Object not found")',
      'result=describe(o)',
    )
  } else if (command === 'get_collections') {
    lines.push(
      'result={"collections":[{"name":c.name,"objects":len(c.objects)} for c in bpy.data.collections]}',
    )
  } else {
    lines.push(
      'result={"file":bpy.data.filepath,"scene":bpy.context.scene.name,"unit_system":bpy.context.scene.unit_settings.system,"scale_length":bpy.context.scene.unit_settings.scale_length,"objects":[describe(o) for o in bpy.context.scene.objects]}',
    )
  }
  lines.push('print("HEADLESS "+json.dumps(result))')
  return lines.join('\n')
}
