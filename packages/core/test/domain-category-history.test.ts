import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab, lastCompleteMonth } from '../src/domain.js'
import { YnabApiError } from '../src/client.js'
import { LedgerStore } from '../src/ledger.js'

// backfillLedger caps written records at "the last complete month" relative to the REAL clock (see
// IMPORTANT 1 in the final-fixes review) — so fixtures that need "three complete past months" compute
// them relative to `new Date()` at test-run time rather than hardcoding calendar months, which would
// eventually drift into "the current month" and start failing for reasons unrelated to the test.
function monthOffset(offset: number): string {
  const d = new Date()
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
}
function lastDayOfIso(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

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

describe('lastCompleteMonth (pure, IMPORTANT 1)', () => {
  it('returns the month before the given date\'s month, regardless of day-of-month', () => {
    expect(lastCompleteMonth('2026-07-01T00:00:00.000Z')).toBe('2026-06')
    expect(lastCompleteMonth('2026-07-28T12:34:56.000Z')).toBe('2026-06')
    expect(lastCompleteMonth('2026-07-31T23:59:59.999Z')).toBe('2026-06')
  })
  it('rolls over the year boundary', () => {
    expect(lastCompleteMonth('2026-01-15T00:00:00.000Z')).toBe('2025-12')
  })
})

// Three consecutive complete-relative-to-"now" months, oldest to newest, e.g. ['2026-04', '2026-05', '2026-06']
// when run in 2026-07. Computed at test-run time (see monthOffset above) so these fixtures never drift
// into "the current month" and start being capped by backfillLedger's new completeness rule.
const [M3, M2, M1] = [monthOffset(-3), monthOffset(-2), monthOffset(-1)]

// Same shape as the getCreditCardFloatHistory fixture above (3 months, card ends covered at the newest month).
function coveredFloatClient() {
  return { request: vi.fn(async (path: string) => {
    const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
    if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: m[1] === M1 ? 250000 : 0, activity: 0, balance: m[1] === M1 ? 1000000 : 500000 } }
    if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -1000000 } }
    if (path.endsWith('/accounts/a1/transactions')) return { transactions: [
      { date: `${M2}-10`, amount: -200000, deleted: false },
      { date: `${M1}-05`, amount: -300000, deleted: false },
    ] }
    throw new Error(`unmocked ${path}`)
  }) } as any
}

// Payment category never funded (available 0 every month) — gap stays nonzero (negative/float) across the whole window.
function neverCoveredFloatClient() {
  return { request: vi.fn(async (path: string) => {
    const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
    if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: 0, activity: 0, balance: 0 } }
    if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -1000000 } }
    if (path.endsWith('/accounts/a1/transactions')) return { transactions: [
      { date: `${M2}-10`, amount: -200000, deleted: false },
      { date: `${M1}-05`, amount: -300000, deleted: false },
    ] }
    throw new Error(`unmocked ${path}`)
  }) } as any
}

// Payment category permanently over-funded — gap stays nonzero (positive/surplus) across the whole window.
function surplusFloatClient() {
  return { request: vi.fn(async (path: string) => {
    const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
    if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: 0, activity: 0, balance: 800000 } }
    if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -500000 } }
    if (path.endsWith('/accounts/a1/transactions')) return { transactions: [] }
    throw new Error(`unmocked ${path}`)
  }) } as any
}

describe('backfillLedger', () => {
  it('writes one final backfill record per complete month and reports a covered discovery', async () => {
    const ledger = tempLedger()
    const y = new Ynab({ client: coveredFloatClient(), allowWrites: false, ledger })
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: M3, untilMonth: M1 })
    expect(res.account).toBe('Citi Card')
    expect(res.monthsWritten).toBe(3)
    expect(res.discovery.currentGap).toBe(0)
    expect(res.discovery.nonZeroSince).toBeNull()
    expect(res.discovery.sinceAtLeast).toBe(false)
    expect(res.discovery.summary).toBe(`Card is covered as of ${M1}.`)

    const records = ledger.list({ kind: 'backfill' })
    expect(records).toHaveLength(3)
    expect(records.map((r) => r.cutoff).sort()).toEqual([lastDayOfIso(M3), lastDayOfIso(M2), lastDayOfIso(M1)].sort())
    for (const r of records) {
      expect(r.planId).toBe('last-used')
      expect(r.gapStatus).toBe('final')
      expect(r.note).toBe('backfill: cleared state not reconstructable historically, blockers not reconstructable')
      expect(r.blockers).toEqual({ unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 })
      expect(r.perCard[0]!.account).toBe('Citi Card')
      expect(r.perCard[0]!.clearedAsOf).toBe(r.perCard[0]!.workingAsOf)
    }
    const close = ledger.list().find((r) => r.cutoff === lastDayOfIso(M2))!
    // M2: owed 700, so workingAsOf = −owed = −700
    expect(close.perCard[0]!.workingAsOf).toBe(-700)
    expect(close.causes).toEqual([{ month: M2, change: -200, cause: 'uncovered_spending' }])
  })

  it('re-running replaces only the prior backfill records for the same card', async () => {
    const ledger = tempLedger()
    const y = new Ynab({ client: coveredFloatClient(), allowWrites: false, ledger })
    await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: M3, untilMonth: M1 })
    await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: M3, untilMonth: M1 })
    expect(ledger.list({ kind: 'backfill' })).toHaveLength(3)
  })

  it('discovers a carried gap reaching the window start ("since at least")', async () => {
    const ledger = tempLedger()
    const y = new Ynab({ client: neverCoveredFloatClient(), allowWrites: false, ledger })
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: M3, untilMonth: M1 })
    expect(res.discovery.currentGap).toBe(-1000)
    expect(res.discovery.nonZeroSince).toBe(M3)
    expect(res.discovery.sinceAtLeast).toBe(true)
    expect(res.discovery.summary).toBe(`You've been carrying $1,000.00 of float since at least ${M3}.`)
  })

  // MINOR 3: a persistent POSITIVE gap is surplus, not float — the summary must not call it "carrying float".
  it('describes a persistent positive gap as a surplus, not float', async () => {
    const ledger = tempLedger()
    const y = new Ynab({ client: surplusFloatClient(), allowWrites: false, ledger })
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: M3, untilMonth: M1 })
    expect(res.discovery.currentGap).toBe(300)
    expect(res.discovery.nonZeroSince).toBe(M3)
    expect(res.discovery.sinceAtLeast).toBe(true)
    expect(res.discovery.summary).toBe(`Your payment category has run a $300.00 surplus since at least ${M3}.`)
  })

  it('validates the range before any fetch and requires a configured ledger', async () => {
    const c = { request: vi.fn() } as any
    const y = new Ynab({ client: c, allowWrites: false, ledger: tempLedger() })
    await expect(y.backfillLedger('p', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2020-01', untilMonth: '2026-01' })).rejects.toThrow(/60 months/)
    expect(c.request).not.toHaveBeenCalled()

    const yNoLedger = new Ynab({ client: coveredFloatClient(), allowWrites: false })
    await expect(yNoLedger.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: M3, untilMonth: M1 })).rejects.toThrow(/No ledger configured/)
  })
})

// IMPORTANT 2: get_month_close_ledger's kind filter — "the last close" must mean the newest kind:'close'
// record, not a backfill history row. LedgerStore.list already supports { kind }; this checks the
// Ynab wrapper actually passes it through.
describe('getMonthCloseLedger — kind filter passthrough', () => {
  it('passes an explicit kind through to LedgerStore.list, leaving it unfiltered when omitted', () => {
    const ledger = tempLedger()
    ledger.append({ planId: 'p1', cutoff: '2026-07-31', gapStatus: 'final', perCard: [{ account: 'Visa', workingAsOf: -100, clearedAsOf: -100, availableAtMonthEnd: 100, gap: 0 }], blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 } })
    ledger.replaceBackfill('p1', 'Visa', [{ planId: 'p1', cutoff: '2026-06-30', gapStatus: 'final', perCard: [{ account: 'Visa', workingAsOf: -50, clearedAsOf: -50, availableAtMonthEnd: 50, gap: 0 }], blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 } }])
    const y = new Ynab({ client: { request: vi.fn() } as any, allowWrites: false, ledger })

    expect(y.getMonthCloseLedger({ kind: 'close' }).records).toEqual([expect.objectContaining({ cutoff: '2026-07-31', kind: 'close' })])
    expect(y.getMonthCloseLedger({ kind: 'backfill' }).records).toEqual([expect.objectContaining({ cutoff: '2026-06-30', kind: 'backfill' })])
    expect(y.getMonthCloseLedger().records).toHaveLength(2)
  })
})

// IMPORTANT 1: a mid-month run must not stamp the in-progress month as a final ledger record.
describe('backfillLedger — in-progress month safety', () => {
  // Constant category balance ($200 available) and no transactions inside the completed month, but a
  // $300 charge lands inside the in-progress month — so the complete month is covered (gap 0) and the
  // in-progress month opens $300 of float (gap -300), all computed relative to the real clock.
  function midMonthClient(currentMonth: string) {
    return { request: vi.fn(async (path: string) => {
      const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
      if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: 0, activity: 0, balance: 200000 } }
      if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -500000 } }
      if (path.endsWith('/accounts/a1/transactions')) return { transactions: [
        { date: `${currentMonth}-05`, amount: -300000, deleted: false },
      ] }
      throw new Error(`unmocked ${path}`)
    }) } as any
  }

  it('caps written records at the last complete month while discovery still reflects the in-progress point', async () => {
    const ledger = tempLedger()
    const currentMonth = monthOffset(0)
    const prevMonth = monthOffset(-1)
    const y = new Ynab({ client: midMonthClient(currentMonth), allowWrites: false, ledger })
    // untilMonth omitted — defaults to the current (in-progress) month.
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: prevMonth })
    expect(res.monthsWritten).toBe(1)
    const records = ledger.list({ kind: 'backfill' })
    expect(records).toHaveLength(1)
    expect(records[0]!.cutoff).toBe(lastDayOfIso(prevMonth))
    expect(records[0]!.gapStatus).toBe('final')
    // Discovery still sees the in-progress month's gap — it needs the truest currentGap.
    expect(res.discovery.currentGap).toBe(-300)
    expect(res.discovery.nonZeroSince).toBe(currentMonth)
    expect(res.discovery.summary).toBe(`You've been carrying $300.00 of float since ${currentMonth}.`)
  })

  it('reports monthsWritten: 0 (discovery still returned) when the range has no complete month', async () => {
    const ledger = tempLedger()
    const currentMonth = monthOffset(0)
    const y = new Ynab({ client: midMonthClient(currentMonth), allowWrites: false, ledger })
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: currentMonth, untilMonth: currentMonth })
    expect(res.monthsWritten).toBe(0)
    expect(ledger.list({ kind: 'backfill' })).toHaveLength(0)
    expect(res.discovery.currentGap).toBe(-300)
    expect(res.discovery.nonZeroSince).toBe(currentMonth)
  })
  it('a zero-month run never wipes existing backfill history', async () => {
    const ledger = tempLedger()
    ledger.append({
      kind: 'backfill', planId: 'last-used', cutoff: '2026-06-30', gapStatus: 'final',
      perCard: [{ account: 'Citi Card', workingAsOf: -100, clearedAsOf: -100, availableAtMonthEnd: 100, gap: 0 }],
      blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 },
    })
    const currentMonth = monthOffset(0)
    const y = new Ynab({ client: midMonthClient(currentMonth), allowWrites: false, ledger })
    const res = await y.backfillLedger('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: currentMonth, untilMonth: currentMonth })
    expect(res.monthsWritten).toBe(0)
    expect(ledger.list({ kind: 'backfill' })).toHaveLength(1) // prior history intact
  })
})
