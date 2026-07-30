import { z } from 'zod'
import type { Ynab } from '@walensis/mcp-for-ynab-core'

export interface ToolDef {
  name: string
  description: string
  write?: boolean
  schema: z.ZodRawShape
  handler: (y: Ynab, args: any) => Promise<unknown>
}

const planId = z.string().describe("Plan id from list_plans, or 'last-used'")
const month = z.string().describe("ISO month like '2026-07-01', or 'current'")
const dollars = (s: string) => z.number().describe(s + ' (decimal dollars; negative = outflow)')

export const tools: ToolDef[] = [
  // ---- overview
  { name: 'list_plans', description: 'List YNAB plans (budgets): id, name, currency, last modified.', schema: {}, handler: (y) => y.listPlans() },
  { name: 'get_plan_overview', description: 'Orient in one call: accounts with balances, current-month Ready to Assign, age of money, category-group totals. Start here.', schema: { plan_id: planId }, handler: (y, a) => y.getPlanOverview(a.plan_id) },
  { name: 'get_month', description: 'One month in full: Ready to Assign, age of money, every category (assigned/activity/available/target status).', schema: { plan_id: planId, month }, handler: (y, a) => y.getMonth(a.plan_id, a.month) },
  // ---- transactions
  { name: 'list_transactions', description: 'List or aggregate transactions with filters (account/category/payee/date/search/amount/unapproved/uncleared), pagination, field selection. aggregate mode returns per-group sums instead of rows — prefer it for spending questions. Output states the effective date window (API defaults to last 365 days).', schema: {
      plan_id: planId,
      account_id: z.string().optional(), category_id: z.string().optional(), payee_id: z.string().optional(),
      since_date: z.string().optional().describe('ISO date; omit = last 365 days'), until_date: z.string().optional(),
      unapproved_only: z.boolean().optional(), uncleared_only: z.boolean().optional(),
      search: z.string().optional().describe('case-insensitive payee/memo substring'),
      min_amount: z.number().optional(), max_amount: z.number().optional(), flag_color: z.string().optional(),
      limit: z.number().int().max(200).optional().describe('default 25'), offset: z.number().int().optional(),
      fields: z.array(z.string()).optional().describe('project only these fields (snake_case or camelCase; e.g. payee_name, category_name, transfer_account_id)'),
      aggregate: z.enum(['category', 'payee', 'month']).optional(),
      sort: z.enum(['date_desc', 'date_asc']).optional().describe('row order before pagination; default date_desc (newest first)'),
    }, handler: (y, a) => y.listTransactions(a.plan_id, { accountId: a.account_id, categoryId: a.category_id, payeeId: a.payee_id, sinceDate: a.since_date, untilDate: a.until_date, unapprovedOnly: a.unapproved_only, unclearedOnly: a.uncleared_only, search: a.search, minAmount: a.min_amount, maxAmount: a.max_amount, flagColor: a.flag_color, limit: a.limit, offset: a.offset, fields: a.fields, aggregate: a.aggregate, sort: a.sort }) },
  { name: 'get_transaction', description: 'One transaction in full, including split subtransactions.', schema: { plan_id: planId, transaction_id: z.string() }, handler: (y, a) => y.getTransaction(a.plan_id, a.transaction_id) },
  { name: 'create_transactions', description: 'Create one or more transactions (bulk). Supports splits via subtransactions (note: splits cannot be edited after creation — get them right or delete/recreate) and import_id for dedup.', write: true, schema: {
      plan_id: planId,
      transactions: z.array(z.object({
        account_id: z.string(), date: z.string(), amount: dollars('Transaction amount'),
        payee_name: z.string().optional(), payee_id: z.string().optional(), category_id: z.string().optional(),
        memo: z.string().optional(), cleared: z.enum(['cleared', 'uncleared']).optional(), approved: z.boolean().optional(),
        flag_color: z.string().optional(), import_id: z.string().optional(),
        subtransactions: z.array(z.object({ amount: dollars('Split amount'), category_id: z.string().optional(), memo: z.string().optional() })).optional(),
      })).min(1),
    }, handler: (y, a) => y.createTransactions(a.plan_id, a.transactions.map((t: any) => ({ accountId: t.account_id, date: t.date, amount: t.amount, payeeName: t.payee_name, payeeId: t.payee_id, categoryId: t.category_id, memo: t.memo, cleared: t.cleared, approved: t.approved, flagColor: t.flag_color, importId: t.import_id, subtransactions: t.subtransactions?.map((s: any) => ({ amount: s.amount, categoryId: s.category_id, memo: s.memo })) }))) },
  { name: 'update_transactions', description: 'Bulk edit transactions: categorize, approve, set cleared, edit fields. >5 rows requires confirm:true and expected_count. Undoable.', write: true, schema: {
      plan_id: planId,
      updates: z.array(z.object({ id: z.string(), date: z.string().optional(), amount: dollars('New amount').optional(), payee_id: z.string().optional(), payee_name: z.string().optional(), category_id: z.string().optional(), memo: z.string().optional(), cleared: z.enum(['cleared', 'uncleared', 'reconciled']).optional(), approved: z.boolean().optional(), flag_color: z.string().optional() })).min(1),
      confirm: z.boolean().optional(), expected_count: z.number().int().optional(),
    }, handler: (y, a) => y.updateTransactions(a.plan_id, a.updates.map((u: any) => ({ id: u.id, date: u.date, amount: u.amount, payeeId: u.payee_id, payeeName: u.payee_name, categoryId: u.category_id, memo: u.memo, cleared: u.cleared, approved: u.approved, flagColor: u.flag_color })), { confirm: a.confirm, expectedCount: a.expected_count }) },
  { name: 'delete_transaction', description: 'Delete one transaction. Requires confirm:true. Undoable (restores from journal).', write: true, schema: { plan_id: planId, transaction_id: z.string(), confirm: z.boolean().optional() }, handler: (y, a) => y.deleteTransaction(a.plan_id, a.transaction_id, { confirm: a.confirm }) },
  { name: 'import_transactions', description: 'Trigger import of linked-account transactions (same as clicking Import in YNAB).', write: true, schema: { plan_id: planId }, handler: (y, a) => y.importTransactions(a.plan_id) },
  // ---- scheduled
  { name: 'list_scheduled_transactions', description: 'All scheduled (upcoming/recurring) transactions with next date, frequency, amount.', schema: { plan_id: planId }, handler: (y, a) => y.listScheduled(a.plan_id) },
  { name: 'create_scheduled_transaction', description: 'Create a scheduled transaction (upcoming bill, recurring income).', write: true, schema: { plan_id: planId, account_id: z.string(), date: z.string().describe('first occurrence, within 5 years'), amount: dollars('Amount'), frequency: z.string().describe("e.g. 'never','monthly','weekly','yearly'"), payee_name: z.string().optional(), payee_id: z.string().optional(), category_id: z.string().optional(), memo: z.string().optional() }, handler: (y, a) => y.createScheduled(a.plan_id, { accountId: a.account_id, date: a.date, amount: a.amount, frequency: a.frequency, payeeName: a.payee_name, payeeId: a.payee_id, categoryId: a.category_id, memo: a.memo }) },
  { name: 'update_scheduled_transaction', description: 'Update a scheduled transaction (amount in dollars). Undoable.', write: true, schema: { plan_id: planId, scheduled_id: z.string(), patch: z.record(z.unknown()).describe('fields to change, snake_case per YNAB API') }, handler: (y, a) => y.updateScheduled(a.plan_id, a.scheduled_id, a.patch) },
  { name: 'delete_scheduled_transaction', description: 'Delete a scheduled transaction. Requires confirm:true. Undoable.', write: true, schema: { plan_id: planId, scheduled_id: z.string(), confirm: z.boolean().optional() }, handler: (y, a) => y.deleteScheduled(a.plan_id, a.scheduled_id, { confirm: a.confirm }) },
  // ---- structure
  { name: 'list_categories', description: 'All visible categories with balances and target status (compact).', schema: { plan_id: planId }, handler: (y, a) => y.listCategories(a.plan_id) },
  { name: 'create_category', description: 'Create a category; pass group_name to create its group too.', write: true, schema: { plan_id: planId, name: z.string(), group_id: z.string().optional(), group_name: z.string().optional() }, handler: (y, a) => y.createCategory(a.plan_id, { name: a.name, groupId: a.group_id, groupName: a.group_name }) },
  { name: 'update_category', description: 'Rename/hide a category or set its target: goal_target (dollars), goal_target_date, goal_frequency (monthly|weekly|yearly), goal_needs_whole_amount. Undoable.', write: true, schema: { plan_id: planId, category_id: z.string(), name: z.string().optional(), hidden: z.boolean().optional(), goal_target: z.number().nullable().optional(), goal_target_date: z.string().nullable().optional(), goal_frequency: z.enum(['monthly', 'weekly', 'yearly']).nullable().optional(), goal_needs_whole_amount: z.boolean().nullable().optional() }, handler: (y, a) => y.updateCategory(a.plan_id, a.category_id, { name: a.name, hidden: a.hidden, goalTarget: a.goal_target, goalTargetDate: a.goal_target_date, goalFrequency: a.goal_frequency, goalNeedsWholeAmount: a.goal_needs_whole_amount }) },
  { name: 'assign_budget', description: "Set a category's assigned amount for a month. Undoable.", write: true, schema: { plan_id: planId, month, category_id: z.string(), amount: dollars('New assigned amount'), reason: z.string().optional().describe('why this assignment is being made — recorded in the local audit journal and echoed back (YNAB has no memo on assignments; this never reaches YNAB)') }, handler: (y, a) => y.assignBudget(a.plan_id, a.month, a.category_id, a.amount, a.reason) },
  { name: 'move_money', description: 'Move assigned money between two categories in a month (atomic: rolls back if the second half fails). Undoable.', write: true, schema: { plan_id: planId, month, from_category_id: z.string(), to_category_id: z.string(), amount: dollars('Amount to move (positive)'), reason: z.string().optional().describe('why this move is being made — recorded in the local audit journal and echoed back (YNAB has no memo on assignments; this never reaches YNAB)') }, handler: (y, a) => y.moveMoney(a.plan_id, a.month, a.from_category_id, a.to_category_id, a.amount, a.reason) },
  // ---- payees & accounts
  { name: 'list_payees', description: 'All payees (id, name, transfer flag).', schema: { plan_id: planId }, handler: (y, a) => y.listPayees(a.plan_id) },
  { name: 'rename_payee', description: 'Rename a payee (applies to all its transactions). Undoable.', write: true, schema: { plan_id: planId, payee_id: z.string(), name: z.string() }, handler: (y, a) => y.renamePayee(a.plan_id, a.payee_id, a.name) },
  { name: 'create_payee', description: 'Create a payee.', write: true, schema: { plan_id: planId, name: z.string() }, handler: (y, a) => y.createPayee(a.plan_id, a.name) },
  { name: 'create_account', description: 'Create an account (checking, savings, cash, creditCard, otherAsset, otherLiability) with a starting balance.', write: true, schema: { plan_id: planId, name: z.string(), type: z.enum(['checking', 'savings', 'cash', 'creditCard', 'otherAsset', 'otherLiability']), balance: dollars('Starting balance') }, handler: (y, a) => y.createAccount(a.plan_id, { name: a.name, type: a.type, balance: a.balance }) },
  // ---- analytics
  { name: 'spending_summary', description: 'Server-computed spending by category or payee for a window (default last 30 days), optional previous-period comparison with % change. Small output — prefer this over listing rows.', schema: { plan_id: planId, by: z.enum(['category', 'payee']).optional(), since_date: z.string().optional(), until_date: z.string().optional(), compare_to_previous: z.boolean().optional() }, handler: (y, a) => y.getSpendingSummary(a.plan_id, { by: a.by, sinceDate: a.since_date, untilDate: a.until_date, compareToPrevious: a.compare_to_previous }) },
  { name: 'budget_health', description: 'Current-month health check: Ready to Assign, overspent categories, underfunded targets, credit-card payment coverage (float detection).', schema: { plan_id: planId }, handler: (y, a) => y.getBudgetHealth(a.plan_id) },
  { name: 'detect_recurring_charges', description: 'Find recurring charges (subscriptions/bills) from ~13 months of history: cadence, last amount, whether the amount changed.', schema: { plan_id: planId }, handler: (y, a) => y.getRecurringCharges(a.plan_id) },
  { name: 'income_vs_expense', description: 'Monthly income/expense/net series (default 6 months); current month flagged partial.', schema: { plan_id: planId, months: z.number().int().max(24).optional() }, handler: (y, a) => y.getIncomeVsExpense(a.plan_id, { months: a.months }) },
  { name: 'net_worth_history', description: 'Monthly net-worth series computed from full transaction history across all accounts.', schema: { plan_id: planId }, handler: (y, a) => y.getNetWorthHistory(a.plan_id) },
  { name: 'month_close', description: 'READ-ONLY month-close report for a cutoff date (normally the closing month\'s last day): per-credit-card coverage (working & cleared as-of balances vs payment-category available at month end; gap 0 = covered), blockers (unapproved / uncategorized / uncleared before cutoff), overspent (red) categories, and ranked donor categories. Proposes nothing and moves nothing — pair with propose_coverage, then apply approved moves via move_money / assign_budget. gapStatus is \'provisional\' until every blocker is resolved: never present a provisional gap as the final number — resolve uncategorized/unapproved blockers via update_transactions and re-run. unclearedBeforeCutoff rows are bank-pending and cannot be forced: if only those remain, present the gap as provisional with that caveat.', schema: { plan_id: planId, cutoff: z.string().describe("ISO date cutoff, e.g. '2026-07-31'"), lookback_days: z.number().int().min(1).max(365).optional().describe('straggler scan window, default 120') }, handler: (y, a) => y.monthClose(a.plan_id, { cutoff: a.cutoff, lookbackDays: a.lookback_days }) },
  { name: 'propose_coverage', description: 'READ-ONLY: ordered move proposals to bring every overspent category to zero for the cutoff month — donors first (max 3 donor slices per category) then Ready to Assign, RTA moves tagged source:"rta", anything uncoverable listed in unfundable. Applies nothing: review with the user, then execute approved moves in the returned month via move_money (category→category; moves the delta directly). CAUTION for RTA draws: assign_budget sets the ABSOLUTE assigned amount — first read the category\'s current assigned via get_month, then pass current + move amount; never pass the move amount alone.', schema: { plan_id: planId, cutoff: z.string().describe('same cutoff passed to month_close'), strategy: z.enum(['donors_first', 'rta_only']).optional() }, handler: (y, a) => y.proposeCoverage(a.plan_id, { cutoff: a.cutoff, strategy: a.strategy }) },
  { name: 'get_category_history', description: "READ-ONLY: one category's monthly series (assigned / activity / available) across a month range in a single compact response — use for any single-category trend instead of paging get_month (which returns every category). Months the plan doesn't cover are skipped and listed in skippedMonths. Cost: one API call per month in the range (max 60).", schema: { plan_id: planId, category_id: z.string(), since_month: z.string().describe("first month, 'YYYY-MM'"), until_month: z.string().describe("last month inclusive, 'YYYY-MM'") }, handler: (y, a) => y.getCategoryHistory(a.plan_id, { categoryId: a.category_id, sinceMonth: a.since_month, untilMonth: a.until_month }) },
  { name: 'credit_card_float_history', description: "READ-ONLY: per-month credit-card float analysis over a range — the card's owed balance at each month end (backed out of the current balance) vs its payment category's available, the gap, and changed:true on months where the gap moved (new float appeared or was paid down; a static gap is just carried history). Pass the payment CATEGORY id and the card ACCOUNT id. For a single cutoff with blockers and donor proposals use month_close instead. Cost: ~one API call per month plus two. Each point carries gapChange and direction ('grew' = float increased).", schema: { plan_id: planId, payment_category_id: z.string().describe('the Credit Card Payments category id'), card_account_id: z.string().describe('the credit card account id'), since_month: z.string().describe("'YYYY-MM'"), until_month: z.string().describe("'YYYY-MM' inclusive") }, handler: (y, a) => y.getCreditCardFloatHistory(a.plan_id, { paymentCategoryId: a.payment_category_id, cardAccountId: a.card_account_id, sinceMonth: a.since_month, untilMonth: a.until_month }) },
  // ---- system
  { name: 'undo_last', description: 'Undo the most recent write made through this server (create/update/delete/assign/rename). One level at a time, up to 50 entries back.', write: true, schema: {}, handler: (y) => y.undoLast() },
  // ---- ledger (local file only — never touches YNAB)
  { name: 'record_month_close', description: 'Writes a LOCAL file only (~/.mcp-for-ynab/ledger.json) — never touches YNAB. Persist the balance-forward line at the end of a month-close session: per-card gaps, blocker counts, attributed causes, applied moves with reasons.', schema: {
      plan_id: planId, cutoff: z.string().describe("ISO date cutoff, e.g. '2026-07-31'"), gap_status: z.enum(['provisional', 'final']),
      per_card: z.array(z.object({ account: z.string(), working_as_of: z.number(), cleared_as_of: z.number(), available_at_month_end: z.number(), gap: z.number() })).min(1),
      blockers: z.object({ unapproved: z.number().int(), uncategorized: z.number().int(), uncleared_before_cutoff: z.number().int() }),
      causes: z.array(z.object({ month: z.string(), change: z.number(), cause: z.string(), narrative: z.string().optional() })).optional(),
      moves: z.array(z.object({ from: z.string(), to: z.string(), amount: z.number(), source: z.enum(['category', 'rta']), reason: z.string().optional() })).optional(),
      buffer: z.number().optional(), note: z.string().optional(),
    }, handler: async (y, a) => y.recordMonthClose({
      planId: a.plan_id, cutoff: a.cutoff, gapStatus: a.gap_status,
      perCard: a.per_card.map((c: any) => ({ account: c.account, workingAsOf: c.working_as_of, clearedAsOf: c.cleared_as_of, availableAtMonthEnd: c.available_at_month_end, gap: c.gap })),
      blockers: { unapproved: a.blockers.unapproved, uncategorized: a.blockers.uncategorized, unclearedBeforeCutoff: a.blockers.uncleared_before_cutoff },
      causes: a.causes,
      moves: a.moves?.map((m: any) => ({ from: m.from, to: m.to, amount: m.amount, source: m.source, reason: m.reason })),
      buffer: a.buffer, note: a.note,
    }) },
  { name: 'get_month_close_ledger', description: 'Read past balance-forward records (newest first) — compare this close against the last one; optional cutoff filter.', schema: { limit: z.number().int().max(50).optional(), cutoff: z.string().optional() }, handler: async (y, a) => y.getMonthCloseLedger({ limit: a.limit, cutoff: a.cutoff }) },
]
