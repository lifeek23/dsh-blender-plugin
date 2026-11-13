// End-to-end verification against real Blender. All models are disposable fixtures.
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const validation = path.join(root, 'validation')
const outdir = path.join(validation, `smoke-${Date.now()}`)
await mkdir(outdir, { recursive: true })
const blend = path.join(outdir, 'cube.blend')
const stl = path.join(outdir, 'cube.stl')
const png = path.join(outdir, 'cube.png')
const report = {
  startedAt: new Date().toISOString(),
  outdir,
  checks: [],
  files: { blend, stl, png },
}
const client = new Client({ name: 'codex-blender-smoke', version: '0.1.0' })
const protocolErrors = []
client.onerror = (error) => protocolErrors.push(String(error))
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
)
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'launch.mjs')],
  cwd: root,
  env: environment,
  stderr: 'pipe',
})
let stderr = ''
const stdoutLines = []
let stdoutTail = ''

function parse(result) {
  const text = result.content.find((block) => block.type === 'text')
  assert.ok(text, 'tool returned no JSON text content')
  return JSON.parse(text.text)
}

async function call(name, args, expectedError = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  assert.equal(
    Boolean(result.isError),
    expectedError,
    `${name}: ${JSON.stringify(result).slice(0, 3000)}`,
  )
  return { result, body: parse(result) }
}

async function finish(id) {
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    const result = await client.callTool(
      {
        name: 'blender_run',
        arguments: { action: 'wait', id, wait_ms: 30000 },
      },
      undefined,
      { timeout: 60000 },
    )
    const body = parse(result)
    assert.ok(body.job, JSON.stringify(body))
    if (['completed', 'failed', 'canceled'].includes(body.job.state)) return { result, body }
  }
  throw new Error(`job did not terminate within 150 seconds: ${id}`)
}

function stlDimensions(bytes) {
  const triangles = bytes.readUInt32LE(80)
  assert.equal(bytes.length, 84 + 50 * triangles, 'fixture must be a binary STL')
  assert.equal(triangles, 12, 'cube must contain twelve triangles')
  const minimum = [Infinity, Infinity, Infinity]
  const maximum = [-Infinity, -Infinity, -Infinity]
  for (let triangle = 0; triangle < triangles; triangle++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = bytes.readFloatLE(84 + triangle * 50 + 12 + vertex * 12 + axis * 4)
        assert.ok(Number.isFinite(value))
        minimum[axis] = Math.min(minimum[axis], value)
        maximum[axis] = Math.max(maximum[axis], value)
      }
    }
  }
  return maximum.map((value, axis) => value - minimum[axis])
}

const script = `import bpy, json, math
from mathutils import Vector
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=1)
cube=bpy.context.object
cube.name='SmokeCube'
cube.dimensions=(20,30,10)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
scene=bpy.context.scene
scene.unit_settings.system='METRIC'
scene.unit_settings.scale_length=0.001
bpy.ops.wm.stl_export(filepath=${JSON.stringify(stl)}, export_selected_objects=True, global_scale=1.0, use_scene_unit=False, ascii_format=False)
bpy.ops.object.camera_add(location=(60,-80,55))
camera=bpy.context.object
camera.rotation_euler=(Vector((0,0,0))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO'
camera.data.ortho_scale=52
scene.camera=camera
scene.render.engine='CYCLES'
scene.cycles.device='CPU'
scene.cycles.samples=1
scene.render.threads_mode='FIXED'
scene.render.threads=2
scene.world.color=(0.65,0.65,0.65)
scene.render.resolution_x=160
scene.render.resolution_y=120
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.filepath=${JSON.stringify(png)}
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})
bpy.ops.render.render(write_still=True)
print('HEADLESS '+json.dumps({'name':cube.name,'dimensions':list(cube.dimensions),'blend':${JSON.stringify(blend)},'stl':${JSON.stringify(stl)},'png':${JSON.stringify(png)}}))
`
await writeFile(path.join(outdir, 'create_cube.py'), script)

try {
  await client.connect(transport)
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  // The SDK validates the initialization stream; inspect subsequent raw stdout too.
  transport._process?.stdout?.on('data', (chunk) => {
    stdoutTail += chunk.toString()
    const lines = stdoutTail.split('\n')
    stdoutTail = lines.pop()
    stdoutLines.push(...lines.filter((line) => line.trim()))
  })
  const catalog = await client.listTools()
  const names = catalog.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'blender_inspect',
    'blender_py',
    'blender_run',
    'blender_see',
    'blender_session',
  ])
  report.checks.push('MCP initialize and discover all five tools')

  await call('blender_run', { action: 'submit', kind: 'headless' }, true)
  await call('blender_run', { action: 'status', id: 'nonexistent-smoke-job' }, true)
  report.checks.push('invalid submissions and unknown jobs return MCP errors')

  const status = await call('blender_session', { action: 'status' })
  report.gatewayStatus = status.body
  const sessions = await call('blender_session', { action: 'list' })
  assert.ok(Array.isArray(sessions.body.sessions))
  assert.equal(sessions.body.sessions.length, 0, 'smoke test expects no GUI session')
  await call('blender_py', { code: 'print("must not run without GUI")' }, true)
  await call('blender_see', {}, true)
  const doctor = await client.callTool({ name: 'blender_session', arguments: { action: 'doctor' } })
  report.guiDoctor = parse(doctor)
  assert.notEqual(report.guiDoctor.kind, 'ok', 'GUI doctor cannot succeed without an attached GUI')
  report.checks.push('headless mode reports missing GUI explicitly')

  const submitted = await call('blender_run', {
    action: 'submit',
    kind: 'headless',
    script,
    outdir,
    timeout_ms: 120000,
  })
  assert.ok(submitted.body.job?.id)
  const completed = await finish(submitted.body.job.id)
  assert.equal(completed.body.job.state, 'completed', JSON.stringify(completed.body).slice(0, 6000))
  assert.notEqual(completed.result.isError, true)
  const collected = await call('blender_run', {
    action: 'collect',
    id: submitted.body.job.id,
    tail: 16000,
  })
  report.modelJob = collected.body.job
  assert.equal(collected.body.job.state, 'completed')
  assert.match(JSON.stringify(collected.body), /SmokeCube/)
  for (const filename of [blend, stl, png]) assert.ok((await stat(filename)).size > 0)
  const dimensions = stlDimensions(await readFile(stl))
  assert.deepEqual(dimensions, [20, 30, 10])
  report.stlDimensionsMm = dimensions
  report.checks.push(
    'real Blender saved a .blend, binary STL and low-cost PNG; independently verified STL dimensions 20×30×10 mm',
  )

  const inspected = await call('blender_inspect', { blend_file: blend })
  assert.match(JSON.stringify(inspected.body), /SmokeCube/)
  const object = await call('blender_inspect', {
    blend_file: blend,
    command: 'get_object_info',
    args: { name: 'SmokeCube' },
  })
  assert.match(JSON.stringify(object.body), /SmokeCube/)
  report.checks.push('saved .blend scene and object inspection works without GUI')

  const imageResult = await client.callTool({ name: 'blender_see', arguments: { image_path: png } })
  assert.notEqual(imageResult.isError, true)
  const image = imageResult.content.find((block) => block.type === 'image')
  assert.ok(image)
  assert.equal(image.mimeType, 'image/png')
  const pngBytes = Buffer.from(image.data, 'base64')
  assert.deepEqual(pngBytes, await readFile(png))
  assert.equal(pngBytes.readUInt32BE(16), 160)
  assert.equal(pngBytes.readUInt32BE(20), 120)
  report.checks.push('render returned as actual MCP PNG image with matching bytes')

  const failed = await call('blender_run', {
    action: 'submit',
    kind: 'headless',
    script: 'raise RuntimeError("EXPECTED_CODEX_SMOKE_FAILURE")',
    outdir: path.join(outdir, 'failure'),
    timeout_ms: 30000,
  })
  const failure = await finish(failed.body.job.id)
  assert.equal(failure.body.job.state, 'failed', JSON.stringify(failure.body))
  assert.equal(failure.result.isError, true)
  const failureLogs = await call('blender_run', { action: 'collect', id: failed.body.job.id }, true)
  assert.match(JSON.stringify(failureLogs.body), /EXPECTED_CODEX_SMOKE_FAILURE/)
  report.checks.push('a real Python exception marks the job failed and returns MCP isError')

  const sleeping = await call('blender_run', {
    action: 'submit',
    kind: 'headless',
    script: 'import time; time.sleep(30)',
    outdir: path.join(outdir, 'cancel'),
    timeout_ms: 60000,
  })
  const canceled = await call('blender_run', { action: 'cancel', id: sleeping.body.job.id })
  const cancelResult = await finish(sleeping.body.job.id)
  assert.equal(cancelResult.body.job.state, 'canceled', JSON.stringify(canceled.body))
  report.checks.push('cancel terminates a submitted Blender job')

  const shutdownJob = await call('blender_run', {
    action: 'submit',
    kind: 'headless',
    script: 'import time; time.sleep(30)',
    outdir: path.join(outdir, 'shutdown'),
    timeout_ms: 60000,
  })
  const running = await call('blender_run', { action: 'status', id: shutdownJob.body.job.id })
  assert.equal(running.body.job.state, 'running')
  const shutdownPid = running.body.job.pid
  assert.ok(Number.isInteger(shutdownPid) && shutdownPid > 0)
  report.shutdownJob = { id: shutdownJob.body.job.id, pid: shutdownPid }
  await client.close()
  const exitDeadline = Date.now() + 5000
  let childExists = true
  while (childExists && Date.now() < exitDeadline) {
    try {
      process.kill(shutdownPid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') childExists = false
      else throw error
    }
    if (childExists) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(childExists, false, 'closing MCP must terminate its running Blender job')
  report.checks.push('closing MCP terminates its owned running Blender job')

  for (const line of stdoutLines) {
    const message = JSON.parse(line)
    assert.equal(message.jsonrpc, '2.0', `non-protocol stdout: ${line.slice(0, 200)}`)
  }
  assert.equal(protocolErrors.length, 0, protocolErrors.join('\n'))
  report.checks.push('stdio stdout contains only JSON-RPC messages')
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = error.stack || String(error)
  throw error
} finally {
  await client.close().catch(() => {})
  report.finishedAt = new Date().toISOString()
  await writeFile(
    path.join(validation, 'smoke-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await writeFile(path.join(outdir, 'server-stderr.log'), stderr)
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        checks: report.checks,
        report: path.join(validation, 'smoke-report.json'),
        outdir,
      },
      null,
      2,
    ),
  )
}
