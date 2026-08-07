import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'
import type { CurrencyFormatOpts } from '../src/money.js'

/**
 * fix/currency-symbol: `formatDollars` used to default to "$" everywhere a *Text companion was
 * emitted (domain.ts, analytics.ts, filters.ts) — so a EUR (or any non-USD) plan got a confident,
 * WRONG "$100.00" in the very field a model is told to quote verbatim. This file mutation-verifies
 * the fix's properties directly against Ynab, using a stubbed client:
 *
 *   1. a EUR budget renders its own symbol, not "$"
 *   2. a USD budget is unchanged (regression)
 *   3. an unresolvable symbol renders currency-neutral, never "$"
 *   4. the currency format is resolved at MOST ONCE per plan per Ynab instance (never one fetch per call site)
 *   5. (review round 2, CRITICAL 1) the YNAB path-param aliases 'last-used'/'default' resolve a real
 *      symbol via `GET /plans/{plan_id}/settings` — NOT via a `find` over `/plans`, which can never
 *      match an alias since YNAB never returns one as a plan's `id`
 *   6. (review round 2, IMPORTANT 4) listPlans() is not memoized — a second call sees fresh data
 *   7. (review round 2, IMPORTANT 6) the full currency format (decimals/separators/symbol position),
 *      not just the symbol, is honored
 *   8. (review round 2, MINOR seam) the injectable `currencySymbol` constructor option is honored and
 *      skips the network call
 *   9. (review round 3, IMPORTANT 1) a cache HIT degrades gracefully too — not just the original
 *      fetcher — so a method that resolves currency twice for the same plan in one Promise.all
 *      (getBudgetHealth, getPlanOverview) never throws
 *  10. (review round 3, IMPORTANT 2) getPlanOverview never fabricates "USD" for an alias id
 *  11. (review round 3, MINOR seam widened) the injectable `currencySymbol` seam accepts a full
 *      CurrencyFormatOpts, not just a bare string, so a host-cached SEK plan renders correctly
 *  12. (fix/currency-symbol, cache-seeding regression) getPlanOverview no longer seeds its currency
 *      cache from /plans' currency_format — that entry can legitimately be null or absent for a real
 *      plan id (PlanSummary.currency_format is optional; CurrencyFormat is `{...} | null` per
 *      generated/api.d.ts), independent of whether /settings would resolve it. A real plan id with a
 *      null/absent /plans currency_format still resolves its currency live via /settings, and
 *      getPlanOverview's four requests (/plans, /accounts, /months/current, /settings) fire fully
 *      concurrently again — no more awaiting /plans alone first.
 *
 * See packages/core/src/domain.ts's #resolveCurrency docstring for the design.
 */

const eurPlan = { id: 'p1', name: 'EU Budget', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'EUR', currency_symbol: '€' } }
const usdPlan = { id: 'p1', name: 'US Budget', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } }
const settingsOf = (cf: Record<string, unknown>) => ({ settings: { currency_format: cf } })

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
    const c = client({ '/plans/p1/settings': () => settingsOf(eurPlan.currency_format), '/plans/p1/months/current': () => monthFixture })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('€150.25')
    expect(m.categories[0]!.assignedText).toBe('€1,500.00')
    expect(m.readyToAssignText).not.toContain('$')
    expect(m.categories[0]!.assignedText).not.toContain('$')
  })

  it('listCategories', async () => {
    const c = client({
      '/plans/p1/settings': () => settingsOf(eurPlan.currency_format),
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
      '/plans/p1/settings': () => settingsOf(eurPlan.currency_format),
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
      '/plans/p1/settings': () => settingsOf(eurPlan.currency_format),
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
      '/plans/p1/settings': () => settingsOf(eurPlan.currency_format),
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
    const c = client({ '/plans/p1/settings': () => settingsOf(usdPlan.currency_format), '/plans/p1/months/current': () => monthFixture })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('$150.25')
    expect(m.categories[0]!.assignedText).toBe('$1,500.00')
  })

  it('listTransactions still renders "$"', async () => {
    const c = client({ '/plans/p1/settings': () => settingsOf(usdPlan.currency_format), '/plans/p1/transactions': () => ({ transactions: [apiTxn()] }) })
    const y = new Ynab({ client: c, allowWrites: false })
    const res: any = await y.listTransactions('p1', {})
    expect(res.transactions[0].amountText).toBe('-$45.50')
  })
})

describe('currency symbol: 3) an unresolvable symbol renders currency-neutral, never "$"', () => {
  it('plan settings 404 (plan not found)', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/settings') throw new Error('404 plan not found')
      if (path === '/plans/p1/months/current') return monthFixture
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('150.25')
    expect(m.readyToAssignText).not.toContain('$')
    expect(m.categories[0]!.assignedText).toBe('1,500.00')
    expect(m.categories[0]!.assignedText).not.toContain('$')
  })

  it('settings fetch fails outright (network error)', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/settings') throw new Error('offline')
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
      '/plans/p1/settings': () => settingsOf({ iso_code: 'XYZ' }),
      '/plans/p1/months/current': () => monthFixture,
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('150.25')
    expect(m.readyToAssignText).not.toContain('$')
  })

  it('write-path inverse text also renders currency-neutral on an unresolvable symbol', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/settings') throw new Error('offline')
      if (path === '/plans/p1/months/2026-07-01/categories/c1') return { category: { id: 'c1', name: 'Groceries', budgeted: 100000 } }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: true })
    const res: any = await y.assignBudget('p1', '2026-07-01', 'c1', 250, undefined, { confirm: true })
    expect(res.assignedText).toBe('250.00')
    expect(res.inverse).not.toContain('$')
  })
})

describe('currency symbol: 4) resolved at most once per plan per Ynab instance', () => {
  it('two different *Text-emitting calls against the same plan share one settings fetch', async () => {
    const c = client({
      '/plans/p1/settings': () => settingsOf(eurPlan.currency_format),
      '/plans/p1/months/current': () => monthFixture,
      '/plans/p1/categories': () => ({ category_groups: [] }),
      '/plans/p1/transactions': () => ({ transactions: [apiTxn()] }),
    })
    const y = new Ynab({ client: c, allowWrites: false })
    await y.getMonth('p1', 'current')
    await y.listCategories('p1')
    await y.listTransactions('p1', {})
    const settingsCalls = c.request.mock.calls.filter(([path]: any[]) => path === '/plans/p1/settings')
    // MUTATION CHECK: if #resolveCurrency ever goes back to fetching /settings per call site instead of
    // caching per Ynab instance, this jumps from 1 to 3 (one per method called above).
    expect(settingsCalls).toHaveLength(1)
  })

  it('concurrent (Promise.all) *Text-emitting calls against the same plan still share one settings fetch', async () => {
    const c = client({
      '/plans/p1/settings': () => settingsOf(eurPlan.currency_format),
      '/plans/p1/months/current': () => monthFixture,
      '/plans/p1/categories': () => ({ category_groups: [] }),
    })
    const y = new Ynab({ client: c, allowWrites: false })
    await Promise.all([y.getMonth('p1', 'current'), y.listCategories('p1')])
    const settingsCalls = c.request.mock.calls.filter(([path]: any[]) => path === '/plans/p1/settings')
    expect(settingsCalls).toHaveLength(1)
  })

  it('a transient fetch failure is NOT cached — the next call retries instead of staying degraded forever', async () => {
    let attempts = 0
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/settings') {
        attempts++
        if (attempts === 1) throw new Error('transient blip')
        return settingsOf(eurPlan.currency_format)
      }
      if (path === '/plans/p1/transactions') return { transactions: [apiTxn()] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const first: any = await y.listTransactions('p1', {})
    expect(first.transactions[0].amountText).toBe('-45.50') // degraded: neutral, not "$"
    const second: any = await y.listTransactions('p1', {})
    expect(second.transactions[0].amountText).toBe('-€45.50') // retried and recovered
    expect(attempts).toBe(2)
  })
})

// IMPORTANT 1 (review round 3): the round-2 "don't cache rejections" fix only wrapped the ORIGINAL
// fetcher's own `await` in try/catch — a concurrent cache HIT (`if (cached) return cached`) handed the
// caller the raw, still-rejecting fetch promise with no try/catch of its own. Any method that resolves
// currency for the SAME plan twice inside one `Promise.all` — a direct #resolveCurrency call alongside
// getMonth/#allTxns (which each resolve internally) — got one graceful degradation and one propagated
// rejection, contradicting #resolveCurrency's own docstring ("resolves to `{ symbol: '' }` rather than
// throwing"). getBudgetHealth and getPlanOverview are exactly this shape.
describe('currency symbol: 9) a cache HIT degrades gracefully too, not just the original fetcher', () => {
  it('getBudgetHealth returns degraded output instead of throwing when /settings fails', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/settings') throw new Error('offline')
      if (path === '/plans/p1/months/current') return monthFixture
      if (path === '/plans/p1/accounts') return { accounts: [
        { id: 'a1', name: 'Visa', type: 'creditCard', on_budget: true, closed: false, deleted: false, balance: -50000, cleared_balance: -50000, uncleared_balance: 0 },
      ] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    // MUTATION CHECK: before the fix, this `await` rejects (the direct #resolveCurrency call in
    // getBudgetHealth's own Promise.all races getMonth's internal call, loses the race, and receives the
    // raw rejecting promise from the cache) instead of resolving with degraded, symbol-less output.
    const health: any = await y.getBudgetHealth('p1')
    expect(health.readyToAssignText).toBe('150.25')
    expect(health.readyToAssignText).not.toContain('$')
  })

  it('getPlanOverview (alias path) returns degraded output instead of throwing when /settings fails', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [] } // alias never matches a /plans entry — see finding 5
      if (path === '/plans/last-used/settings') throw new Error('offline')
      if (path === '/plans/last-used/months/current') return monthFixture
      if (path === '/plans/last-used/accounts') return { accounts: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const overview: any = await y.getPlanOverview('last-used')
    expect(overview.plan.currency).toBeNull() // unresolvable — never a guessed "USD" (IMPORTANT 2)
    expect(overview.month.readyToAssignText).toBe('150.25')
    expect(overview.month.readyToAssignText).not.toContain('$')
  })
})

// CRITICAL 1 (review round 2): 'last-used' and 'default' are YNAB path-param ALIASES, never real plan
// ids — YNAB documents them on getPlanSettingsById specifically. The old resolution
// (`plans.find(p => p.id === planId)` over `GET /plans`) could never match one, silently stripping the
// symbol for EVERY caller using the documented alias (apps/mcp/src/tools.ts's plan_id schema). Fixed by
// resolving via `GET /plans/{plan_id}/settings`, which takes the id/alias straight into the URL.
describe('currency symbol: 5) YNAB path-param aliases resolve a real symbol', () => {
  it("plan_id: 'last-used' resolves via /plans/last-used/settings, not a /plans list lookup", async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/last-used/settings') return settingsOf(eurPlan.currency_format)
      if (path === '/plans/last-used/transactions') return { transactions: [apiTxn()] }
      // No handler for `/plans` at all — if resolution ever falls back to a /plans list lookup, this
      // throws and the test fails, proving the fix didn't regress to the old path.
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const res: any = await y.listTransactions('last-used', {})
    expect(res.transactions[0].amountText).toBe('-€45.50')
    expect(c.request.mock.calls.some(([p]: any[]) => p === '/plans')).toBe(false)
  })

  it("plan_id: 'default' resolves the same way", async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/default/settings') return settingsOf(usdPlan.currency_format)
      if (path === '/plans/default/months/current') return monthFixture
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('default', 'current')
    expect(m.readyToAssignText).toBe('$150.25')
  })
})

// IMPORTANT 4 (review round 2): listPlans() used to share a cache with the symbol lookup (both hit
// `/plans`), so in the stdio deployment (one Ynab per process) it froze at first call for the process
// lifetime. Now decoupled from #resolveCurrency entirely, listPlans() must hit the network every call.
describe('currency symbol: 6) listPlans() is not memoized', () => {
  it('a second listPlans() call sees fresh data, not a frozen first-call snapshot', async () => {
    let call = 0
    const c = { request: vi.fn(async (path: string) => {
      if (path !== '/plans') throw new Error(`unmocked ${path}`)
      call++
      return call === 1
        ? { plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } }] }
        : { plans: [
            { id: 'p1', name: 'Family', last_modified_on: '2026-08-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } },
            { id: 'p2', name: 'New Budget', last_modified_on: '2026-08-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } },
          ] }
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const first = await y.listPlans()
    expect(first).toHaveLength(1)
    expect(first[0]!.lastModified).toBe('2026-07-01T00:00:00Z')
    const second = await y.listPlans()
    expect(second).toHaveLength(2) // a newly created budget shows up
    expect(second[0]!.lastModified).toBe('2026-08-01T00:00:00Z') // lastModified actually updates
    expect(call).toBe(2) // MUTATION CHECK: not memoized — a real fetch happened both times
  })
})

// IMPORTANT 6 (review round 2): the plan's full CurrencyFormat (decimals/separators/symbol position/
// display_symbol) is honored, not just the symbol — Critical 1's fix hands all of it back in the same
// `/settings` call.
describe('currency symbol: 7) full currency format fidelity (not just the symbol)', () => {
  it('SEK: symbol_first:false suffixes with a separating space, comma-for-thousands becomes a space', async () => {
    const c = client({
      '/plans/p1/settings': () => settingsOf({ iso_code: 'SEK', currency_symbol: 'kr', symbol_first: false, decimal_digits: 2, decimal_separator: ',', group_separator: ' ', display_symbol: true }),
      '/plans/p1/months/current': () => monthFixture,
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.categories[0]!.assignedText).toBe('1 500,00 kr')
  })
  it('JPY: decimal_digits:0 drops the fractional part entirely', async () => {
    const c = client({
      '/plans/p1/settings': () => settingsOf({ iso_code: 'JPY', currency_symbol: '¥', symbol_first: true, decimal_digits: 0, decimal_separator: '.', group_separator: ',', display_symbol: true }),
      '/plans/p1/months/current': () => monthFixture,
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.categories[0]!.assignedText).toBe('¥1,500')
  })
  it('display_symbol:false omits the symbol even though one is present', async () => {
    const c = client({
      '/plans/p1/settings': () => settingsOf({ iso_code: 'USD', currency_symbol: '$', symbol_first: true, decimal_digits: 2, decimal_separator: '.', group_separator: ',', display_symbol: false }),
      '/plans/p1/months/current': () => monthFixture,
    })
    const y = new Ynab({ client: c, allowWrites: false })
    const m = await y.getMonth('p1', 'current')
    expect(m.categories[0]!.assignedText).toBe('1,500.00')
  })
})

// MINOR seam (review round 2): lets a host (e.g. a Worker with a cross-request cache) supply the symbol
// without a per-request settings fetch.
describe('currency symbol: 8) injectable currencySymbol seam', () => {
  it('a fixed string skips the network call entirely', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/months/current') return monthFixture
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false, currencySymbol: '€' })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('€150.25')
    expect(c.request.mock.calls.some(([p]: any[]) => String(p).endsWith('/settings'))).toBe(false)
  })
  it('a function seam is called with planId and can fall back to the live lookup on a cache miss', async () => {
    const c = client({
      '/plans/p1/settings': () => settingsOf(eurPlan.currency_format),
      '/plans/p1/months/current': () => monthFixture,
    })
    const seamCalls: string[] = []
    const y = new Ynab({ client: c, allowWrites: false, currencySymbol: async (planId: string) => { seamCalls.push(planId); return undefined } })
    const m = await y.getMonth('p1', 'current')
    expect(seamCalls).toEqual(['p1'])
    expect(m.readyToAssignText).toBe('€150.25') // fell back to the live /settings lookup
  })
  it('a function seam returning a value skips the network call', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/months/current') return monthFixture
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false, currencySymbol: async () => '¥' })
    const m = await y.getMonth('p1', 'current')
    expect(m.readyToAssignText).toBe('¥150.25')
    expect(c.request.mock.calls.some(([p]: any[]) => String(p).endsWith('/settings'))).toBe(false)
  })
  // review round 3, MINOR seam widened: a string-only seam can't express symbol placement or
  // separators — a host caching a SEK plan's bare symbol got "kr1,500.00" (prefix, US separators),
  // exactly the misformatting IMPORTANT 6 fixed for the live path. A full CurrencyFormatOpts fixes it.
  it('a full CurrencyFormatOpts (not just a string) is honored, both as a fixed value and via the function seam', async () => {
    const sek: CurrencyFormatOpts = { symbol: 'kr', symbolFirst: false, decimalSeparator: ',', groupSeparator: ' ' }
    const c1 = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/months/current') return monthFixture
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y1 = new Ynab({ client: c1, allowWrites: false, currencySymbol: sek })
    const m1 = await y1.getMonth('p1', 'current')
    expect(m1.categories[0]!.assignedText).toBe('1 500,00 kr')
    expect(c1.request.mock.calls.some(([p]: any[]) => String(p).endsWith('/settings'))).toBe(false)

    const c2 = { request: vi.fn(async (path: string) => {
      if (path === '/plans/p1/months/current') return monthFixture
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y2 = new Ynab({ client: c2, allowWrites: false, currencySymbol: async () => sek })
    const m2 = await y2.getMonth('p1', 'current')
    expect(m2.categories[0]!.assignedText).toBe('1 500,00 kr')
  })
})

// IMPORTANT 2 (review round 3): getPlanOverview used to resolve plan metadata via
// `plans.find(p => p.id === planId) ?? { name: '(current plan)', currency: 'USD' }` — `find` can never
// match a YNAB path-param alias ('last-used'/'default', see finding 5), so every alias caller got a
// fabricated "USD" as `plan.currency`, worst exactly where the symbol is deliberately absent
// (display_symbol:false) and that ISO code is the model's only currency signal left.
describe('currency symbol: 10) getPlanOverview never fabricates a currency, and costs one fewer request for a real id', () => {
  it("plan_id: 'last-used' (SEK plan) reports the real ISO code, not a fabricated USD", async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [{ id: 'p9', name: 'Someone Else', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } }] }
      if (path === '/plans/last-used/settings') return settingsOf({ iso_code: 'SEK', currency_symbol: 'kr', symbol_first: false, decimal_digits: 2, decimal_separator: ',', group_separator: ' ', display_symbol: true })
      if (path === '/plans/last-used/months/current') return monthFixture
      if (path === '/plans/last-used/accounts') return { accounts: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const overview: any = await y.getPlanOverview('last-used')
    expect(overview.plan.currency).toBe('SEK') // not 'USD' — MUTATION CHECK for the old `?? 'USD'` fallback
    expect(overview.month.readyToAssignText).toBe('150,25 kr') // sanity: real SEK formatting, not USD
  })

  it("plan_id: 'last-used' reports currency: null when even /settings can't resolve it — never a guess", async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [] }
      if (path === '/plans/last-used/settings') throw new Error('offline')
      if (path === '/plans/last-used/months/current') return monthFixture
      if (path === '/plans/last-used/accounts') return { accounts: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const overview: any = await y.getPlanOverview('last-used')
    expect(overview.plan.currency).toBeNull()
  })

  it('a real plan id and an alias id cost the same 4 requests — /settings is always live, never skipped via /plans-seeding', async () => {
    const cReal = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } }] }
      if (path === '/plans/p1/months/current') return monthFixture
      if (path === '/plans/p1/accounts') return { accounts: [] }
      if (path === '/plans/p1/settings') return settingsOf({ iso_code: 'USD', currency_symbol: '$' })
      throw new Error(`unmocked ${path}`)
    }) } as any
    const yReal = new Ynab({ client: cReal, allowWrites: false })
    const overviewReal: any = await yReal.getPlanOverview('p1')
    expect(overviewReal.plan.currency).toBe('USD')
    // MUTATION CHECK: exactly 4 requests (/plans, /accounts, /months/current, /settings) — 3 would mean
    // the cache-seeding shortcut (removed for correctness, see finding 12) crept back in.
    expect(cReal.request.mock.calls).toHaveLength(4)

    const cAlias = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [] }
      if (path === '/plans/last-used/settings') return settingsOf({ iso_code: 'USD', currency_symbol: '$' })
      if (path === '/plans/last-used/months/current') return monthFixture
      if (path === '/plans/last-used/accounts') return { accounts: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const yAlias = new Ynab({ client: cAlias, allowWrites: false })
    await yAlias.getPlanOverview('last-used')
    expect(cAlias.request.mock.calls).toHaveLength(4)
  })

  it('all four requests fire concurrently — /plans, /accounts, /months/current, /settings are all dispatched before /plans resolves', async () => {
    const order: string[] = []
    let resolvePlans!: (v: unknown) => void
    const plansPromise = new Promise((res) => { resolvePlans = res })
    const c = { request: vi.fn((path: string) => {
      order.push(path)
      if (path === '/plans') return plansPromise
      if (path === '/plans/p1/accounts') return Promise.resolve({ accounts: [] })
      if (path === '/plans/p1/months/current') return Promise.resolve(monthFixture)
      if (path === '/plans/p1/settings') return Promise.resolve(settingsOf({ iso_code: 'USD', currency_symbol: '$' }))
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const overviewPromise = y.getPlanOverview('p1')
    // MUTATION CHECK: if /plans were awaited alone before starting the rest (the round-3 sequencing
    // this fix removes), only '/plans' would be dispatched at this point — accounts/month/settings
    // wouldn't fire until AFTER /plans resolves (a microtask away). With a single 4-way Promise.all,
    // request() is invoked for all four synchronously before this line runs, so all four are already
    // in `order` while /plans is still unresolved.
    expect(order).toEqual(['/plans', '/plans/p1/accounts', '/plans/p1/months/current', '/plans/p1/settings'])
    resolvePlans({ plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } }] })
    const overview: any = await overviewPromise
    expect(overview.plan.currency).toBe('USD')
  })

  it('a real plan id whose /plans entry has currency_format: null still resolves its currency live via /settings', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: null }] }
      if (path === '/plans/p1/settings') return settingsOf({ iso_code: 'SEK', currency_symbol: 'kr', symbol_first: false, decimal_digits: 2, decimal_separator: ',', group_separator: ' ', display_symbol: true })
      if (path === '/plans/p1/months/current') return monthFixture
      if (path === '/plans/p1/accounts') return { accounts: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const overview: any = await y.getPlanOverview('p1')
    // MUTATION CHECK: before the fix, the seeding guard's `if (rawPlan && ...)` ran regardless of
    // whether currency_format was populated, permanently caching `{ symbol: '' }` and never calling
    // /settings at all — this would be `null`/'150.25' and 0 calls.
    expect(overview.plan.currency).toBe('SEK')
    expect(overview.month.readyToAssignText).toBe('150,25 kr')
    const settingsCalls = c.request.mock.calls.filter(([p]: any[]) => p === '/plans/p1/settings')
    expect(settingsCalls).toHaveLength(1)
  })

  it('a real plan id whose /plans entry has currency_format absent entirely still resolves its currency live via /settings', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z' }] } // currency_format key absent
      if (path === '/plans/p1/settings') return settingsOf({ iso_code: 'SEK', currency_symbol: 'kr', symbol_first: false, decimal_digits: 2, decimal_separator: ',', group_separator: ' ', display_symbol: true })
      if (path === '/plans/p1/months/current') return monthFixture
      if (path === '/plans/p1/accounts') return { accounts: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const overview: any = await y.getPlanOverview('p1')
    expect(overview.plan.currency).toBe('SEK')
    expect(overview.month.readyToAssignText).toBe('150,25 kr')
    const settingsCalls = c.request.mock.calls.filter(([p]: any[]) => p === '/plans/p1/settings')
    expect(settingsCalls).toHaveLength(1)
  })

  it('a configured currencySymbol override still wins over the /plans-seeding shortcut', async () => {
    const c = { request: vi.fn(async (path: string) => {
      if (path === '/plans') return { plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD', currency_symbol: '$' } }] }
      if (path === '/plans/p1/months/current') return monthFixture
      if (path === '/plans/p1/accounts') return { accounts: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false, currencySymbol: '€' })
    const overview: any = await y.getPlanOverview('p1')
    expect(overview.month.readyToAssignText).toBe('€150.25') // override wins, not the /plans-derived "$"
  })
})

describe('listPlans reports unresolved currency as null, never a guessed default', () => {
  // The model reads list_plans directly, so a fabricated "USD"/"$" for a plan whose currency_format
  // is absent is a false statement at the source — the same defect class every *Text field in this
  // file exists to close. Unresolved must read as unresolved.
  it('emits null for both fields when currency_format is missing', async () => {
    const client = { request: vi.fn(async () => ({ plans: [{ id: 'p1', name: 'Budget', last_modified_on: '2026-08-07' }] })) } as any
    const [plan] = await new Ynab({ client, allowWrites: false }).listPlans()
    expect(plan!.currency).toBeNull()
    expect(plan!.currencySymbol).toBeNull()
  })

  it('still reports the real values when present', async () => {
    const client = { request: vi.fn(async () => ({ plans: [{ id: 'p1', name: 'Budget', currency_format: { iso_code: 'SEK', currency_symbol: 'kr' }, last_modified_on: '2026-08-07' }] })) } as any
    const [plan] = await new Ynab({ client, allowWrites: false }).listPlans()
    expect(plan!.currency).toBe('SEK')
    expect(plan!.currencySymbol).toBe('kr')
  })
})
