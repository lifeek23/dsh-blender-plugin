import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function portOccupied(url) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 80) })
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('Gateway port probe timed out'))
    })
    socket.once('error', (error) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([exited, delay(3000, undefined, { ref: false })])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(1000, undefined, { ref: false })])
  }
}

/** One owned Gateway per MCP connection. Never launches Blender or borrows a listener. */
export function createLifecycle(options = {}) {
  const env = { ...process.env, ...options.env }
  const baseUrl = options.baseUrl || env.CODEX_BLENDER_GATEWAY_URL || 'http://127.0.0.1:39878'
  const url = new URL(baseUrl)
  const autoStart = options.autoStart ?? env.CODEX_BLENDER_AUTOSTART !== '0'
  if (autoStart && !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('Automatic Gateway launch requires a loopback address')
  if (
    autoStart &&
    (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/')
  )
    throw new Error('Automatic Gateway launch requires a plain HTTP origin')
  const entrypoint = options.entrypoint || path.join(ROOT, 'lib/runtime/gateway.js')
  const workDir = env.DSH_BLENDER_WORKDIR || path.join(ROOT, 'codex/state', randomUUID())
  const hostId = env.CODEX_BLENDER_HOST_ID || `codex-${process.pid}-${randomUUID()}`
  let child = null
  let starting = null
  let closed = false

  async function start(signal) {
    if (!autoStart) return
    if (!existsSync(entrypoint))
      throw new Error('Gateway is not built; run node scripts/build.mjs runtime')
    if (await portOccupied(url))
      throw new Error(
        `Gateway port ${url.port || 80} is occupied; choose CODEX_BLENDER_GATEWAY_URL. No existing process was reused or stopped.`,
      )
    mkdirSync(workDir, { recursive: true })
    const wrapper = path.join(ROOT, 'codex/bin/blender-nas')
    const childEnv = {
      ...env,
      DSH_HOST_ID: hostId,
      DSH_BLENDER_HOLDER: hostId,
      DSH_BLENDER_GATEWAY_PORT: String(url.port || 80),
      DSH_BLENDER_WORKDIR: workDir,
      DSH_BLENDER_EXE: env.DSH_BLENDER_EXE || wrapper,
      DSH_BLENDER_VIRTUAL_GUI: 'off',
      OMP_NUM_THREADS: '2',
      OPENBLAS_NUM_THREADS: '2',
    }
    const processHandle = spawn(process.execPath, [entrypoint, '--port', String(url.port || 80)], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = processHandle
    let spawnError = null
    let logs = ''
    processHandle.once('error', (error) => {
      spawnError = error
    })
    for (const stream of [processHandle.stdout, processHandle.stderr])
      stream.on('data', (bytes) => {
        logs = (logs + bytes.toString()).slice(-4000)
        if (env.CODEX_BLENDER_DEBUG === '1') process.stderr.write(bytes)
      })
    const deadline = Date.now() + (options.startupTimeoutMs || 20000)
    try {
      while (Date.now() < deadline) {
        signal?.throwIfAborted()
        if (closed) throw new Error('Gateway lifecycle was closed during startup')
        if (spawnError) throw spawnError
        if (processHandle.exitCode !== null || processHandle.signalCode !== null)
          throw new Error(`Gateway exited during startup: ${logs}`)
        try {
          const response = await fetch(new URL('/health', url), {
            signal: AbortSignal.timeout(1000),
          })
          const health = await response.json()
          if (health?.backend?.pid === processHandle.pid && health?.ok === true) return
          throw new Error('Gateway endpoint belongs to a different process')
        } catch (error) {
          if (error.message.includes('different process')) throw error
        }
        await delay(100)
      }
      throw new Error(`Gateway startup timed out: ${logs}`)
    } catch (error) {
      await stopChild(processHandle)
      if (child === processHandle) child = null
      throw error
    }
  }

  async function beforeRequest({ signal } = {}) {
    if (closed) throw new Error('Gateway lifecycle is closed')
    if (!autoStart) return
    if (child && child.exitCode === null && child.signalCode === null && !starting) return
    if (!starting)
      starting = start(signal).finally(() => {
        starting = null
      })
    await starting
  }

  async function close() {
    closed = true
    if (starting) await starting.catch(() => {})
    await stopChild(child)
    child = null
  }

  return {
    baseUrl,
    beforeRequest,
    close,
    status: () => ({ owned: !!child, pid: child?.pid ?? null, autoStart, workDir }),
  }
}
