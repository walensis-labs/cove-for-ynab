import { describe, it, expect, vi } from 'vitest'
import { YnabClient, YnabApiError } from '../src/client.js'
import { RateLimiter } from '../src/rate-limiter.js'

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const err = (status: number, id: string, detail: string) =>
  new Response(JSON.stringify({ error: { id, name: 'x', detail } }), { status })

describe('YnabClient', () => {
  it('GETs with auth header and unwraps data envelope', async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.ynab.com/v1/plans?include_accounts=true')
      expect(init.headers.Authorization).toBe('Bearer tok123')
      return ok({ plans: [{ id: 'p1' }] })
    })
    const c = new YnabClient({ token: 'tok123', fetchImpl })
    const data = await c.request<{ plans: { id: string }[] }>('/plans', { query: { include_accounts: 'true' } })
    expect(data.plans[0]!.id).toBe('p1')
  })
  it('omits undefined query params and serializes bodies', async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.ynab.com/v1/plans/p1/transactions')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body).transactions[0].amount).toBe(-4500)
      return ok({ transaction_ids: ['t1'] })
    })
    const c = new YnabClient({ token: 't', fetchImpl })
    await c.request('/plans/p1/transactions', { method: 'POST', query: { last_knowledge_of_server: undefined }, body: { transactions: [{ amount: -4500 }] } })
  })
  it('maps YNAB error ids to hints and redacts the token', async () => {
    const fetchImpl = vi.fn(async () => err(403, '403.1', 'subscription lapsed for tok-secret'))
    const c = new YnabClient({ token: 'tok-secret', fetchImpl })
    const e = await c.request<never>('/plans').catch((x) => x as YnabApiError)
    expect(e).toBeInstanceOf(YnabApiError)
    expect(e.id).toBe('403.1')
    expect(e.hint).toMatch(/subscription/i)
    expect(e.message).not.toContain('tok-secret')
    expect(e.message).toContain('[redacted]')
  })
  it('surfaces 429 with rolling-window guidance', async () => {
    const fetchImpl = vi.fn(async () => err(429, '429', 'too many requests'))
    const c = new YnabClient({ token: 't', fetchImpl })
    const e = await c.request<never>('/plans').catch((x) => x as YnabApiError)
    expect(e.hint).toMatch(/200 requests\/hour/)
  })
  it('consumes the limiter before fetching', async () => {
    const fetchImpl = vi.fn(async () => ok({}))
    let t = 0
    const limiter = new RateLimiter(1, 1000, () => t)
    const c = new YnabClient({ token: 't', fetchImpl, limiter })
    await c.request('/user')
    await expect(c.request('/user')).rejects.toThrow(/rate limit/i)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('times out a stalled request with a clear error instead of hanging', async () => {
    const fetchImpl = vi.fn((_url: any, init: any) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    }))
    const c = new YnabClient({ token: 't', fetchImpl: fetchImpl as any, timeoutMs: 50 })
    await expect(c.request('/plans/p1/months/2026-07-01/categories/c1')).rejects.toThrow(/timed out after 50ms.*\/plans\/p1\/months\/2026-07-01\/categories\/c1.*retry/s)
  })
  it('times out a stall during the response body read, not just during fetch', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
    } as unknown as Response))
    const c = new YnabClient({ token: 't', fetchImpl: fetchImpl as any })
    await expect(c.request('/user')).rejects.toThrow(/timed out after 45000ms.*\/user.*retry/s)
  })
})
