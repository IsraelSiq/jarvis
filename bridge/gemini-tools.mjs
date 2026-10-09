import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined
  const result = { ...schema }
  delete result.$schema
  delete result.$id
  return result
}

function addClient(registry, serverName, client, definition) {
  const name = `mcp__${serverName}__${definition.name}`
  const entry = { client, serverName, toolName: definition.name }
  registry.set(name, entry)
  return {
    name,
    description: definition.description ?? `Call ${definition.name} on ${serverName}.`,
    ...(cleanSchema(definition.inputSchema)
      ? { parametersJsonSchema: cleanSchema(definition.inputSchema) }
      : {}),
  }
}

function transportFor(config) {
  const url = config.url ?? config.httpUrl
  if (url) {
    const requestInit = Object.keys(config.headers ?? {}).length
      ? { headers: config.headers }
      : undefined
    if (config.type === 'sse') {
      return new SSEClientTransport(new URL(url), { requestInit })
    }
    return new StreamableHTTPClientTransport(new URL(url), { requestInit })
  }

  if (!config.command) return null
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    cwd: config.cwd,
  })
}

async function connectServer(registry, serverName, config) {
  const transport = transportFor(config)
  if (!transport) return []
  const client = new Client({ name: 'jarvis-gemini', version: '1.0.0' })
  try {
    await client.connect(transport)
    const response = await client.listTools()
    return (response.tools ?? []).map((definition) =>
      addClient(registry, serverName, client, definition),
    )
  } catch (error) {
    console.warn(`[jarvis] MCP server ${serverName} unavailable:`, error?.message ?? error)
    await client.close().catch(() => {})
    return []
  }
}

async function connectInternal(registry, serverName, config) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'jarvis-gemini', version: '1.0.0' })
  await config.instance.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const response = await client.listTools()
    return (response.tools ?? []).map((definition) =>
      addClient(registry, serverName, client, definition),
    )
  } catch (error) {
    await client.close().catch(() => {})
    await config.instance.close().catch(() => {})
    throw error
  }
}

export async function createToolRegistry(externalServers, internalServers) {
  const registry = new Map()
  const declarations = []
  const connected = []
  const clients = new Set()

  for (const [name, config] of Object.entries(externalServers)) {
    try {
      const before = registry.size
      declarations.push(...(await connectServer(registry, name, config)))
      if (registry.size > before) connected.push(name)
      for (const entry of registry.values()) clients.add(entry.client)
    } catch (error) {
      console.warn(`[jarvis] MCP server ${name} failed to start:`, error?.message ?? error)
    }
  }

  for (const [name, config] of Object.entries(internalServers)) {
    const before = registry.size
    declarations.push(...(await connectInternal(registry, name, config)))
    if (registry.size > before) connected.push(name)
    for (const entry of registry.values()) clients.add(entry.client)
  }

  return {
    declarations,
    connected,
    async call(name, args) {
      const entry = registry.get(name)
      if (!entry) throw new Error(`Unknown MCP tool: ${name}`)
      return entry.client.callTool({ name: entry.toolName, arguments: args ?? {} })
    },
    async close() {
      await Promise.all([...clients].map((client) => client.close().catch(() => {})))
      await Promise.all(
        Object.values(internalServers).map((server) => server.instance.close().catch(() => {})),
      )
    },
  }
}