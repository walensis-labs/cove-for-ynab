import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Ynab, RateLimiter } from '@walensis/mcp-for-ynab-core'
import { tools } from './tools.js'

export function buildServer(ynab: Ynab, limiter: RateLimiter): McpServer {
  const server = new McpServer({ name: 'mcp-for-ynab', version: '0.1.0' })
  for (const def of tools) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.schema }, async (args: Record<string, unknown>) => {
      try {
        const result = await def.handler(ynab, args)
        const warning = limiter.warning()
        const payload = warning ? { result, warning } : result
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { isError: true, content: [{ type: 'text' as const, text: msg }] }
      }
    })
  }
  return server
}
