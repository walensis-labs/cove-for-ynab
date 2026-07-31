import { Hono } from 'hono'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Ynab, YnabClient, RateLimiter } from '@walensis/mcp-for-ynab-core'
import { buildServer } from '@walensis/mcp-for-ynab'
import { D1Ledger } from './d1-ledger.js'
import type { WorkerEnv } from './env.js'

/** Constant-time-ish token check: compare SHA-256 digests, not raw strings. */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const av = new Uint8Array(a)
  const bv = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < av.length; i++) diff |= av[i]! ^ bv[i]!
  return diff === 0
}

export const app = new Hono<{ Bindings: WorkerEnv }>()

app.get('/health', (c) => c.json({ ok: true }))

app.post('/mcp', async (c) => {
  const auth = c.req.header('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!c.env.MCP_AUTH_TOKEN || !token || !(await tokenMatches(token, c.env.MCP_AUTH_TOKEN))) {
    return c.json({ error: 'unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>' }, 401)
  }
  // NOTE: RateLimiter state is per-isolate and best-effort on Workers — instantiated fresh per
  // request here because module-level "shared across requests" state is unreliable (isolates are
  // recycled/scaled out at will; there is no cross-request durability without external storage
  // such as a Durable Object, which is out of scope for v1). YNAB's own 200/hr server-side limit
  // is the real backstop.
  const limiter = new RateLimiter()
  const ynab = new Ynab({
    client: new YnabClient({ token: c.env.YNAB_ACCESS_TOKEN, limiter }),
    ledger: new D1Ledger(c.env.DB),
    allowWrites: c.env.WORKER_ALLOW_WRITES === '1',
  })
  const server = buildServer(ynab, limiter)
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  // Stateless per-request server; the transport aborts its stream when the response completes
  // and nothing else holds resources — no explicit close.
  return transport.handleRequest(c)
})

app.on(['GET', 'DELETE'], '/mcp', (c) => {
  c.header('Allow', 'POST')
  return c.json({ error: 'method not allowed: stateless server, POST only' }, 405)
})

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, _env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    // Monitor sweep + digests land in Task 3 (feat/phase1b-worker plan). Logged (not thrown) so a
    // stray cron trigger before that ships doesn't show up as a Worker error in the dashboard.
    console.error(`scheduled(${event.cron}) not yet implemented`)
  },
}
