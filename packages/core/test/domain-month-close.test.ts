import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'

const accounts = { accounts: [
  { id: 'a1', name: 'Citi Card', type: 'creditCard', on_budget: true, closed: false, deleted: false, balance: -3291760, cleared_balance: -3291760 },
  { id: 'chk', name: 'Checking', type: 'checking', on_budget: true, closed: false, deleted: false, balance: 5000000, cleared_balance: 5000000 },
] }
const month = { month: { month: '2026-07-01', to_be_budgeted: 7178050, categories: [
  { id: 'p1', name: 'Citi Card', category_group_name: 'Credit Card Payments', hidden: false, deleted: false, internal: false, balance: 2662650, goal_type: null, goal_target: null },
  { id: 'r1', name: 'Kid Things', category_group_name: 'Just for Fun', hidden: false, deleted: false, internal: false, balance: -348170, goal_type: null, goal_target: null },
  { id: 'd1', name: 'Dining Out', category_group_name: 'Just for Fun', hidden: false, deleted: false, internal: false, balance: 412000, goal_type: null, goal_target: null },
] } }
const txns = { transactions: [
  { id: 'aug', date: '2026-08-02', amount: -50000, cleared: 'cleared', approved: true, account_id: 'a1', payee_name: 'Aug', category_id: 'c9', transfer_account_id: null, deleted: false, subtransactions: [] },
  { id: 'pend', date: '2026-07-20', amount: -42100, cleared: 'uncleared', approved: false, account_id: 'a1', payee_name: 'Pend', account_name: 'Citi Card', category_id: null, transfer_account_id: null, deleted: false, subtransactions: [] },
] }

function client() {
  return { request: vi.fn(async (path: string) => {
    if (path.endsWith('/accounts')) return accounts
    if (path.includes('/months/')) return month
    if (path.endsWith('/transactions')) return txns
    throw new Error(`unmocked ${path}`)
  }) } as any
}

describe('monthClose', () => {
  it('produces per-card gap in dollars with the spec sign convention', async () => {
    const c = client()
    const y = new Ynab({ client: c, allowWrites: false })
    const res = await y.monthClose('last-used', { cutoff: '2026-07-31' })
    // fetch contract: month key from cutoff; since_date = cutoff − 120d; NO until_date
    expect(c.request.mock.calls.some(([p]: any[]) => String(p).includes('/months/2026-07-01'))).toBe(true)
    const txnCall = c.request.mock.calls.find(([p]: any[]) => String(p).endsWith('/transactions'))!
    expect(txnCall[1].query).toEqual({ since_date: '2026-04-02' })
    const card = res.perCard[0]!
    // workingAsOf = -3291760 - (-50000) = -3241760 → -3241.76
    expect(card).toMatchObject({ account: 'Citi Card', workingAsOf: -3241.76, availableAtMonthEnd: 2662.65, paymentCategoryId: 'p1' })
    expect(card.gap).toBe(-579.11) // -3241.76 + 2662.65 — integer milli math, exact
    expect(res.blockers.unapproved.map((t) => t.id)).toEqual(['pend'])
    expect(res.blockers.uncategorized.map((t) => t.id)).toEqual(['pend'])
    expect(res.redCategories).toEqual([{ id: 'r1', name: 'Kid Things', available: -348.17, group: 'Just for Fun' }])
    expect(res.donors[0]).toMatchObject({ id: 'd1', excess: 412, hasTarget: false })
  })
  it('cutoff=today identity: workingAsOf equals current balance when nothing post-dates it', async () => {
    const y = new Ynab({ client: client(), allowWrites: false })
    const res = await y.monthClose('last-used', { cutoff: '2026-08-31' })
    expect(res.perCard[0]).toMatchObject({ workingAsOf: -3291.76, clearedAsOf: -3291.76 })
  })
  it('clamps lookback to 365 days', async () => {
    const c = { request: vi.fn(async (path: string, opts?: any) => {
      if (path.endsWith('/transactions')) { expect(opts.query.since_date).toBe('2025-07-31'); return { transactions: [] } }
      if (path.endsWith('/accounts')) return accounts
      return month
    }) } as any
    await new Ynab({ client: c, allowWrites: false }).monthClose('last-used', { cutoff: '2026-07-31', lookbackDays: 9999 })
  })
})

describe('proposeCoverage', () => {
  it('covers the red from the donor and reports RTA in dollars', async () => {
    const y = new Ynab({ client: client(), allowWrites: false })
    const res = await y.proposeCoverage('last-used', { cutoff: '2026-07-31' })
    expect(res.moves).toEqual([{ from: 'Dining Out', fromId: 'd1', to: 'Kid Things', toId: 'r1', amount: 348.17, source: 'category' }])
    expect(res.rtaUsed).toBe(0)
    expect(res.rtaRemaining).toBe(7178.05)
  })
})
