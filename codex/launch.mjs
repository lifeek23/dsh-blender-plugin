#!/usr/bin/env node
// BSD-3-Clause. Local NAS launcher; the original DSH host is unchanged.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.mjs'
import { createLifecycle } from './lib/lifecycle.mjs'

const lifecycle = createLifecycle()
const { server, adapter } = createServer({
  baseUrl: lifecycle.baseUrl,
  beforeRequest: lifecycle.beforeRequest,
})
let closing
function cleanup() {
  if (!closing)
    closing = (async () => {
      try {
        await adapter.close()
      } finally {
        await lifecycle.close()
      }
    })()
  return closing
}
server.onclose = () => {
  cleanup().catch((error) => console.error(error.message))
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    try {
      await cleanup()
      await server.close()
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  })
process.on('uncaughtException', async (error) => {
  console.error(error.message)
  process.exitCode = 1
  await cleanup().catch(() => {})
  await server.close().catch(() => {})
})
try {
  await server.connect(new StdioServerTransport())
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
  await cleanup()
}
