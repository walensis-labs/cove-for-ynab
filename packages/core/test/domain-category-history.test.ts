import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'
import { YnabApiError } from '../src/client.js'

function seriesClient() {
  return { request: vi.fn(async (path: string) => {
    const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/c1$/)
    if (m) {
      const month = m[1]!
      if (month === '2026-05') throw new YnabApiError(404, '404.2', 'not found') // pre-first_month
      const base = month === '2026-06' ? 500000 : 700000
      return { category: { id: 'c1', name: 'Citi Card', budgeted: 100000, activity: -50000, balance: base } }
    }
    throw new Error(`unmocked ${path}`)
  }) } as any
}

describe('getCategoryHistory', () => {
  it('returns a compact dollar series, skipping 404 months', async () => {
    const c = seriesClient()
    const y = new Ynab({ client: c, allowWrites: false })
    const res = await y.getCategoryHistory('last-used', { categoryId: 'c1', sinceMonth: '2026-05', untilMonth: '2026-07' })
    expect(res.category).toEqual({ id: 'c1', name: 'Citi Card' })
    expect(res.skippedMonths).toEqual(['2026-05'])
    expect(res.points).toEqual([
      { month: '2026-06', assigned: 100, activity: -50, available: 500 },
      { month: '2026-07', assigned: 100, activity: -50, available: 700 },
    ])
    expect(c.request).toHaveBeenCalledTimes(3)
  })
  it('validates the range before any fetch', async () => {
    const c = { request: vi.fn() } as any
    const y = new Ynab({ client: c, allowWrites: false })
    await expect(y.getCategoryHistory('p', { categoryId: 'c1', sinceMonth: '2020-01', untilMonth: '2026-01' })).rejects.toThrow(/60 months/)
    expect(c.request).not.toHaveBeenCalled()
  })
})

describe('getCreditCardFloatHistory', () => {
  it('composes owed/available/gap in dollars with changed flags', async () => {
    const c = { request: vi.fn(async (path: string) => {
      const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
      if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: 0, activity: 0, balance: m[1] === '2026-08' ? 1000000 : 500000 } }
      if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -1000000 } }
      if (path.endsWith('/accounts/a1/transactions')) return { transactions: [
        { date: '2026-07-10', amount: -200000, deleted: false },
        { date: '2026-08-05', amount: -300000, deleted: false },
      ] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const res = await y.getCreditCardFloatHistory('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2026-06', untilMonth: '2026-08' })
    expect(res.account).toBe('Citi Card')
    expect(res.points).toEqual([
      { month: '2026-06', owed: 500, available: 500, gap: 0, changed: false },
      { month: '2026-07', owed: 700, available: 500, gap: -200, changed: true },
      { month: '2026-08', owed: 1000, available: 1000, gap: 0, changed: true },
    ])
    const txnCall = c.request.mock.calls.find(([p]: any[]) => String(p).endsWith('/accounts/a1/transactions'))!
    expect(txnCall[1].query).toEqual({ since_date: '2026-06-01' })
  })
})
