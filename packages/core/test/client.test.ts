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
})
