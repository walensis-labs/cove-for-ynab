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
