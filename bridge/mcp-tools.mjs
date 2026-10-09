import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler }
}

export function createSdkMcpServer({ name, version, instructions, tools }) {
  const instance = new McpServer({ name, version }, { instructions })
  for (const definition of tools) {
    instance.tool(
      definition.name,
      definition.description,
      definition.inputSchema,
      definition.handler,
    )
  }
  return { type: 'sdk', name, instance }
}