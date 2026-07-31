import { describe, it, expect, vi } from 'vitest'
import { app } from '../src/index.js'
import type { WorkerEnv } from '../src/env.js'

function fakeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    YNAB_ACCESS_TOKEN: 'ynab-token',
    MCP_AUTH_TOKEN: 'correct-token',
    DB: {} as WorkerEnv['DB'],
    EMAIL: { send: vi.fn(async () => ({})) },
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
