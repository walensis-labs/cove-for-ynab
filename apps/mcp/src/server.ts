import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Ynab, RateLimiter } from '@walensis/mcp-for-ynab-core'
import { tools } from './tools.js'
import { MONTH_CLOSE_PLAYBOOK } from './playbook.js'

export function buildServer(ynab: Ynab, limiter: RateLimiter): McpServer {
  const server = new McpServer({ name: 'mcp-for-ynab', version: typeof __MCP_VERSION__ === 'string' ? __MCP_VERSION__ : '0.0.0-dev' })
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
  server.registerPrompt('month-close-session', {
    description: 'Guided month-close session (Balance → Plan): blocker-aware gaps, float attribution, donor-first coverage, balance-forward record.',
    argsSchema: { cutoff: z.string().optional().describe("cutoff date, e.g. '2026-08-31'") },
  }, ({ cutoff }) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${cutoff ? `Cutoff: ${cutoff}.\n\n` : ''}${MONTH_CLOSE_PLAYBOOK}` } }],
  }))
  return server
}
