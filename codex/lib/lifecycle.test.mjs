import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLifecycle } from './lifecycle.mjs'

test('an occupied port is never reused or killed', async () => {
  const listener = net.createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const lifecycle = createLifecycle({ baseUrl: `http://127.0.0.1:${listener.address().port}` })
  try {
    await assert.rejects(lifecycle.beforeRequest(), /port.*occupied/i)
    await lifecycle.close()
    assert.equal(listener.listening, true)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
})

test('external mode never starts or owns a Gateway', async () => {
  const lifecycle = createLifecycle({ baseUrl: 'http://127.0.0.1:39878', autoStart: false })
  await lifecycle.beforeRequest()
  assert.equal(lifecycle.status().owned, false)
  await lifecycle.close()
})

test('automatic launch only accepts loopback HTTP endpoints', () => {
  assert.throws(() => createLifecycle({ baseUrl: 'http://192.0.2.1:39878' }), /loopback/i)
  assert.throws(() => createLifecycle({ baseUrl: 'https://127.0.0.1:39878' }), /HTTP/i)
})

test('concurrent calls share only their owned child and close stops that child', async () => {
  const listener = net.createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-test-'))
  const entrypoint = path.join(dir, 'gateway.mjs')
  writeFileSync(
    entrypoint,
    `import http from 'node:http';
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,backend:{pid:process.pid}}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`,
  )
  const lifecycle = createLifecycle({
    baseUrl: `http://127.0.0.1:${port}`,
    entrypoint,
    env: { DSH_BLENDER_WORKDIR: dir },
  })
  try {
    await Promise.all([lifecycle.beforeRequest(), lifecycle.beforeRequest()])
    const pid = lifecycle.status().pid
    assert.ok(pid > 0)
    await lifecycle.close()
    assert.equal(lifecycle.status().owned, false)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await assert.rejects(lifecycle.beforeRequest(), /closed/)
  } finally {
    await lifecycle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
