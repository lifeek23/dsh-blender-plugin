import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAdapter, TOOL_DEFINITIONS } from '../lib/adapter.mjs'

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function parse(result) {
  return JSON.parse(result.content.find((block) => block.type === 'text').text)
}

function fixture(handle) {
  const calls = []
  const adapter = createAdapter({
    baseUrl: 'http://127.0.0.1:39877',
    fetchImpl: async (url, options = {}) => {
      const call = {
        path: new URL(url).pathname,
        body: options.body ? JSON.parse(options.body) : undefined,
        headers: new Headers(options.headers),
      }
      calls.push(call)
      return handle(call)
    },
  })
  return { adapter, calls }
}

test('the basic surface advertises the five implemented tools', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name).sort(), [
    'blender_inspect',
    'blender_py',
    'blender_run',
    'blender_see',
    'blender_session',
  ])
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(tool.description)
  }
})

test('unknown tools and incomplete headless submissions fail before contacting Blender', async () => {
  const { adapter, calls } = fixture(() => {
    throw new Error('invalid input must not reach the Gateway')
  })
  for (const [name, args] of [
    ['not_a_blender_tool', {}],
    ['blender_run', { action: 'submit', kind: 'headless' }],
    ['blender_run', { action: 'wait' }],
    ['blender_py', { code: 'pass', file: '/tmp/example.py' }],
  ]) {
    const result = await adapter.callTool(name, args)
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`)
    assert.ok(parse(result).code || parse(result).error)
  }
  assert.equal(calls.length, 0)
})

test('headless queue calls carry stable explicit caller identities', async () => {
  const { adapter, calls } = fixture(({ body }) => json({ ok: true, op: body.op, jobs: [] }))
  await adapter.callTool('blender_run', { action: 'list' })
  await adapter.callTool('blender_run', { action: 'list' })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.path, '/job')
    assert.equal(call.body.surface, 'queue')
    for (const header of ['x-dsh-host-id', 'x-dsh-session-id', 'x-dsh-agent-id']) {
      assert.ok(call.headers.get(header), `missing ${header}`)
      assert.doesNotMatch(call.headers.get(header), /^unknown-/)
      assert.equal(call.headers.get(header), calls[0].headers.get(header))
    }
    assert.equal(call.headers.get('x-dsh-agent-role'), 'main')
  }
})

test('a failed Blender job is an MCP error even when the queue request succeeded', async () => {
  const { adapter } = fixture(() =>
    json({
      ok: true,
      op: 'collect',
      job: {
        id: 'broken-script',
        state: 'failed',
        result: { exitCode: 1 },
        logs: { stdout: '', stderr: 'RuntimeError: expected smoke failure' },
        artifacts: [],
      },
    }),
  )
  const result = await adapter.callTool('blender_run', {
    action: 'collect',
    id: 'broken-script',
  })
  assert.equal(result.isError, true)
  assert.equal(parse(result).job.state, 'failed')
  assert.match(JSON.stringify(parse(result)), /expected smoke failure/)
})

test('unavailable GUI tools return an actionable error and do not silently run headless', async () => {
  const { adapter, calls } = fixture(({ path: pathname }) => {
    assert.equal(pathname, '/lease')
    return json({ ok: true, sessions: [] })
  })
  const result = await adapter.callTool('blender_py', { code: 'print("hello")' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(parse(result)), /session|GUI|gui/)
  assert.ok(calls.length)
  assert.ok(calls.every((call) => call.path === '/lease'))
})

test('transport failure is reported through the MCP error channel', async () => {
  const adapter = createAdapter({
    baseUrl: 'http://127.0.0.1:39877',
    fetchImpl: async () => {
      throw new Error('connection refused')
    },
  })
  const result = await adapter.callTool('blender_run', { action: 'list' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(parse(result)), /connection refused/)
})

test("closing cancels this adapter's unfinished submissions without canceling observed jobs", async () => {
  const { adapter, calls } = fixture(({ body }) => {
    if (body.op === 'submit')
      return json({ ok: true, job: { id: 'owned-running', state: 'running' } })
    if (body.op === 'list')
      return json({ ok: true, jobs: [{ id: 'another-owner', state: 'running' }] })
    if (body.op === 'cancel') return json({ ok: true, job: { id: body.id, state: 'canceled' } })
    throw new Error(`unexpected operation: ${body.op}`)
  })
  await adapter.callTool('blender_run', { action: 'submit', kind: 'headless', script: 'pass' })
  await adapter.callTool('blender_run', { action: 'list' })
  await adapter.close()
  const canceled = calls.filter((call) => call.body?.op === 'cancel')
  assert.equal(canceled.length, 1)
  assert.equal(canceled[0].path, '/job')
  assert.equal(canceled[0].body.surface, 'queue')
  assert.equal(canceled[0].body.id, 'owned-running')
  await adapter.close()
  assert.equal(
    calls.filter((call) => call.body?.op === 'cancel').length,
    1,
    'close must be idempotent',
  )
})

test('a local render returns actual MCP image bytes without requiring a GUI', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-blender-image-test-'))
  const filename = path.join(directory, 'pixel.png')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  )
  await writeFile(filename, png)
  const { adapter, calls } = fixture(() => {
    throw new Error('local image needs no Gateway')
  })
  try {
    const result = await adapter.callTool('blender_see', { image_path: filename })
    assert.notEqual(result.isError, true)
    const image = result.content.find((block) => block.type === 'image')
    assert.ok(image, 'missing MCP image content')
    assert.equal(image.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(image.data, 'base64'), await readFile(filename))
    assert.equal(calls.length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a non-image file cannot be advertised as a screenshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-blender-image-test-'))
  const filename = path.join(directory, 'not-an-image.png')
  await writeFile(filename, 'this is not a PNG')
  const { adapter } = fixture(() => {
    throw new Error('local image needs no Gateway')
  })
  try {
    const result = await adapter.callTool('blender_see', { image_path: filename })
    assert.equal(result.isError, true)
    assert.ok(!result.content.some((block) => block.type === 'image'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
