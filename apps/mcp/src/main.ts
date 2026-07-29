import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Ynab, YnabClient, DeltaCache, UndoJournal, RateLimiter } from '@walensis/mcp-for-ynab-core'
import { resolveEnv } from './env.js'
import { buildServer } from './server.js'

let resolved
try { resolved = resolveEnv(process.env) } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) }
const { token, allowWrites } = resolved
const limiter = new RateLimiter()
const ynab = new Ynab({
  client: new YnabClient({ token, limiter }),
  cache: new DeltaCache(),
  journal: new UndoJournal(join(homedir(), '.mcp-for-ynab', 'undo.json')),
  allowWrites,
})
const server = buildServer(ynab, limiter)
await server.connect(new StdioServerTransport())
console.error(`mcp-for-ynab ready (writes ${allowWrites ? 'ENABLED' : 'disabled — set YNAB_ALLOW_WRITES=1 to enable'})`)
