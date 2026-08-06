import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Ynab, RateLimiter } from '@walensis/cove-core'
import { tools, type ToolDef } from './tools.js'
import { MONTH_CLOSE_PLAYBOOK } from './playbook.js'

export interface BuildServerOptions {
  /**
   * Which write tools to register. Read tools (including the local-file-only ledger tools —
   * `backfill_ledger`, `record_month_close`, `get_month_close_ledger` — which never touch YNAB
   * and carry no `write` marker) are always registered regardless of this option.
   *
   * - `'all'` (default): every tool — today's unchanged behavior.
   * - `'none'`: no write tools registered at all. For tiers that cannot perform writes (e.g. the
   *   hosted multi-tenant tier), a tool that can never be used must be *absent* from the list,
   *   not present-and-erroring: an absent tool produces a clean "unknown tool" error a model
   *   can't route around, where a present-but-refusing one invites it to try.
   * - `string[]`: exactly the named write tools are registered, nothing else. `undo_last` is a
   *   write tool for this purpose (it depends on an undo journal a writeless tier doesn't have)
   *   and must be named explicitly to be included. An unknown name throws at construction — a
   *   typo in a hosted allowlist must fail loudly, never silently grant zero (or the wrong) tools.
   */
  writeTools?: 'all' | 'none' | string[]
}

function selectTools(writeTools: 'all' | 'none' | string[]): ToolDef[] {
  if (writeTools === 'all') return tools
  if (writeTools === 'none') return tools.filter((t) => !t.write)
  const knownWriteNames = tools.filter((t) => t.write).map((t) => t.name)
  const knownWriteSet = new Set(knownWriteNames)
  const unknown = writeTools.filter((name) => !knownWriteSet.has(name))
  if (unknown.length > 0) {
    throw new Error(
      `buildServer: opts.writeTools names unknown write tool(s): ${unknown.join(', ')}. ` +
      `Known write tools: ${knownWriteNames.sort().join(', ')}.`,
    )
  }
  const allowed = new Set(writeTools)
  return tools.filter((t) => !t.write || allowed.has(t.name))
}

// Truthful Tool Output, Task 3(c): "Undoable." is a static claim in several tool descriptions, but
// undo_last depends on an undo journal that not every deployment has (the hosted multi-tenant tier's
// buildYnab passes none, and undo_last is deliberately not registered there). Same failure class as the
// writeDisabledHint fix: the library must not assert a deployment fact it can't know. Matches both
// "Undoable." and "Undoable (restores from journal)." — always the trailing clause of the description.
const UNDOABLE_CLAUSE = / Undoable(?: \([^)]*\))?\.$/

function describeFor(def: ToolDef, hasJournal: boolean): string {
  return hasJournal ? def.description : def.description.replace(UNDOABLE_CLAUSE, '')
}

export function buildServer(ynab: Ynab, limiter: RateLimiter, opts?: BuildServerOptions): McpServer {
  const server = new McpServer({ name: 'cove-for-ynab', version: typeof __MCP_VERSION__ === 'string' ? __MCP_VERSION__ : '0.0.0-dev' })
  const hasJournal = !!ynab.journal
  for (const def of selectTools(opts?.writeTools ?? 'all')) {
    server.registerTool(def.name, { description: describeFor(def, hasJournal), inputSchema: def.schema }, async (args: Record<string, unknown>) => {
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
