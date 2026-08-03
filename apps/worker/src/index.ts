import { Hono, type Context } from 'hono'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Ynab, YnabClient, RateLimiter } from '@walensis/cove-core'
import { buildServer } from '@walensis/cove-mcp'
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

/**
 * Shared per-request MCP server construction — identical for both auth routes below (bearer
 * header and token-in-path). Stateless per-request server; the transport aborts its stream when
 * the response completes and nothing else holds resources — no explicit close.
 */
async function handleMcpRequest(c: Context<{ Bindings: WorkerEnv }>): Promise<Response | undefined> {
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
    writeDisabledHint: 'To enable writes, set the WORKER_ALLOW_WRITES=1 environment variable for this worker and redeploy.',
  })
  const server = buildServer(ynab, limiter)
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return transport.handleRequest(c)
}

export const app = new Hono<{ Bindings: WorkerEnv }>()

app.get('/health', (c) => c.json({ ok: true }))

app.post('/mcp', async (c) => {
  const auth = c.req.header('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!c.env.MCP_AUTH_TOKEN || !token || !(await tokenMatches(token, c.env.MCP_AUTH_TOKEN))) {
    return c.json({ error: 'unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>' }, 401)
  }
  return handleMcpRequest(c)
})

app.on(['GET', 'DELETE'], '/mcp', (c) => {
  c.header('Allow', 'POST')
  return c.json({ error: 'method not allowed: stateless server, POST only' }, 405)
})

// Token-in-path route — claude.ai's custom-connector dialog only accepts a URL (+ optional OAuth);
// static request-header configuration is beta-gated there, so the bearer route above is unreachable
// from claude.ai's UI. This mirrors the suite's health-mcp precedent: embed the token in the path
// instead, e.g. https://<worker-url>/mcp/<MCP_AUTH_TOKEN>. Same constant-time comparison, same
// shared request handler — the only difference is where the token comes from.
app.post('/mcp/:token', async (c) => {
  const token = c.req.param('token')
  if (!c.env.MCP_AUTH_TOKEN || !token || !(await tokenMatches(token, c.env.MCP_AUTH_TOKEN))) {
    return c.json({ error: 'unauthorized: the URL token does not match MCP_AUTH_TOKEN' }, 401)
  }
  return handleMcpRequest(c)
})

app.on(['GET', 'DELETE'], '/mcp/:token', (c) => {
  c.header('Allow', 'POST')
  return c.json({ error: 'method not allowed: stateless server, POST only' }, 405)
})

export default {
  fetch: app.fetch,
}
