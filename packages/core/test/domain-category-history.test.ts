import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab } from '../src/domain.js'
import { YnabApiError } from '../src/client.js'
import { LedgerStore } from '../src/ledger.js'

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
      if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: m[1] === '2026-08' ? 250000 : 0, activity: 0, balance: m[1] === '2026-08' ? 1000000 : 500000 } }
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
    expect(res.skippedMonths).toEqual([])
    expect(res.points).toEqual([
      { month: '2026-06', owed: 500, available: 500, gap: 0, changed: false, gapChange: 0, direction: 'flat' },
      { month: '2026-07', owed: 700, available: 500, gap: -200, changed: true, gapChange: -200, direction: 'grew', cause: 'uncovered_spending', evidence: { components: [{ cause: 'uncovered_spending', amount: -200, residual: -200 }] } },
      { month: '2026-08', owed: 1000, available: 1000, gap: 0, changed: true, gapChange: 200, direction: 'shrank', cause: 'deliberate_cover', evidence: { components: [{ cause: 'deliberate_cover', amount: 250, assigned: 250 }, { cause: 'uncovered_spending', amount: -50, residual: -50 }] } },
    ])
    expect(res.points.map((p: any) => p.direction)).toEqual(['flat', 'grew', 'shrank'])
    const txnCall = c.request.mock.calls.find(([p]: any[]) => String(p).endsWith('/accounts/a1/transactions'))!
    expect(txnCall[1].query).toEqual({ since_date: '2026-06-01' })

    const grew = res.points.find((p: any) => p.month === '2026-07')!
    expect(grew.cause).toBe('uncovered_spending')
    expect(grew.evidence!.components[0]).toMatchObject({ cause: 'uncovered_spending', amount: -200 })
    const shrank = res.points.find((p: any) => p.month === '2026-08')!
    expect(shrank.cause).toBe('deliberate_cover')
    expect(shrank.evidence!.components).toEqual([
      { cause: 'deliberate_cover', amount: 250, assigned: 250 },
      { cause: 'uncovered_spending', amount: -50, residual: -50 },
    ])
    expect(res.points.find((p: any) => p.month === '2026-06')!.cause).toBeUndefined()
  })
  it('validates the range before any fetch', async () => {
    const c = { request: vi.fn() } as any
    const y = new Ynab({ client: c, allowWrites: false })
    await expect(y.getCreditCardFloatHistory('p', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2020-01', untilMonth: '2026-01' })).rejects.toThrow(/60 months/)
    expect(c.request).not.toHaveBeenCalled()
  })
})

function tempLedger(): LedgerStore {
  return new LedgerStore(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json'))
}

// Same shape as the getCreditCardFloatHistory fixture above (3 months, card ends covered at 2026-08).
function coveredFloatClient() {
  return { request: vi.fn(async (path: string) => {
    const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
    if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: m[1] === '2026-08' ? 250000 : 0, activity: 0, balance: m[1] === '2026-08' ? 1000000 : 500000 } }
    if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -1000000 } }
    if (path.endsWith('/accounts/a1/transactions')) return { transactions: [
      { date: '2026-07-10', amount: -200000, deleted: false },
      { date: '2026-08-05', amount: -300000, deleted: false },
    ] }
    throw new Error(`unmocked ${path}`)
  }) } as any
}

// Payment category never funded (available 0 every month) — gap stays nonzero across the whole window.
function neverCoveredFloatClient() {
  return { request: vi.fn(async (path: string) => {
    const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
    if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: 0, activity: 0, balance: 0 } }
    if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -1000000 } }
    if (path.endsWith('/accounts/a1/transactions')) return { transactions: [
      { date: '2026-07-10', amount: -200000, deleted: false },
      { date: '2026-08-05', amount: -300000, deleted: false },
    ] }
    throw new Error(`unmocked ${path}`)
  }) } as any
}

describe('backfillLedger', () => {
  it('writes one final backfill record per month and reports a covered discovery', async () => {
    const ledger = tempLedger()
    const y = new Ynab({ client: coveredFloatClient(), allowWrites: false, ledger })
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2026-06', untilMonth: '2026-08' })
    expect(res.account).toBe('Citi Card')
    expect(res.monthsWritten).toBe(3)
    expect(res.discovery.currentGap).toBe(0)
    expect(res.discovery.nonZeroSince).toBeNull()
    expect(res.discovery.sinceAtLeast).toBe(false)
    expect(res.discovery.summary).toBe('Card is covered as of 2026-08.')

    const records = ledger.list({ kind: 'backfill' })
    expect(records).toHaveLength(3)
    expect(records.map((r) => r.cutoff).sort()).toEqual(['2026-06-30', '2026-07-31', '2026-08-31'])
    for (const r of records) {
      expect(r.planId).toBe('last-used')
      expect(r.gapStatus).toBe('final')
      expect(r.note).toBe('backfill: cleared state not reconstructable historically')
      expect(r.blockers).toEqual({ unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 })
      expect(r.perCard[0]!.account).toBe('Citi Card')
      expect(r.perCard[0]!.clearedAsOf).toBe(r.perCard[0]!.workingAsOf)
    }
    const close = ledger.list().find((r) => r.cutoff === '2026-07-31')!
    // 2026-07: owed 700, so workingAsOf = −owed = −700
    expect(close.perCard[0]!.workingAsOf).toBe(-700)
    expect(close.causes).toEqual([{ month: '2026-07', change: -200, cause: 'uncovered_spending' }])
  })

  it('re-running replaces only the prior backfill records for the same card', async () => {
    const ledger = tempLedger()
    const y = new Ynab({ client: coveredFloatClient(), allowWrites: false, ledger })
    await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2026-06', untilMonth: '2026-08' })
    await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2026-06', untilMonth: '2026-08' })
    expect(ledger.list({ kind: 'backfill' })).toHaveLength(3)
  })

  it('discovers a carried gap reaching the window start ("since at least")', async () => {
    const ledger = tempLedger()
    const y = new Ynab({ client: neverCoveredFloatClient(), allowWrites: false, ledger })
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2026-06', untilMonth: '2026-08' })
    expect(res.discovery.currentGap).toBe(-1000)
    expect(res.discovery.nonZeroSince).toBe('2026-06')
    expect(res.discovery.sinceAtLeast).toBe(true)
    expect(res.discovery.summary).toBe("You've been carrying $1,000.00 of float since at least 2026-06.")
  })

  it('validates the range before any fetch and requires a configured ledger', async () => {
    const c = { request: vi.fn() } as any
    const y = new Ynab({ client: c, allowWrites: false, ledger: tempLedger() })
    await expect(y.backfillLedger('p', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2020-01', untilMonth: '2026-01' })).rejects.toThrow(/60 months/)
    expect(c.request).not.toHaveBeenCalled()

    const yNoLedger = new Ynab({ client: coveredFloatClient(), allowWrites: false })
    await expect(yNoLedger.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2026-06', untilMonth: '2026-08' })).rejects.toThrow(/No ledger configured/)
  })
})
