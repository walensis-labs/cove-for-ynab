import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'

/**
 * fix/currency-symbol: `formatDollars` used to default to "$" everywhere a *Text companion was
 * emitted (domain.ts, analytics.ts, filters.ts) — so a EUR (or any non-USD) plan got a confident,
 * WRONG "$100.00" in the very field a model is told to quote verbatim. This file mutation-verifies
 * the fix's four required properties directly against Ynab, using a stubbed client:
 *
 *   1. a EUR budget renders its own symbol, not "$"
 *   2. a USD budget is unchanged (regression)
 *   3. an unresolvable symbol renders currency-neutral, never "$"
 *   4. the symbol is resolved at MOST ONCE per plan per Ynab instance (never one fetch per call site)
 *
 * See packages/core/src/domain.ts's #resolveSymbol docstring and NOTE 7 for the design.
 */

const eurPlan = { id: 'p1', name: 'EU Budget', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'EUR', currency_symbol: '€' } }
const usdPlan = { id: 'p1', name: 'US Budget', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } }

const monthFixture = {
  month: {
    month: '2026-07-01', to_be_budgeted: 150250, age_of_money: 32, activity: -2100500, budgeted: 3000000,
    categories: [
      { id: 'c1', category_group_name: 'Bills', name: 'Rent', hidden: false, budgeted: 1500000, activity: -1500000, balance: 0,
        goal_type: 'NEED', goal_target: 1500000, goal_under_funded: 0, goal_percentage_complete: 100, deleted: false },
    ],
  },
}

const apiTxn = (o: any = {}) => ({
  id: 't1', date: '2026-07-01', amount: -45500, payee_name: 'Kroger', payee_id: 'pay1', category_name: 'Groceries',
  category_id: 'c1', account_name: 'Checking', account_id: 'a1', memo: null, cleared: 'cleared', approved: true,
  flag_color: null, transfer_account_id: null, import_id: null, deleted: false, subtransactions: [], ...o,
})

function client(routes: Record<string, (path: string, opts?: any) => unknown>) {
  const request = vi.fn(async (path: string, opts?: any) => {
    if (!(path in routes)) throw new Error(`unmocked path ${path}`)
    return routes[path]!(path, opts)
  })
  return { request } as any
}

describe('currency symbol: 1) a EUR budget renders its own symbol, not "$"', () => {
  it('getMonth', async () => {
    const c = client({ '/plans': () => ({ plans: [eurPlan] }), '/plans/p1/months/current': () => monthFixture })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('€150.25')
    expect(m.categories[0]!.assignedText).toBe('€1,500.00')
    expect(m.readyToAssignText).not.toContain('$')
    expect(m.categories[0]!.assignedText).not.toContain('$')
  })

  it('listCategories', async () => {
    const c = client({
      '/plans': () => ({ plans: [eurPlan] }),
      '/plans/p1/categories': () => ({ category_groups: [{ id: 'g1', name: 'Bills', hidden: false, deleted: false, categories: [
        { id: 'c1', name: 'Rent', hidden: false, deleted: false, budgeted: 100000, activity: -50000, balance: 50000, goal_type: null, goal_target: 0, goal_under_funded: null, goal_percentage_complete: null },
      ] }] }),
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const cats = await y.listCategories('p1')
    expect(cats[0]!.assignedText).toBe('€100.00')
    expect(cats[0]!.assignedText).not.toContain('$')
  })

  it('listTransactions / getTransaction', async () => {
    const c = client({
      '/plans': () => ({ plans: [eurPlan] }),
      '/plans/p1/transactions/t1': () => ({ transaction: apiTxn() }),
      '/plans/p1/transactions': () => ({ transactions: [apiTxn()] }),
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const res: any = await y.listTransactions('p1', {})
    expect(res.transactions[0].amountText).toBe('-€45.50')
    const t = await y.getTransaction('p1', 't1')
    expect(t.amountText).toBe('-€45.50')
  })

  it('assignBudget and moveMoney (write-path inverse text)', async () => {
    const c = client({
      '/plans': () => ({ plans: [eurPlan] }),
      '/plans/p1/months/2026-07-01/categories/c1': () => ({ category: { id: 'c1', name: 'Groceries', budgeted: 100000 } }),
    })
    const y = new Ynab({ client: c, allowWrites: true })
    const res: any = await y.assignBudget('p1', '2026-07-01', 'c1', 250, undefined, { confirm: true })
    expect(res.assignedText).toBe('€250.00')
    expect(res.inverse).toContain('€100.00')
    expect(res.inverse).not.toContain('$')
  })

  it('monthClose', async () => {
    const c = client({
      '/plans': () => ({ plans: [eurPlan] }),
      '/plans/p1/accounts': () => ({ accounts: [{ id: 'a1', name: 'Visa', type: 'creditCard', on_budget: true, closed: false, deleted: false, balance: -100000, cleared_balance: -100000 }] }),
      '/plans/p1/months/2026-07-01': () => ({ month: { month: '2026-07-01', to_be_budgeted: 0, categories: [
        { id: 'p1cat', name: 'Visa', category_group_name: 'Credit Card Payments', hidden: false, deleted: false, internal: false, balance: 100000, goal_type: null, goal_target: null },
      ] } }),
      '/plans/p1/transactions': () => ({ transactions: [] }),
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const res = await y.monthClose('p1', { cutoff: '2026-07-31' })
    expect(res.perCard[0]!.workingAsOfText).toBe('-€100.00')
    expect(res.perCard[0]!.workingAsOfText).not.toContain('$')
  })
})

describe('currency symbol: 2) a USD budget is unchanged (regression)', () => {
  it('getMonth still renders "$"', async () => {
    const c = client({ '/plans': () => ({ plans: [usdPlan] }), '/plans/p1/months/current': () => monthFixture })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('$150.25')
    expect(m.categories[0]!.assignedText).toBe('$1,500.00')
  })

  it('listTransactions still renders "$"', async () => {
    const c = client({ '/plans': () => ({ plans: [usdPlan] }), '/plans/p1/transactions': () => ({ transactions: [apiTxn()] }) })
    const y = new Ynab({ client: c, allowWrites: false })
    const res: any = await y.listTransactions('p1', {})
    expect(res.transactions[0].amountText).toBe('-$45.50')
  })
})

describe('currency symbol: 3) an unresolvable symbol renders currency-neutral, never "$"', () => {
  it('plan not found in /plans response', async () => {
    const c = client({ '/plans': () => ({ plans: [] }), '/plans/p1/months/current': () => monthFixture })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('150.25')
    expect(m.readyToAssignText).not.toContain('$')
    expect(m.categories[0]!.assignedText).toBe('1,500.00')
    expect(m.categories[0]!.assignedText).not.toContain('$')
  })

  it('/plans fetch fails outright (network error)', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans') throw new Error('offline')
      if (path === '/plans/p1/transactions') return { transactions: [apiTxn()] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const res: any = await y.listTransactions('p1', {})
    expect(res.transactions[0].amountText).toBe('-45.50')
    expect(res.transactions[0].amountText).not.toContain('$')
  })

  it('currency_format present but currency_symbol missing (malformed/partial data)', async () => {
    const c = client({
      '/plans': () => ({ plans: [{ id: 'p1', name: 'Weird', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'XYZ' } }] }),
      '/plans/p1/months/current': () => monthFixture,
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('150.25')
    expect(m.readyToAssignText).not.toContain('$')
  })

  it('write-path inverse text also renders currency-neutral on an unresolvable symbol', async () => {
    const c = client({
      '/plans': () => ({ plans: [] }),
      '/plans/p1/months/2026-07-01/categories/c1': () => ({ category: { id: 'c1', name: 'Groceries', budgeted: 100000 } }),
    })
    const y = new Ynab({ client: c, allowWrites: true })
    const res: any = await y.assignBudget('p1', '2026-07-01', 'c1', 250, undefined, { confirm: true })
    expect(res.assignedText).toBe('250.00')
    expect(res.inverse).not.toContain('$')
  })
})

describe('currency symbol: 4) resolved at most once per plan per Ynab instance', () => {
  it('two different *Text-emitting calls against the same plan share one /plans fetch', async () => {
    const c = client({
      '/plans': () => ({ plans: [eurPlan] }),
      '/plans/p1/months/current': () => monthFixture,
      '/plans/p1/categories': () => ({ category_groups: [] }),
      '/plans/p1/transactions': () => ({ transactions: [apiTxn()] }),
    })
    const y = new Ynab({ client: c, allowWrites: false })
    await y.getMonth('p1', 'current')
    await y.listCategories('p1')
    await y.listTransactions('p1', {})
    const plansCalls = c.request.mock.calls.filter(([path]: any[]) => path === '/plans')
    // MUTATION CHECK: if #resolveSymbol ever goes back to fetching /plans per call site instead of
    // caching per Ynab instance, this jumps from 1 to 3 (one per method called above).
    expect(plansCalls).toHaveLength(1)
  })

  it('concurrent (Promise.all) *Text-emitting calls against the same plan still share one /plans fetch', async () => {
    const c = client({
      '/plans': () => ({ plans: [eurPlan] }),
      '/plans/p1/months/current': () => monthFixture,
      '/plans/p1/categories': () => ({ category_groups: [] }),
    })
    const y = new Ynab({ client: c, allowWrites: false })
    await Promise.all([y.getMonth('p1', 'current'), y.listCategories('p1')])
    const plansCalls = c.request.mock.calls.filter(([path]: any[]) => path === '/plans')
    expect(plansCalls).toHaveLength(1)
  })
})
