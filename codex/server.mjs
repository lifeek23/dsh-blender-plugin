#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createAdapter, TOOL_DEFINITIONS } from './lib/adapter.mjs'

export function createServer(options = {}) {
  const adapter = createAdapter(options)
  const server = new Server(
    { name: 'dsh-blender-codex', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Use headless Blender jobs on a NAS. Save state to .blend and pass file on the next job. Use blender_see image_path for rendered PNG feedback. GUI tools require an explicit attached session. Original DSH operations remain available in the original DSH entrypoint.',
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    adapter.callTool(request.params.name, request.params.arguments || {}, { signal: extra.signal }),
  )
  server.onclose = () => {
    void adapter.close()
  }
  return { server, adapter }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, adapter } = createServer()
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await adapter.close()
    await server.close()
  }
  process.once('SIGTERM', () => {
    void stop()
  })
  process.once('SIGINT', () => {
    void stop()
  })
  await server.connect(new StdioServerTransport())
}
