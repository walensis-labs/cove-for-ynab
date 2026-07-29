import { YnabClient } from './client.js'
import { DeltaCache } from './delta-cache.js'
import { UndoJournal } from './undo-journal.js'
import { milliToDollars } from './money.js'
import type { CategorySnapshot, ScheduledSnapshot, Txn } from './types.js'

const d = milliToDollars

export class WriteDisabledError extends Error {
  constructor() {
    super('Writes are disabled. This server runs read-only by default to protect your budget. ' +
      'To enable writes, set the environment variable YNAB_ALLOW_WRITES=1 in your MCP server config and restart.')
  }
}

function mapCategory(c: any): CategorySnapshot {
  return {
    id: c.id, name: c.name, group: c.category_group_name ?? '', hidden: !!c.hidden,
    assigned: d(c.budgeted), activity: d(c.activity), available: d(c.balance),
    goalType: c.goal_type ?? null,
    goalTarget: c.goal_type ? d(c.goal_target ?? 0) : null,
    goalUnderFunded: c.goal_under_funded == null ? null : d(c.goal_under_funded),
    goalPercentageComplete: c.goal_percentage_complete ?? null,
  }
}

export function mapTxn(t: any): Txn {
  return {
    id: t.id, date: t.date, amount: d(t.amount),
    payeeName: t.payee_name ?? null, payeeId: t.payee_id ?? null,
    categoryName: t.category_name ?? null, categoryId: t.category_id ?? null,
    accountName: t.account_name ?? '', accountId: t.account_id,
    memo: t.memo ?? null, cleared: t.cleared, approved: !!t.approved,
    flagColor: t.flag_color ?? null, transferAccountId: t.transfer_account_id ?? null,
    importId: t.import_id ?? null,
    ...(t.subtransactions?.length
      ? { subtransactions: t.subtransactions.filter((s: any) => !s.deleted).map((s: any) => ({ amount: d(s.amount), categoryName: s.category_name ?? null, memo: s.memo ?? null })) }
      : {}),
  }
}

export class Ynab {
  readonly client: YnabClient
  readonly cache?: DeltaCache
  readonly journal?: UndoJournal
  readonly allowWrites: boolean

  constructor(opts: { client: YnabClient; cache?: DeltaCache; journal?: UndoJournal; allowWrites: boolean }) {
    this.client = opts.client; this.cache = opts.cache; this.journal = opts.journal; this.allowWrites = opts.allowWrites
  }

  assertWrites(): void { if (!this.allowWrites) throw new WriteDisabledError() }

  async listPlans() {
    const data = await this.client.request<any>('/plans')
    return data.plans.map((p: any) => ({ id: p.id, name: p.name, currency: p.currency_format?.iso_code ?? 'USD', lastModified: p.last_modified_on }))
  }

  async getMonth(planId: string, month: string) {
    const data = await this.client.request<any>(`/plans/${planId}/months/${month}`)
    const m = data.month
    return {
      month: m.month, readyToAssign: d(m.to_be_budgeted), ageOfMoney: m.age_of_money ?? null,
      categories: m.categories.filter((c: any) => !c.deleted).map(mapCategory),
    }
  }

  async listCategories(planId: string): Promise<CategorySnapshot[]> {
    const data = await this.client.request<any>(`/plans/${planId}/categories`)
    return data.category_groups
      .filter((g: any) => !g.deleted && !g.hidden)
      .flatMap((g: any) => g.categories.filter((c: any) => !c.deleted).map((c: any) => mapCategory({ ...c, category_group_name: g.name })))
  }

  async listPayees(planId: string) {
    const known = this.cache?.knowledge(planId, 'payees')
    const data = await this.client.request<any>('/plans/' + planId + '/payees', { query: { last_knowledge_of_server: known } })
    const merged = this.cache
      ? this.cache.merge(planId, 'payees', data.server_knowledge, data.payees)
      : data.payees.filter((p: any) => !p.deleted)
    return merged.filter((p: any) => !p.deleted).map((p: any) => ({ id: p.id, name: p.name, transferAccountId: p.transfer_account_id ?? null }))
  }

  async listScheduled(planId: string): Promise<ScheduledSnapshot[]> {
    const data = await this.client.request<any>(`/plans/${planId}/scheduled_transactions`)
    return data.scheduled_transactions.filter((s: any) => !s.deleted).map((s: any) => ({
      id: s.id, dateNext: s.date_next, frequency: s.frequency, amount: d(s.amount),
      payeeName: s.payee_name ?? null, categoryName: s.category_name ?? null, memo: s.memo ?? null,
    }))
  }

  async getPlanOverview(planId: string) {
    const [plans, accountsData, month] = await Promise.all([
      this.listPlans(),
      this.client.request<any>(`/plans/${planId}/accounts`),
      this.getMonth(planId, 'current'),
    ])
    const plan = plans.find((p: any) => p.id === planId) ?? { id: planId, name: '(current plan)', currency: 'USD' }
    const accounts = accountsData.accounts.filter((a: any) => !a.deleted && !a.closed).map((a: any) => ({
      id: a.id, name: a.name, type: a.type, onBudget: !!a.on_budget,
      balance: d(a.balance), cleared: d(a.cleared_balance), uncleared: d(a.uncleared_balance),
      lastReconciledAt: a.last_reconciled_at ?? null,
    }))
    const groups = new Map<string, { assigned: number; activity: number; available: number }>()
    for (const c of month.categories) {
      const g = groups.get(c.group) ?? { assigned: 0, activity: 0, available: 0 }
      g.assigned += c.assigned; g.activity += c.activity; g.available += c.available
      groups.set(c.group, g)
    }
    const budgeted = month.categories.reduce((s: number, c: CategorySnapshot) => s + c.assigned, 0)
    const activity = month.categories.reduce((s: number, c: CategorySnapshot) => s + c.activity, 0)
    return {
      plan: { id: plan.id, name: plan.name, currency: plan.currency },
      month: { month: month.month, readyToAssign: month.readyToAssign, ageOfMoney: month.ageOfMoney, activity: Math.round(activity * 100) / 100, budgeted: Math.round(budgeted * 100) / 100 },
      accounts,
      categoryGroups: [...groups.entries()].map(([name, v]) => ({ name, assigned: Math.round(v.assigned * 100) / 100, activity: Math.round(v.activity * 100) / 100, available: Math.round(v.available * 100) / 100 })),
    }
  }
}
