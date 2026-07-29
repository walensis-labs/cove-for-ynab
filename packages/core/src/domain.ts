import { YnabClient } from './client.js'
import { DeltaCache } from './delta-cache.js'
import { UndoJournal, type InverseOp } from './undo-journal.js'
import { milliToDollars, dollarsToMilli } from './money.js'
import { applyFilters, aggregateTxns, type TxnFilters } from './filters.js'
import type { CategorySnapshot, ScheduledSnapshot, Txn } from './types.js'

const d = milliToDollars

export class WriteDisabledError extends Error {
  constructor() {
    super('Writes are disabled. This server runs read-only by default to protect your budget. ' +
      'To enable writes, set the environment variable YNAB_ALLOW_WRITES=1 in your MCP server config and restart.')
  }
}

export class ConfirmationRequiredError extends Error {
  constructor(what: string) {
    super(`${what} requires confirm: true${what.includes('Bulk') ? ' and expected_count matching the number of rows' : ''}. ` +
      `Re-issue the call with confirmation after showing the user what will change.`)
  }
}

const DAY = 86_400_000
function defaultSince(): string { return new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10) }

export interface NewTxn {
  accountId: string; date: string; amount: number
  payeeName?: string; payeeId?: string; categoryId?: string; memo?: string
  cleared?: 'cleared' | 'uncleared' | 'reconciled'; approved?: boolean; flagColor?: string; importId?: string
  subtransactions?: { amount: number; categoryId?: string; memo?: string }[]
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

  async listTransactions(planId: string, opts: TxnFilters & { limit?: number; offset?: number; fields?: (keyof Txn)[]; aggregate?: 'category' | 'payee' | 'month' } = {}) {
    const sinceDate = opts.sinceDate ?? defaultSince()
    const explicit = opts.sinceDate !== undefined
    const sub = [opts.accountId && `accounts/${opts.accountId}`, opts.categoryId && `categories/${opts.categoryId}`, opts.payeeId && `payees/${opts.payeeId}`].filter(Boolean)
    const path = sub.length === 1 ? `/plans/${planId}/${sub[0]}/transactions` : `/plans/${planId}/transactions`
    const data = await this.client.request<any>(path, { query: { since_date: sinceDate, until_date: opts.untilDate, type: opts.unapprovedOnly ? 'unapproved' : opts.unclearedOnly ? 'uncleared' : undefined } })
    const all = applyFilters(data.transactions.filter((t: any) => !t.deleted).map(mapTxn), { ...opts, sinceDate, ...(sub.length === 1 ? { accountId: undefined, categoryId: undefined, payeeId: undefined } : {}) } as any)
    const effectiveWindow = {
      sinceDate, untilDate: opts.untilDate ?? null,
      note: explicit ? `Window: ${sinceDate} → ${opts.untilDate ?? 'today'}.` : `No since_date given — the YNAB API defaults to the last 365 days (${sinceDate} → today). Pass since_date for older history.`,
    }
    if (opts.aggregate) return { effectiveWindow, total: all.length, aggregate: aggregateTxns(all, opts.aggregate) }
    const limit = Math.min(opts.limit ?? 25, 200)
    const offset = opts.offset ?? 0
    const page = all.slice(offset, offset + limit)
    const rows = opts.fields?.length ? page.map((t) => Object.fromEntries(opts.fields!.map((f) => [f, t[f]]))) : page
    return { effectiveWindow, total: all.length, transactions: rows, page: { limit, offset, returned: page.length } }
  }

  async getTransaction(planId: string, id: string): Promise<Txn> {
    const data = await this.client.request<any>(`/plans/${planId}/transactions/${id}`)
    return mapTxn(data.transaction)
  }

  #toApiTxn(t: any): any {
    const out: any = { account_id: t.accountId, date: t.date, amount: t.amount === undefined ? undefined : dollarsToMilli(t.amount), payee_id: t.payeeId, payee_name: t.payeeName, category_id: t.categoryId, memo: t.memo, cleared: t.cleared, approved: t.approved, flag_color: t.flagColor, import_id: t.importId }
    if (t.subtransactions) out.subtransactions = t.subtransactions.map((s: any) => ({ amount: dollarsToMilli(s.amount), category_id: s.categoryId, memo: s.memo }))
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
    return out
  }

  async createTransactions(planId: string, txns: NewTxn[]) {
    this.assertWrites()
    const jid = this.journal?.begin(`create ${txns.length} transaction(s)`, [])
    const data = await this.client.request<any>(`/plans/${planId}/transactions`, { method: 'POST', body: { transactions: txns.map((t) => this.#toApiTxn(t)) } })
    const ids: string[] = data.transaction_ids ?? []
    if (this.journal && jid) {
      this.journal.setInverse(jid, [{ kind: 'delete_transactions', planId, ids }])
      this.journal.commit(jid)
    }
    this.cache?.invalidate(planId)
    return { created: ids.length, ids }
  }

  async updateTransactions(planId: string, updates: ({ id: string } & Partial<Pick<NewTxn, 'date' | 'amount' | 'payeeId' | 'payeeName' | 'categoryId' | 'memo' | 'cleared' | 'approved' | 'flagColor'>>)[], opts: { confirm?: boolean; expectedCount?: number } = {}) {
    this.assertWrites()
    if (updates.length > 5) {
      if (!opts.confirm || opts.expectedCount === undefined) throw new ConfirmationRequiredError('Bulk transaction update (>5 rows)')
      if (opts.expectedCount !== updates.length) throw new Error(`expected_count (${opts.expectedCount}) does not match the ${updates.length} rows provided — aborting; re-check the update set.`)
    }
    const prior = await Promise.all(updates.map((u) => this.getTransaction(planId, u.id)))
    const inverse: InverseOp[] = [{ kind: 'patch_transactions', planId, updates: prior.map((p, i) => {
      const changed: Record<string, unknown> = { id: p.id }
      for (const k of Object.keys(updates[i]!)) if (k !== 'id') changed[k] = (p as any)[k] ?? null
      return changed
    }) }]
    const jid = this.journal?.begin(`update ${updates.length} transaction(s)`, inverse)
    await this.client.request<any>(`/plans/${planId}/transactions`, { method: 'PATCH', body: { transactions: updates.map((u) => ({ id: u.id, ...this.#toApiTxn(u) })) } })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { updated: updates.length }
  }

  async deleteTransaction(planId: string, id: string, opts: { confirm?: boolean } = {}) {
    this.assertWrites()
    if (!opts.confirm) throw new ConfirmationRequiredError('Deleting a transaction')
    const full = await this.client.request<any>(`/plans/${planId}/transactions/${id}`)
    const t = full.transaction
    const jid = this.journal?.begin(`delete transaction ${id} (${t.payee_name ?? 'no payee'} ${t.amount / 1000})`, [{ kind: 'restore_transactions', planId, transactions: [{
      account_id: t.account_id, date: t.date, amount: t.amount, payee_name: t.payee_name, category_id: t.category_id,
      memo: t.memo, cleared: t.cleared, approved: t.approved, flag_color: t.flag_color,
    }] }])
    await this.client.request(`/plans/${planId}/transactions/${id}`, { method: 'DELETE' })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { deleted: id }
  }

  async importTransactions(planId: string) {
    this.assertWrites()
    const data = await this.client.request<any>(`/plans/${planId}/transactions/import`, { method: 'POST' })
    this.cache?.invalidate(planId)
    return { importedCount: (data.transaction_ids ?? []).length }
  }
}
