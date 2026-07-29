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
    expect(m.categories[1]).toMatchObject({ name: 'Dining', assigned: 200, activity: -155.5, available: 44.5, goalTarget: null })
    expect(m.categories[0]!.goalTarget).toBe(1500)
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
})
