import { YnabClient, YnabApiError } from './client.js'
import { DeltaCache } from './delta-cache.js'
import { UndoJournal, type InverseOp } from './undo-journal.js'
import { milliToDollars, dollarsToMilli } from './money.js'
import { applyFilters, aggregateTxns, TXN_FIELD_ALIASES, type TxnFilters } from './filters.js'
import { spendingSummary, budgetHealth, detectRecurring, incomeVsExpense, netWorthHistory, monthWindowStart } from './analytics.js'
import { asOfBalances, findBlockers, matchCards, findRedCategories, rankDonors, proposeMoves, type RawTxn, type RawAccount, type RawMonthCat } from './month-close.js'
import { monthRange, floatSeries } from './category-history.js'
import type { CategorySnapshot, ScheduledSnapshot, Txn } from './types.js'

const d = milliToDollars
const BLOCKER_CAP = 50

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

// Maps the camelCase keys accepted by updateTransactions to the snake_case keys the YNAB API expects,
// used to build undo inverses in API wire form (see updateTransactions).
const TXN_UPDATE_API_KEY: Record<string, string> = {
  date: 'date', amount: 'amount', payeeId: 'payee_id', payeeName: 'payee_name',
  categoryId: 'category_id', memo: 'memo', cleared: 'cleared', approved: 'approved', flagColor: 'flag_color',
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

  async listTransactions(planId: string, opts: TxnFilters & { limit?: number; offset?: number; fields?: (keyof Txn)[]; aggregate?: 'category' | 'payee' | 'month'; sort?: 'date_desc' | 'date_asc' } = {}) {
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
    // The API returns ascending date order; newest-first is the useful default for "recent" questions.
    all.sort((a, b) => (opts.sort === 'date_asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)))
    const limit = Math.min(opts.limit ?? 25, 200)
    const offset = opts.offset ?? 0
    const page = all.slice(offset, offset + limit)
    const rows = opts.fields?.length
      ? page.map((t) => Object.fromEntries(opts.fields!.map((f) => {
          const key = (TXN_FIELD_ALIASES[f as string] ?? f) as keyof Txn
          const v = t[key]
          return [f, v === undefined ? null : v]
        })))
      : page
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
    // The inverse must be in API wire form (snake_case, milliunits): undoLast PATCHes it straight
    // through to the API, unlike `prior` which is the camelCase/dollars Txn shape from getTransaction.
    // Keys whose update value is undefined (the MCP tool layer sends all fields, most undefined) are
    // skipped — they weren't actually changed, so they don't belong in the inverse.
    const inverse: InverseOp[] = [{ kind: 'patch_transactions', planId, updates: prior.map((p, i) => {
      const changed: Record<string, unknown> = { id: p.id }
      for (const k of Object.keys(updates[i]!)) {
        if (k === 'id' || (updates[i] as any)[k] === undefined) continue
        const apiKey = TXN_UPDATE_API_KEY[k]
        if (!apiKey) continue
        const priorVal = (p as any)[k]
        changed[apiKey] = k === 'amount' ? dollarsToMilli(priorVal as number) : priorVal ?? null
      }
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
    const restoreTxn: Record<string, unknown> = {
      account_id: t.account_id, date: t.date, amount: t.amount, payee_name: t.payee_name, category_id: t.category_id,
      memo: t.memo, cleared: t.cleared, approved: t.approved, flag_color: t.flag_color,
    }
    if (t.subtransactions?.length) {
      // A split transaction's inverse must recreate the split, not a single uncategorized row — the
      // top-level category_id stays null (splits never carry their own category) and the subs go along.
      restoreTxn.category_id = null
      restoreTxn.subtransactions = t.subtransactions.filter((s: any) => !s.deleted).map((s: any) => ({
        amount: s.amount, category_id: s.category_id, memo: s.memo, payee_id: s.payee_id,
      }))
    }
    const jid = this.journal?.begin(`delete transaction ${id} (${t.payee_name ?? 'no payee'} ${t.amount / 1000})`, [{ kind: 'restore_transactions', planId, transactions: [restoreTxn] }])
    await this.client.request(`/plans/${planId}/transactions/${id}`, { method: 'DELETE' })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { deleted: id }
  }

  async importTransactions(planId: string) {
    this.assertWrites()
    const data = await this.client.request<any>(`/plans/${planId}/transactions/import`, { method: 'POST' })
    const count = (data.transaction_ids ?? []).length
    const jid = this.journal?.begin(`import ${count} transaction(s) (not undoable — YNAB's API has no way to reverse an import)`, [], { undoable: false })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { importedCount: count }
  }

  async #getCategoryRaw(planId: string, categoryId: string): Promise<any> {
    return (await this.client.request<any>(`/plans/${planId}/categories/${categoryId}`)).category
  }

  async createCategory(planId: string, opts: { name: string; groupId?: string; groupName?: string }) {
    this.assertWrites()
    let groupId = opts.groupId
    if (!groupId && opts.groupName) {
      const g = await this.client.request<any>(`/plans/${planId}/category_groups`, { method: 'POST', body: { category_group: { name: opts.groupName } } })
      groupId = g.category_group.id
    }
    const data = await this.client.request<any>(`/plans/${planId}/categories`, { method: 'POST', body: { category: { name: opts.name, category_group_id: groupId } } })
    const jid = this.journal?.begin(`create category "${opts.name}" (not undoable — YNAB's API has no category delete)`, [], { undoable: false })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { id: data.category.id, name: data.category.name }
  }

  async updateCategory(planId: string, categoryId: string, patch: { name?: string; hidden?: boolean; goalTarget?: number | null; goalTargetDate?: string | null; goalFrequency?: 'monthly' | 'weekly' | 'yearly' | null; goalNeedsWholeAmount?: boolean | null }) {
    this.assertWrites()
    const prior = await this.#getCategoryRaw(planId, categoryId)
    const body: Record<string, unknown> = {}
    if (patch.name !== undefined) body.name = patch.name
    if (patch.hidden !== undefined) body.hidden = patch.hidden
    if (patch.goalTarget !== undefined) body.goal_target = patch.goalTarget === null ? null : dollarsToMilli(patch.goalTarget)
    if (patch.goalTargetDate !== undefined) body.goal_target_date = patch.goalTargetDate
    if (patch.goalFrequency !== undefined) body.goal_frequency = patch.goalFrequency
    if (patch.goalNeedsWholeAmount !== undefined) body.goal_needs_whole_amount = patch.goalNeedsWholeAmount
    const inversePatch: Record<string, unknown> = {}
    for (const k of Object.keys(body)) inversePatch[k] = prior[k] ?? null
    const jid = this.journal?.begin(`update category ${prior.name}`, [{ kind: 'patch_category', planId, categoryId, patch: inversePatch }])
    await this.client.request(`/plans/${planId}/categories/${categoryId}`, { method: 'PATCH', body: { category: body } })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { updated: categoryId }
  }

  async #patchMonthCategory(planId: string, month: string, categoryId: string, budgetedMilli: number): Promise<any> {
    return this.client.request<any>(`/plans/${planId}/months/${month}/categories/${categoryId}`, { method: 'PATCH', body: { category: { budgeted: budgetedMilli } } })
  }

  async assignBudget(planId: string, month: string, categoryId: string, amount: number) {
    this.assertWrites()
    const prior = (await this.client.request<any>(`/plans/${planId}/months/${month}/categories/${categoryId}`)).category
    const jid = this.journal?.begin(`assign ${amount} to category in ${month}`, [{ kind: 'assign_budget', planId, month, categoryId, budgetedMilli: prior.budgeted }])
    await this.#patchMonthCategory(planId, month, categoryId, dollarsToMilli(amount))
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { month, categoryId, assigned: amount }
  }

  async moveMoney(planId: string, month: string, fromCategoryId: string, toCategoryId: string, amount: number) {
    this.assertWrites()
    const [from, to] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/months/${month}/categories/${fromCategoryId}`),
      this.client.request<any>(`/plans/${planId}/months/${month}/categories/${toCategoryId}`),
    ])
    const fromPrior = from.category.budgeted as number
    const toPrior = to.category.budgeted as number
    const milli = dollarsToMilli(amount)
    const jid = this.journal?.begin(`move ${amount} between categories in ${month}`, [
      { kind: 'assign_budget', planId, month, categoryId: fromCategoryId, budgetedMilli: fromPrior },
      { kind: 'assign_budget', planId, month, categoryId: toCategoryId, budgetedMilli: toPrior },
    ])
    await this.#patchMonthCategory(planId, month, fromCategoryId, fromPrior - milli)
    try {
      await this.#patchMonthCategory(planId, month, toCategoryId, toPrior + milli)
    } catch (e) {
      try {
        await this.#patchMonthCategory(planId, month, fromCategoryId, fromPrior) // rollback
      } catch (rollbackErr) {
        // Rollback itself failed: the move is now half-applied (money left fromCategoryId but never
        // reached toCategoryId). Commit the journal entry — its two assign_budget inverses are exactly
        // the repair needed — so undo_last can restore both categories.
        if (jid) this.journal!.commit(jid)
        this.cache?.invalidate(planId)
        throw new Error(`${(e as Error).message}; rollback also failed: ${(rollbackErr as Error).message} — ` +
          `the move is half-applied; run undo_last to restore both categories.`)
      }
      throw new Error(`${(e as Error).message} — the first half of the move was rolled back; no money moved.`)
    }
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { moved: amount, from: { id: fromCategoryId, assigned: milliToDollars(fromPrior - milli) }, to: { id: toCategoryId, assigned: milliToDollars(toPrior + milli) } }
  }

  async renamePayee(planId: string, payeeId: string, name: string) {
    this.assertWrites()
    const prior = (await this.client.request<any>(`/plans/${planId}/payees/${payeeId}`)).payee
    const jid = this.journal?.begin(`rename payee ${prior.name} → ${name}`, [{ kind: 'rename_payee', planId, payeeId, name: prior.name }])
    await this.client.request(`/plans/${planId}/payees/${payeeId}`, { method: 'PATCH', body: { payee: { name } } })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { renamed: payeeId }
  }

  async createPayee(planId: string, name: string) {
    this.assertWrites()
    const data = await this.client.request<any>(`/plans/${planId}/payees`, { method: 'POST', body: { payee: { name } } })
    const jid = this.journal?.begin(`create payee "${name}" (not undoable — YNAB's API has no payee delete)`, [], { undoable: false })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { id: data.payee.id, name: data.payee.name }
  }

  async createAccount(planId: string, opts: { name: string; type: 'checking' | 'savings' | 'cash' | 'creditCard' | 'otherAsset' | 'otherLiability'; balance: number }) {
    this.assertWrites()
    const data = await this.client.request<any>(`/plans/${planId}/accounts`, { method: 'POST', body: { account: { name: opts.name, type: opts.type, balance: dollarsToMilli(opts.balance) } } })
    const jid = this.journal?.begin(`create account "${opts.name}" (not undoable — YNAB's API has no account delete)`, [], { undoable: false })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { id: data.account.id }
  }

  async createScheduled(planId: string, t: { accountId: string; date: string; amount: number; frequency: string; payeeName?: string; payeeId?: string; categoryId?: string; memo?: string }) {
    this.assertWrites()
    const jid = this.journal?.begin(`create scheduled transaction`, [])
    const data = await this.client.request<any>(`/plans/${planId}/scheduled_transactions`, { method: 'POST', body: { scheduled_transaction: { account_id: t.accountId, date: t.date, amount: dollarsToMilli(t.amount), frequency: t.frequency, payee_name: t.payeeName, payee_id: t.payeeId, category_id: t.categoryId, memo: t.memo } } })
    const id = data.scheduled_transaction.id
    if (this.journal && jid) {
      this.journal.setInverse(jid, [{ kind: 'delete_scheduled', planId, id }])
      this.journal.commit(jid)
    }
    this.cache?.invalidate(planId)
    return { id }
  }

  async updateScheduled(planId: string, id: string, patch: Record<string, unknown>) {
    this.assertWrites()
    const prior = (await this.client.request<any>(`/plans/${planId}/scheduled_transactions/${id}`)).scheduled_transaction
    const body: Record<string, unknown> = { ...patch }
    if (typeof body.amount === 'number') body.amount = dollarsToMilli(body.amount as number)
    // PUT requires the full writable object; the GET response also carries read-only fields
    // (id, date_next, payee_name, ...) that must not be echoed back — build from the writable subset only.
    // The inverse must be this SAME full snapshot regardless of which keys changed: YNAB's PUT requires
    // account_id + date at minimum, so an inverse containing only the changed keys (e.g. just `memo`)
    // would 400 when undoLast replays it.
    const writable: Record<string, unknown> = {
      account_id: prior.account_id,
      date: prior.date ?? prior.date_next,
      amount: prior.amount,
      frequency: prior.frequency,
      payee_id: prior.payee_id,
      category_id: prior.category_id,
      memo: prior.memo,
      flag_color: prior.flag_color,
    }
    const jid = this.journal?.begin(`update scheduled ${id}`, [{ kind: 'patch_scheduled', planId, id, patch: writable }])
    await this.client.request(`/plans/${planId}/scheduled_transactions/${id}`, { method: 'PUT', body: { scheduled_transaction: { ...writable, ...body } } })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { updated: id }
  }

  async deleteScheduled(planId: string, id: string, opts: { confirm?: boolean } = {}) {
    this.assertWrites()
    if (!opts.confirm) throw new ConfirmationRequiredError('Deleting a scheduled transaction')
    const prior = (await this.client.request<any>(`/plans/${planId}/scheduled_transactions/${id}`)).scheduled_transaction
    const jid = this.journal?.begin(`delete scheduled ${id}`, [{ kind: 'restore_scheduled', planId, scheduled: {
      account_id: prior.account_id, date: prior.date_next, amount: prior.amount, frequency: prior.frequency,
      payee_id: prior.payee_id, payee_name: prior.payee_name, category_id: prior.category_id, memo: prior.memo,
      flag_color: prior.flag_color,
    } }])
    await this.client.request(`/plans/${planId}/scheduled_transactions/${id}`, { method: 'DELETE' })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { deleted: id }
  }

  async undoLast(): Promise<{ undone: string; actions: number } | { undone: null; message: string }> {
    this.assertWrites()
    const entry = this.journal?.popLastCommitted()
    if (!entry) return { undone: null, message: 'Nothing to undo — the undo journal is empty.' }
    if (entry.undoable === false) {
      return { undone: null, message: `Cannot undo "${entry.description}" — YNAB's API has no way to reverse it. ` +
        `Its journal entry has been cleared; run undo_last again to undo the write before it.` }
    }
    let actions = 0
    try {
      for (const op of entry.inverse) {
        switch (op.kind) {
          case 'delete_transactions':
            for (const id of op.ids) {
              try {
                await this.client.request(`/plans/${op.planId}/transactions/${id}`, { method: 'DELETE' })
                actions++
              } catch (e) {
                // Already gone is the desired end state — tolerate it so multi-id replay is idempotent
                // and a retry doesn't get stuck re-failing on an id a prior attempt already deleted.
                if (!(e instanceof YnabApiError) || e.status !== 404) throw e
              }
            }
            break
          case 'restore_transactions':
            await this.client.request(`/plans/${op.planId}/transactions`, { method: 'POST', body: { transactions: op.transactions } }); actions++
            break
          case 'patch_transactions':
            await this.client.request(`/plans/${op.planId}/transactions`, { method: 'PATCH', body: { transactions: op.updates } }); actions++
            break
          case 'patch_category':
            await this.client.request(`/plans/${op.planId}/categories/${op.categoryId}`, { method: 'PATCH', body: { category: op.patch } }); actions++
            break
          case 'assign_budget':
            await this.#patchMonthCategory(op.planId, op.month, op.categoryId, op.budgetedMilli); actions++
            break
          case 'delete_scheduled':
            await this.client.request(`/plans/${op.planId}/scheduled_transactions/${op.id}`, { method: 'DELETE' }); actions++
            break
          case 'restore_scheduled':
            await this.client.request(`/plans/${op.planId}/scheduled_transactions`, { method: 'POST', body: { scheduled_transaction: op.scheduled } }); actions++
            break
          case 'patch_scheduled':
            await this.client.request(`/plans/${op.planId}/scheduled_transactions/${op.id}`, { method: 'PUT', body: { scheduled_transaction: op.patch } }); actions++
            break
          case 'rename_payee':
            await this.client.request(`/plans/${op.planId}/payees/${op.payeeId}`, { method: 'PATCH', body: { payee: { name: op.name } } }); actions++
            break
        }
      }
    } catch (e) {
      // Undo is destructive if we lose the record here: re-insert the popped entry so a failed
      // undo remains available to retry, rather than silently vanishing from the journal.
      if (this.journal) {
        const rid = this.journal.begin(entry.description, entry.inverse)
        this.journal.commit(rid)
      }
      throw new Error(`undo failed after completing ${actions} action(s); the entry has been re-journaled — ` +
        `run undo_last again to retry (${(e as Error).message})`)
    }
    // Undo is itself a write: invalidate the cache for every plan the executed inverse ops touched,
    // the same as every other write path does.
    for (const planId of new Set(entry.inverse.map((op) => op.planId))) this.cache?.invalidate(planId)
    return { undone: entry.description, actions }
  }

  async #allTxns(planId: string, sinceDate: string, untilDate?: string): Promise<Txn[]> {
    const data = await this.client.request<any>(`/plans/${planId}/transactions`, { query: { since_date: sinceDate, until_date: untilDate } })
    return data.transactions.filter((t: any) => !t.deleted).map(mapTxn)
  }
  #nonTransfer(txns: Txn[]): Txn[] { return txns.filter((t) => t.transferAccountId === null) }

  async getSpendingSummary(planId: string, opts: { by?: 'category' | 'payee'; sinceDate?: string; untilDate?: string; compareToPrevious?: boolean } = {}) {
    const since = opts.sinceDate ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    const until = opts.untilDate ?? new Date().toISOString().slice(0, 10)
    const cur = this.#nonTransfer(await this.#allTxns(planId, since, until))
    let compareTxns: Txn[] | undefined
    if (opts.compareToPrevious) {
      const span = Date.parse(until) - Date.parse(since)
      const prevSince = new Date(Date.parse(since) - span - 86_400_000).toISOString().slice(0, 10)
      const prevUntil = new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10)
      compareTxns = this.#nonTransfer(await this.#allTxns(planId, prevSince, prevUntil))
    }
    return { window: { since, until }, rows: spendingSummary(cur.filter((t) => t.amount < 0), { by: opts.by ?? 'category', compareTxns: compareTxns?.filter((t) => t.amount < 0) }) }
  }

  async getBudgetHealth(planId: string) {
    const [month, accountsData] = await Promise.all([this.getMonth(planId, 'current'), this.client.request<any>(`/plans/${planId}/accounts`)])
    const accounts = accountsData.accounts.filter((a: any) => !a.deleted && !a.closed).map((a: any) => ({ name: a.name, type: a.type, balance: milliToDollars(a.balance) }))
    return budgetHealth({ readyToAssign: month.readyToAssign, categories: month.categories, accounts })
  }

  async getRecurringCharges(planId: string) {
    return detectRecurring(await this.#allTxns(planId, new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10)))
  }

  async getIncomeVsExpense(planId: string, opts: { months?: number } = {}) {
    const n = opts.months ?? 6
    const today = new Date().toISOString().slice(0, 10)
    const since = monthWindowStart(today, n)
    return incomeVsExpense(this.#nonTransfer(await this.#allTxns(planId, since)), today)
  }

  async getNetWorthHistory(planId: string) {
    return netWorthHistory(await this.#allTxns(planId, '2000-01-01'))
  }

  async #monthCloseRaw(planId: string, cutoff: string, lookbackDays: number) {
    const lookback = Math.min(Math.max(lookbackDays, 1), 365)
    const since = new Date(Date.parse(cutoff) - lookback * 86_400_000).toISOString().slice(0, 10)
    const monthKey = cutoff.slice(0, 8) + '01'
    const [accountsData, txnsData, monthData] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/accounts`),
      this.client.request<any>(`/plans/${planId}/transactions`, { query: { since_date: since } }),
      this.client.request<any>(`/plans/${planId}/months/${monthKey}`),
    ])
    const accounts = accountsData.accounts.filter((a: RawAccount) => !a.deleted) as RawAccount[]
    const txns = txnsData.transactions as RawTxn[]
    const monthCats = monthData.month.categories as RawMonthCat[]
    return { accounts, txns, monthCats, rtaMilli: monthData.month.to_be_budgeted as number }
  }

  async monthClose(planId: string, opts: { cutoff: string; lookbackDays?: number }) {
    const { cutoff } = opts
    const { accounts, txns, monthCats } = await this.#monthCloseRaw(planId, cutoff, opts.lookbackDays ?? 120)
    const warnings: string[] = []
    const balances = asOfBalances(accounts, txns, cutoff)
    const { matches, warnings: matchWarnings } = matchCards(accounts, monthCats)
    warnings.push(...matchWarnings)
    const perCard = matches.map(({ account, category }) => {
      const b = balances.get(account.id)!
      return {
        account: account.name,
        workingAsOf: milliToDollars(b.workingMilli),
        clearedAsOf: milliToDollars(b.clearedMilli),
        availableAtMonthEnd: milliToDollars(category.balance),
        gap: milliToDollars(b.workingMilli + category.balance),
        paymentCategoryId: category.id,
      }
    })
    const onBudget = new Set(accounts.filter((a) => a.on_budget && !a.closed).map((a) => a.id))
    const accountName = new Map(accounts.map((a) => [a.id, a.name]))
    const raw = findBlockers(txns, cutoff, onBudget)
    const row = (t: RawTxn) => ({ id: t.id, date: t.date, payee: t.payee_name ?? null, account: t.account_name ?? accountName.get(t.account_id) ?? t.account_id, amount: milliToDollars(t.amount) })
    const cap = <T>(list: T[], label: string): T[] => {
      if (list.length > BLOCKER_CAP) warnings.push(`${label}: showing ${BLOCKER_CAP} of ${list.length} — resolve and re-run.`)
      return list.slice(0, BLOCKER_CAP)
    }
    const reds = findRedCategories(monthCats)
    const donors = rankDonors(monthCats, new Set(reds.map((c) => c.id)))
    const blockerCount = raw.unapproved.length + raw.uncategorized.length + raw.unclearedBeforeCutoff.length
    const gapStatus = blockerCount === 0 ? 'final' as const : 'provisional' as const
    return {
      cutoff,
      warnings,
      perCard,
      gapStatus,
      blockerCount,
      blockers: {
        unapproved: cap(raw.unapproved, 'unapproved').map(row),
        uncategorized: cap(raw.uncategorized, 'uncategorized').map(row),
        unclearedBeforeCutoff: cap(raw.unclearedBeforeCutoff, 'unclearedBeforeCutoff').map(row),
      },
      redCategories: reds.map((c) => ({ id: c.id, name: c.name, available: milliToDollars(c.balance), group: c.category_group_name ?? '' })),
      donors: donors.map((d) => ({ id: d.cat.id, name: d.cat.name, group: d.cat.category_group_name ?? '', available: milliToDollars(d.cat.balance), excess: milliToDollars(d.excessMilli), hasTarget: d.cat.goal_type != null })),
    }
  }

  async proposeCoverage(planId: string, opts: { cutoff: string; strategy?: 'donors_first' | 'rta_only' }) {
    const { monthCats, rtaMilli } = await this.#monthCloseRaw(planId, opts.cutoff, 120)
    const reds = findRedCategories(monthCats)
    const donors = rankDonors(monthCats, new Set(reds.map((c) => c.id)))
    const res = proposeMoves(reds, donors, rtaMilli, opts.strategy ?? 'donors_first')
    return {
      month: opts.cutoff.slice(0, 8) + '01',
      moves: res.moves.map((m) => ({ from: m.fromName, fromId: m.fromId, to: m.toName, toId: m.toId, amount: milliToDollars(m.amountMilli), source: m.source })),
      unfundable: res.unfundable.map((u) => ({ id: u.id, name: u.name, needed: milliToDollars(u.neededMilli) })),
      rtaUsed: milliToDollars(res.rtaUsedMilli),
      rtaRemaining: milliToDollars(res.rtaRemainingMilli),
    }
  }

  async #fetchMonthCategory(planId: string, monthIso: string, categoryId: string): Promise<any | null> {
    try {
      return (await this.client.request<any>(`/plans/${planId}/months/${monthIso}/categories/${categoryId}`)).category
    } catch (e) {
      if (e instanceof YnabApiError && e.status === 404) return null // month predates the plan
      throw e
    }
  }

  async #categoryHistoryMilli(planId: string, opts: { categoryId: string; sinceMonth: string; untilMonth: string }) {
    const months = monthRange(opts.sinceMonth, opts.untilMonth)
    const BATCH = 6
    const rows: { month: string; cat: any | null }[] = []
    for (let i = 0; i < months.length; i += BATCH) {
      const batch = months.slice(i, i + BATCH)
      const cats = await Promise.all(batch.map((m) => this.#fetchMonthCategory(planId, m, opts.categoryId)))
      batch.forEach((m, j) => rows.push({ month: m.slice(0, 7), cat: cats[j] }))
    }
    const name = rows.find((r) => r.cat)?.cat.name ?? null
    return {
      name,
      skippedMonths: rows.filter((r) => !r.cat).map((r) => r.month),
      pointsMilli: rows.filter((r) => r.cat).map((r) => ({
        month: r.month, assignedMilli: r.cat.budgeted as number, activityMilli: r.cat.activity as number, availableMilli: r.cat.balance as number,
      })).sort((a, b) => a.month.localeCompare(b.month)),
    }
  }

  async getCategoryHistory(planId: string, opts: { categoryId: string; sinceMonth: string; untilMonth: string }) {
    const h = await this.#categoryHistoryMilli(planId, opts)
    return {
      category: { id: opts.categoryId, name: h.name },
      points: h.pointsMilli.map((p) => ({ month: p.month, assigned: milliToDollars(p.assignedMilli), activity: milliToDollars(p.activityMilli), available: milliToDollars(p.availableMilli) })),
      skippedMonths: h.skippedMonths,
    }
  }

  async getCreditCardFloatHistory(planId: string, opts: { paymentCategoryId: string; cardAccountId: string; sinceMonth: string; untilMonth: string }) {
    // Throws synchronously on an invalid range before any fetch fires — Promise.all below would
    // otherwise kick off the account/transactions calls before #categoryHistoryMilli's internal
    // monthRange rejection is observed. The result is discarded; it exists only to throw early.
    monthRange(opts.sinceMonth, opts.untilMonth)
    const [h, accountData, txnsData] = await Promise.all([
      this.#categoryHistoryMilli(planId, { categoryId: opts.paymentCategoryId, sinceMonth: opts.sinceMonth, untilMonth: opts.untilMonth }),
      this.client.request<any>(`/plans/${planId}/accounts/${opts.cardAccountId}`),
      this.client.request<any>(`/plans/${planId}/accounts/${opts.cardAccountId}/transactions`, { query: { since_date: `${opts.sinceMonth}-01` } }),
    ])
    const series = floatSeries(
      h.pointsMilli.map((p) => ({ month: p.month, availableMilli: p.availableMilli })),
      txnsData.transactions,
      accountData.account.balance,
    )
    return {
      account: accountData.account.name as string,
      points: series.map((p) => ({ month: p.month, owed: milliToDollars(p.owedMilli), available: milliToDollars(p.availableMilli), gap: milliToDollars(p.gapMilli), changed: p.changed, gapChange: milliToDollars(p.gapChangeMilli), direction: p.direction })),
      skippedMonths: h.skippedMonths,
      note: 'gap = available − owed at month end. 0 = covered; negative = payment category short (float). A STATIC gap is carried history; months with changed:true are where new float appeared or was paid down.' +
        (h.pointsMilli.length === 0 ? ' WARNING: every month in the range was skipped (no data for this category) — the payment_category_id may be wrong.' : ''),
    }
  }
}
