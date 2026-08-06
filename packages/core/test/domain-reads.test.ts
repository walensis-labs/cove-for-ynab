import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'
import { DeltaCache } from '../src/delta-cache.js'

function fakeClient(routes: Record<string, (q?: any) => unknown>) {
  return {
    request: vi.fn(async (path: string, opts?: { query?: any }) => {
      const key = Object.keys(routes).find((r) => path === r)
      if (!key) throw new Error(`unmocked path ${path}`)
      return routes[key]!(opts?.query)
    }),
  } as any
}

const monthFixture = {
  month: { month: '2026-07-01', to_be_budgeted: 150250, age_of_money: 32, activity: -2100500, budgeted: 3000000,
    categories: [
      { id: 'c1', category_group_name: 'Bills', name: 'Rent', hidden: false, budgeted: 1500000, activity: -1500000, balance: 0,
        goal_type: 'NEED', goal_target: 1500000, goal_under_funded: 0, goal_percentage_complete: 100, deleted: false },
      { id: 'c2', category_group_name: 'Fun', name: 'Dining', hidden: false, budgeted: 200000, activity: -155500, balance: 44500,
        goal_type: null, goal_target: 0, goal_under_funded: null, goal_percentage_complete: null, deleted: false },
    ] },
}

describe('Ynab reads', () => {
  it('lists plans with currency', async () => {
    const client = fakeClient({ '/plans': () => ({ plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD' } }] }) })
    const y = new Ynab({ client, allowWrites: false })
    const plans = await y.listPlans()
    expect(plans).toEqual([{ id: 'p1', name: 'Family', currency: 'USD', lastModified: '2026-07-01T00:00:00Z' }])
  })
  it('getMonth converts milliunits to dollars everywhere', async () => {
    const client = fakeClient({ '/plans/p1/months/2026-07-01': () => monthFixture })
    const y = new Ynab({ client, allowWrites: false })
    const m = await y.getMonth('p1', '2026-07-01')
    expect(m.readyToAssign).toBe(150.25)
    expect(m.categories[1]).toMatchObject({
      name: 'Dining', assigned: 200, assignedText: '$200.00', activity: -155.5, activityText: '-$155.50',
      available: 44.5, availableText: '$44.50', goalTarget: null, goalTargetText: null,
    })
    expect(m.categories[0]!.goalTarget).toBe(1500)
    expect(m.categories[0]!.goalTargetText).toBe('$1,500.00')
  })
  it('listPayees uses delta cache on second call', async () => {
    const calls: any[] = []
    const client = {
      request: vi.fn(async (_p: string, opts?: any) => {
        calls.push(opts?.query?.last_knowledge_of_server)
        return calls.length === 1
          ? { payees: [{ id: 'a', name: 'Kroger', transfer_account_id: null, deleted: false }], server_knowledge: 10 }
          : { payees: [], server_knowledge: 10 }
      }),
    } as any
    const y = new Ynab({ client, cache: new DeltaCache(), allowWrites: false })
    await y.listPayees('p1')
    const second = await y.listPayees('p1')
    expect(calls).toEqual([undefined, 10])
    expect(second).toEqual([{ id: 'a', name: 'Kroger', transferAccountId: null }])
  })
  it('listCategories excludes hidden/deleted groups but keeps individually-hidden categories', async () => {
    const client = fakeClient({
      '/plans/p1/categories': () => ({
        category_groups: [
          {
            id: 'gA', name: 'A', hidden: false, deleted: false,
            categories: [
              { id: 'c1', name: 'Normal', hidden: false, deleted: false, budgeted: 100000, activity: -50000, balance: 50000, goal_type: null, goal_target: 0, goal_under_funded: null, goal_percentage_complete: null },
              { id: 'c2', name: 'HiddenCat', hidden: true, deleted: false, budgeted: 0, activity: 0, balance: 0, goal_type: null, goal_target: 0, goal_under_funded: null, goal_percentage_complete: null },
              { id: 'c3', name: 'DeletedCat', hidden: false, deleted: true, budgeted: 0, activity: 0, balance: 0, goal_type: null, goal_target: 0, goal_under_funded: null, goal_percentage_complete: null },
            ],
          },
          {
            id: 'gB', name: 'B', hidden: true, deleted: false,
            categories: [
              { id: 'c4', name: 'InHiddenGroup', hidden: false, deleted: false, budgeted: 0, activity: 0, balance: 0, goal_type: null, goal_target: 0, goal_under_funded: null, goal_percentage_complete: null },
            ],
          },
        ],
      }),
    })
    const y = new Ynab({ client, allowWrites: false })
    const cats = await y.listCategories('p1')
    expect(cats.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(cats.every((c) => c.group === 'A')).toBe(true)
    expect(cats.find((c) => c.id === 'c2')).toMatchObject({ name: 'HiddenCat', hidden: true })
  })
  it('getPlanOverview aggregates accounts and category groups with dollar rounding', async () => {
    const client = fakeClient({
      '/plans': () => ({ plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD' } }] }),
      '/plans/p1/accounts': () => ({
        accounts: [
          { id: 'a1', name: 'Checking', type: 'checking', on_budget: true, balance: 1234560, cleared_balance: 1000000, uncleared_balance: 234560, last_reconciled_at: null, deleted: false, closed: false },
          { id: 'a2', name: 'ClosedAcct', type: 'checking', on_budget: true, balance: 0, cleared_balance: 0, uncleared_balance: 0, last_reconciled_at: null, deleted: false, closed: true },
          { id: 'a3', name: 'DeletedAcct', type: 'checking', on_budget: true, balance: 0, cleared_balance: 0, uncleared_balance: 0, last_reconciled_at: null, deleted: true, closed: false },
        ],
      }),
      '/plans/p1/months/current': () => monthFixture,
    })
    const y = new Ynab({ client, allowWrites: false })
    const overview = await y.getPlanOverview('p1')
    expect(overview.plan).toEqual({ id: 'p1', name: 'Family', currency: 'USD' })
    expect(overview.accounts).toEqual([
      {
        id: 'a1', name: 'Checking', type: 'checking', onBudget: true,
        balance: 1234.56, balanceText: '$1,234.56', cleared: 1000, clearedText: '$1,000.00',
        uncleared: 234.56, unclearedText: '$234.56', lastReconciledAt: null,
      },
    ])
    expect(overview.month.readyToAssign).toBe(150.25)
    expect(overview.month.readyToAssignText).toBe('$150.25')
    expect(overview.month.budgeted).toBe(1700)
    expect(overview.month.budgetedText).toBe('$1,700.00')
    expect(overview.month.activity).toBe(-1655.5)
    expect(overview.month.activityText).toBe('-$1,655.50')
    expect(overview.categoryGroups).toEqual([
      { name: 'Bills', assigned: 1500, assignedText: '$1,500.00', activity: -1500, activityText: '-$1,500.00', available: 0, availableText: '$0.00' },
      { name: 'Fun', assigned: 200, assignedText: '$200.00', activity: -155.5, activityText: '-$155.50', available: 44.5, availableText: '$44.50' },
    ])
  })
  it('listScheduled converts amounts and excludes deleted', async () => {
    const client = fakeClient({
      '/plans/p1/scheduled_transactions': () => ({
        scheduled_transactions: [
          { id: 's1', date_next: '2026-08-01', frequency: 'monthly', amount: -45500, payee_name: 'Landlord', category_name: 'Rent', memo: 'August rent', deleted: false },
          { id: 's2', date_next: '2026-08-05', frequency: 'weekly', amount: -1000, payee_name: 'X', category_name: 'Y', memo: null, deleted: true },
        ],
      }),
    })
    const y = new Ynab({ client, allowWrites: false })
    const scheduled = await y.listScheduled('p1')
    expect(scheduled).toEqual([
      { id: 's1', dateNext: '2026-08-01', frequency: 'monthly', amount: -45.5, amountText: '-$45.50', payeeName: 'Landlord', categoryName: 'Rent', memo: 'August rent' },
    ])
  })
})
