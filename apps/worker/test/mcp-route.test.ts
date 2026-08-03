import { describe, it, expect } from 'vitest'
import { app } from '../src/index.js'
import type { WorkerEnv } from '../src/env.js'

function fakeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    YNAB_ACCESS_TOKEN: 'ynab-token',
    MCP_AUTH_TOKEN: 'correct-token',
    DB: {} as WorkerEnv['DB'],
    ...overrides,
  }
}

// The transport (@hono/mcp's StreamableHTTPTransport, no sessionIdGenerator configured here) replies
// over a text/event-stream body — no prior `initialize` call is required since session validation is
// a no-op when sessionIdGenerator is undefined. Extracts the single JSON-RPC message from the `data:` line.
async function callTool(name: string, args: Record<string, unknown>, env: WorkerEnv = fakeEnv()) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer correct-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }, env)
  const text = await res.text()
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
  if (!dataLine) throw new Error(`no SSE data line in response: ${text}`)
  return JSON.parse(dataLine.slice('data: '.length))
}

describe('worker fetch surface', () => {
  it('GET /health returns 200 unauthenticated', async () => {
    const res = await app.request('/health', {}, fakeEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  it('POST /mcp without a bearer token returns 401', async () => {
    const res = await app.request('/mcp', { method: 'POST' }, fakeEnv())
    expect(res.status).toBe(401)
  })
  it('POST /mcp with the wrong bearer token returns 401', async () => {
    const res = await app.request(
      '/mcp',
      { method: 'POST', headers: { authorization: 'Bearer wrong-token' } },
      fakeEnv(),
    )
    expect(res.status).toBe(401)
  })
  it('GET /mcp (stateless, POST-only) returns 405', async () => {
    const res = await app.request('/mcp', {}, fakeEnv())
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })
})

// claude.ai's custom-connector dialog only accepts a URL (+ optional OAuth) — no static request
// headers — so /mcp's bearer auth is unreachable from its UI. /mcp/:token mirrors the suite's
// health-mcp precedent: the token travels in the path instead, e.g. https://<worker-url>/mcp/<token>.
describe('worker fetch surface — token-in-path route (/mcp/:token)', () => {
  it('POST /mcp/<valid token> with NO bearer header is not rejected as unauthorized', async () => {
    const res = await app.request('/mcp/correct-token', { method: 'POST' }, fakeEnv())
    expect(res.status).not.toBe(401)
  })
  it('POST /mcp/<wrong token> returns 401', async () => {
    const res = await app.request('/mcp/wrong-token', { method: 'POST' }, fakeEnv())
    expect(res.status).toBe(401)
  })
  it('GET /mcp/<token> (stateless, POST-only) returns 405', async () => {
    const res = await app.request('/mcp/correct-token', {}, fakeEnv())
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })
})

// Regression coverage for the doubled write-refusal message (IMPORTANT 1 / 2): asserts the FULL
// rendered error text a write tool returns when WORKER_ALLOW_WRITES isn't set, not just a substring —
// a substring match (e.g. /WORKER_ALLOW_WRITES=1/) would pass even with a duplicated leading sentence.
describe('worker write tools refuse politely without WORKER_ALLOW_WRITES', () => {
  it('create_transactions returns the exact write-disabled message', async () => {
    const body: any = await callTool('create_transactions', {
      plan_id: 'p1',
      transactions: [{ account_id: 'a', date: '2026-07-01', amount: -1 }],
    })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe(
      'Writes are disabled on this server. To enable writes, set the WORKER_ALLOW_WRITES=1 environment variable for this worker and redeploy.',
    )
  })
})
