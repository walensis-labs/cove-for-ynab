import { YnabClient, YnabApiError, DeltaCache } from '@walensis/ynab-client'
import { UndoJournal, type InverseOp } from './undo-journal.js'
import { type LedgerLike, type MonthCloseRecord } from './ledger.js'
import { milliToDollars, dollarsToMilli, formatDollars, type CurrencyFormatOpts } from './money.js'
import { applyFilters, aggregateTxns, TXN_FIELD_ALIASES, type TxnFilters } from './filters.js'
import { spendingSummary, budgetHealth, detectRecurring, incomeVsExpense, netWorthHistory, monthWindowStart } from './analytics.js'
import { asOfBalances, findBlockers, matchCards, findRedCategories, rankDonors, proposeMoves, type RawTxn, type RawAccount, type RawMonthCat } from './month-close.js'
import { monthRange, floatSeries } from './category-history.js'
import { attributeChanges, type AttributionComponent, type GapCause } from './attribution.js'
import type { CategorySnapshot, ScheduledSnapshot, Txn } from './types.js'

const d = milliToDollars
const BLOCKER_CAP = 50
// Money-valued keys on Txn that carry a `${key}Text` companion — used by listTransactions' `fields`
// projection (MINOR 4) to attach the companion even when the caller didn't explicitly ask for it.
const MONEY_TXN_FIELDS = new Set<keyof Txn>(['amount'])
// Truthful Tool Output, Task 3(b): fields present on the full Txn shape but excluded from
// listTransactions' DEFAULT (no explicit `fields`) projection. importId passes YNAB's raw
// milliunit-embedded import key straight through (`YNAB:-1000000:2026-08-06:1`) — sitting a bare
// milliunit figure beside the correctly-converted `amount` is exactly what triggered the recompute
// spiral pinned in the mapTxn amountText tests above. It answers no user question by default and stays
// reachable via explicit `fields` selection (the `fields` branch below never consults this set).
const DEFAULT_OMIT_TXN_FIELDS = new Set<keyof Txn>(['importId'])

function toEvidenceComponent(c: AttributionComponent, fmt: CurrencyFormatOpts) {
  const { cause, amountMilli, evidence } = c
  const amount = milliToDollars(amountMilli)
  const assigned = evidence.assignedMilli !== undefined ? milliToDollars(evidence.assignedMilli) : undefined
  const priorRed = evidence.priorRedMilli !== undefined ? milliToDollars(evidence.priorRedMilli) : undefined
  const residual = evidence.residualMilli !== undefined ? milliToDollars(evidence.residualMilli) : undefined
  return {
    cause,
    amount, amountText: formatDollars(amount, fmt),
    ...(assigned !== undefined ? { assigned, assignedText: formatDollars(assigned, fmt) } : {}),
    ...(priorRed !== undefined ? { priorRed, priorRedText: formatDollars(priorRed, fmt) } : {}),
    ...(residual !== undefined ? { residual, residualText: formatDollars(residual, fmt) } : {}),
    ...(evidence.txns !== undefined ? { txns: evidence.txns.map((t) => {
      const txnAmount = milliToDollars(t.amountMilli)
      return { id: t.id, date: t.date, amount: txnAmount, amountText: formatDollars(txnAmount, fmt) }
    }) } : {}),
  }
}

export class WriteDisabledError extends Error {
  constructor(hint?: string) {
    super('Writes are disabled on this server.' + (hint ? ` ${hint}` : ''))
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
/** Earlier than any real YNAB transaction — used where we need "all history, no date window" from an
 * endpoint that (per YNAB API changelog v1.85.0) defaults `since_date` to one year ago when omitted. */
const FAR_PAST_SINCE_DATE = '2000-01-01'
function currentMonthUTC(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}
/** Real last day of a 'YYYY-MM' month as an ISO date. */
function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
/**
 * The last fully-elapsed calendar month (UTC) as of `todayIso`, as 'YYYY-MM'. Pure and unit-testable
 * on its own — backfillLedger uses it (against the real clock) to keep from writing a 'final' ledger
 * record for a month that hasn't finished yet.
 */
export function lastCompleteMonth(todayIso: string): string {
  const d = new Date(todayIso)
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface NewTxn {
  accountId: string; date: string; amount: number
  payeeName?: string; payeeId?: string; categoryId?: string; memo?: string
  cleared?: 'cleared' | 'uncleared' | 'reconciled'; approved?: boolean; flagColor?: string; importId?: string
  subtransactions?: { amount: number; categoryId?: string; memo?: string }[]
}

// `fmt` is a required param (mapCategory is internal-only, never exported) — forcing every call
// site to pass the plan's resolved currency format explicitly, so a forgotten arg fails to compile
// instead of silently reintroducing the hardcoded-"$" bug this function used to have.
function mapCategory(c: any, fmt: CurrencyFormatOpts): CategorySnapshot {
  const assigned = d(c.budgeted)
  const activity = d(c.activity)
  const available = d(c.balance)
  const goalTarget = c.goal_type ? d(c.goal_target ?? 0) : null
  const goalUnderFunded = c.goal_under_funded == null ? null : d(c.goal_under_funded)
  return {
    id: c.id, name: c.name, group: c.category_group_name ?? '', hidden: !!c.hidden,
    assigned, assignedText: formatDollars(assigned, fmt),
    activity, activityText: formatDollars(activity, fmt),
    available, availableText: formatDollars(available, fmt),
    goalType: c.goal_type ?? null,
    goalTarget, goalTargetText: goalTarget === null ? null : formatDollars(goalTarget, fmt),
    goalUnderFunded, goalUnderFundedText: goalUnderFunded === null ? null : formatDollars(goalUnderFunded, fmt),
    goalPercentageComplete: c.goal_percentage_complete ?? null,
  }
}

// IMPORTANT 5 (currency-symbol review): `symbol` has NO default — mapTxn is exported (part of
// @walensis/cove-core's public surface) and used to default to '$', which meant a caller with no
// currency context got a confident, unverified "$" baked into amountText. `symbol: string | undefined`
// forces every call site (including external consumers) to make an explicit choice; passing `undefined`
// renders symbol-less (via formatDollars, given an explicit `symbol: undefined` below — never the
// bare-call default) rather than silently asserting dollars. `fmt` is an additive, optional third
// param (IMPORTANT 6) carrying the rest of the plan's currency format (decimals, separators,
// symbol position) for callers that have it — every internal Ynab call site below passes both.
export function mapTxn(t: any, symbol: string | undefined, fmt?: CurrencyFormatOpts): Txn {
  const amount = d(t.amount)
  // An explicit `undefined` (the caller has no verified symbol) must render symbol-less, not fall
  // through to formatDollars' own "$" default — `?? ''` is the same neutral-fallback idiom every
  // internal Ynab method below uses via #resolveCurrency.
  const f: CurrencyFormatOpts = { ...fmt, symbol: symbol ?? '' }
  return {
    id: t.id, date: t.date, amount, amountText: formatDollars(amount, f),
    payeeName: t.payee_name ?? null, payeeId: t.payee_id ?? null,
    categoryName: t.category_name ?? null, categoryId: t.category_id ?? null,
    accountName: t.account_name ?? '', accountId: t.account_id,
    memo: t.memo ?? null, cleared: t.cleared, approved: !!t.approved,
    flagColor: t.flag_color ?? null, transferAccountId: t.transfer_account_id ?? null,
    importId: t.import_id ?? null,
    ...(t.subtransactions?.length
      ? { subtransactions: t.subtransactions.filter((s: any) => !s.deleted).map((s: any) => {
          const subAmount = d(s.amount)
          return { amount: subAmount, amountText: formatDollars(subAmount, f), categoryName: s.category_name ?? null, memo: s.memo ?? null }
        }) }
      : {}),
  }
}

// Maps the camelCase keys accepted by updateTransactions to the snake_case keys the YNAB API expects,
// used to build undo inverses in API wire form (see updateTransactions).
const TXN_UPDATE_API_KEY: Record<string, string> = {
  date: 'date', amount: 'amount', payeeId: 'payee_id', payeeName: 'payee_name',
  categoryId: 'category_id', memo: 'memo', cleared: 'cleared', approved: 'approved', flagColor: 'flag_color',
}

const NOT_REVERSIBLE = "This can't be reversed — the YNAB API has no way to delete"

/**
 * Human-readable "what changed, reverted" clauses for a single transaction update, built from the
 * PRIOR (pre-write) Txn snapshot — this is what proves updateTransactions' inverse describes the
 * old values, not the ones just written. Only fields actually present in `update` are described;
 * a field the caller never touched has no "back to X" clause.
 */
function txnRevertClauses(prior: Txn, update: Record<string, unknown>, fmt: CurrencyFormatOpts): string[] {
  const clauses: string[] = []
  if (update.categoryId !== undefined) clauses.push(`category back to ${prior.categoryName ?? '(uncategorized)'}`)
  if (update.payeeId !== undefined || update.payeeName !== undefined) clauses.push(`payee back to ${prior.payeeName ?? '(no payee)'}`)
  if (update.amount !== undefined) clauses.push(`amount back to ${formatDollars(prior.amount, fmt)}`)
  if (update.memo !== undefined) clauses.push(`memo back to ${prior.memo ? JSON.stringify(prior.memo) : '(empty)'}`)
  if (update.cleared !== undefined) clauses.push(`cleared status back to ${prior.cleared}`)
  if (update.approved !== undefined) clauses.push(`approved back to ${prior.approved}`)
  if (update.flagColor !== undefined) clauses.push(`flag color back to ${prior.flagColor ?? '(none)'}`)
  if (update.date !== undefined) clauses.push(`date back to ${prior.date}`)
  return clauses
}

const CATEGORY_FIELD_LABEL: Record<string, string> = {
  name: 'name', hidden: 'hidden', goal_target: 'goal target',
  goal_target_date: 'goal target date', goal_frequency: 'goal frequency', goal_needs_whole_amount: 'goal needs whole amount',
}

/**
 * IMPORTANT 3 (truthful-output review): fills in the *Text companions on a MonthCloseRecord before it
 * reaches the ledger's 'close' path. backfillLedger already builds its records with companions inline;
 * recordMonthClose didn't, so get_month_close_ledger could return a response mixing labeled backfill
 * rows with bare-number close rows in the same list — arguably worse than uniformly unlabeled. Only
 * fills a field that's missing (undefined) so a caller-supplied Text value is never overwritten, and
 * every field stays optional per MonthCloseRecord's additive-only contract (pre-existing D1 rows without
 * these fields must still deserialize).
 */
function withMoneyText(record: Omit<MonthCloseRecord, 'id' | 'recordedAt'>, fmt: CurrencyFormatOpts): Omit<MonthCloseRecord, 'id' | 'recordedAt'> {
  return {
    ...record,
    perCard: record.perCard.map((c) => ({
      ...c,
      workingAsOfText: c.workingAsOfText ?? formatDollars(c.workingAsOf, fmt),
      clearedAsOfText: c.clearedAsOfText ?? formatDollars(c.clearedAsOf, fmt),
      availableAtMonthEndText: c.availableAtMonthEndText ?? formatDollars(c.availableAtMonthEnd, fmt),
      gapText: c.gapText ?? formatDollars(c.gap, fmt),
    })),
    ...(record.causes ? { causes: record.causes.map((c) => ({ ...c, changeText: c.changeText ?? formatDollars(c.change, fmt) })) } : {}),
    ...(record.moves ? { moves: record.moves.map((m) => ({ ...m, amountText: m.amountText ?? formatDollars(m.amount, fmt) })) } : {}),
    ...(record.buffer !== undefined ? { bufferText: record.bufferText ?? formatDollars(record.buffer, fmt) } : {}),
  }
}

/** Plain-language "field back to prior value" clauses for updateCategory's inverse, keyed off the
 * API-wire `body` that was just sent (so only fields the caller actually changed are described). */
function categoryInverseClauses(body: Record<string, unknown>, prior: any, fmt: CurrencyFormatOpts): string {
  const keys = Object.keys(body)
  if (keys.length === 0) return 'nothing — no fields differed from their prior values'
  return keys.map((k) => {
    const label = CATEGORY_FIELD_LABEL[k] ?? k
    const priorVal = prior[k] ?? null
    const display = k === 'goal_target' ? (priorVal == null ? 'none' : formatDollars(milliToDollars(priorVal as number), fmt)) : priorVal == null ? '(none)' : String(priorVal)
    return `${label} back to ${display}`
  }).join(', ')
}

export class Ynab {
  readonly client: YnabClient
  readonly cache?: DeltaCache
  readonly journal?: UndoJournal
  readonly allowWrites: boolean
  readonly ledger?: LedgerLike
  readonly writeDisabledHint?: string
  readonly #currencySymbolOverride?: string | CurrencyFormatOpts | ((planId: string) => Promise<string | CurrencyFormatOpts | undefined>)

  constructor(opts: {
    client: YnabClient; cache?: DeltaCache; journal?: UndoJournal; allowWrites: boolean; ledger?: LedgerLike; writeDisabledHint?: string
    /**
     * Injectable seam (currency-symbol review MINOR, widened in review round 3): lets a host supply the
     * plan's currency FORMAT without a per-request `GET /plans/{plan_id}/settings` round-trip — a fixed
     * string (bare symbol, US formatting defaults) or a full `CurrencyFormatOpts` for a single-currency
     * deployment, or a function (typically backed by a cross-request cache the host owns, e.g. KV/D1 in
     * the Workers deployments) returning either shape, or `undefined` to fall back to the live lookup
     * below. Widened from string-only: a string-only seam couldn't express symbol placement or
     * separators, so a host caching a SEK plan's symbol alone reintroduced the exact prefix/US-separator
     * misformatting (`kr1,500.00`) IMPORTANT 6 fixed for the live path — a string is still accepted (and
     * still means "just the symbol, default US formatting") for backward compatibility. Core has no
     * persistence primitive of its own; this is the seam that lets a host add one without core reaching
     * for storage it doesn't have.
     */
    currencySymbol?: string | CurrencyFormatOpts | ((planId: string) => Promise<string | CurrencyFormatOpts | undefined>)
  }) {
    this.client = opts.client; this.cache = opts.cache; this.journal = opts.journal; this.allowWrites = opts.allowWrites; this.ledger = opts.ledger
    this.writeDisabledHint = opts.writeDisabledHint
    this.#currencySymbolOverride = opts.currencySymbol
  }

  assertWrites(): void { if (!this.allowWrites) throw new WriteDisabledError(this.writeDisabledHint) }

  /**
   * CRITICAL 1 fix (currency-symbol review): resolves planId's full currency FORMAT via
   * `GET /plans/{plan_id}/settings`, verified straight from YNAB's `currency_format` — this NEVER
   * defaults `symbol` to "$". Unlike `/plans`, this endpoint accepts YNAB's path-param aliases
   * ('last-used', 'default') — see apps/mcp/src/tools.ts's `plan_id` schema, which advertises exactly
   * that alias. Resolving via `/plans` (a `find(p => p.id === planId)` over a LIST) can never match an
   * alias, since YNAB never returns an alias as a plan's `id` — every alias call silently resolved to
   * no symbol. `/plans/{plan_id}/settings` takes the id (or alias) straight into the path and lets YNAB
   * do the resolution; same one-call cost, and it hands back decimal_digits/symbol_first/separators/
   * display_symbol too (IMPORTANT 6), not just the symbol.
   *
   * Memoized per planId for the lifetime of this Ynab instance (Workers deployments construct one Ynab
   * PER REQUEST, so this does not survive across requests — it only collapses the N formatted-money call
   * sites within a single request down to at most one extra fetch). A REJECTED fetch is deliberately NOT
   * left cached as a rejection (see `safe` below): a transient failure must not degrade every subsequent
   * *Text in this instance's remaining lifetime with no retry — the next call retries instead. Any
   * failure — plan not found, offline, malformed response — resolves to `{ symbol: '' }` rather than
   * throwing, so a symbol-lookup problem degrades to currency-neutral output instead of failing the
   * whole operation.
   *
   * IMPORTANT 1 fix (currency-symbol review round 3): the cache stores `safe`, an ALREADY-CAUGHT promise
   * that can never reject — not the raw fetch promise. The prior round's fix (delete-on-reject via
   * `promise.catch(() => cache.delete(...))` fired as a side effect, while the cached value was still
   * the raw, rejecting `promise`) only degraded gracefully for the ONE call that happened to `await` it
   * inside this method's own try/catch; every concurrent cache HIT (`if (cached) return cached`) handed
   * the caller that same raw promise with no try/catch around it, so a second method resolving currency
   * for the same plan in the same tick (getPlanOverview, getBudgetHealth, and every method that pairs a
   * direct #resolveCurrency call with #allTxns/getMonth — both resolve internally — inside one
   * Promise.all) got a propagated rejection instead of degraded output. Deleting the cache entry inside
   * the SAME `.catch` that produces `safe`'s fallback value keeps the retry-on-next-call property: the
   * entry is gone by the time any caller observes `safe`'s resolution, so the next #resolveCurrency call
   * misses the cache and fetches fresh.
   */
  #currencyCache = new Map<string, Promise<CurrencyFormatOpts>>()
  async #resolveCurrency(planId: string): Promise<CurrencyFormatOpts> {
    const cached = this.#currencyCache.get(planId)
    if (cached) return cached
    const raw = (async (): Promise<CurrencyFormatOpts> => {
      if (typeof this.#currencySymbolOverride === 'function') {
        const sym = await this.#currencySymbolOverride(planId)
        if (sym !== undefined) return typeof sym === 'string' ? { symbol: sym } : sym
      } else if (this.#currencySymbolOverride !== undefined) {
        return typeof this.#currencySymbolOverride === 'string' ? { symbol: this.#currencySymbolOverride } : this.#currencySymbolOverride
      }
      const data = await this.client.request<any>(`/plans/${planId}/settings`)
      const cf = data?.settings?.currency_format
      return {
        symbol: cf?.currency_symbol ?? '',
        decimals: cf?.decimal_digits,
        symbolFirst: cf?.symbol_first,
        decimalSeparator: cf?.decimal_separator,
        groupSeparator: cf?.group_separator,
        displaySymbol: cf?.display_symbol,
        isoCode: cf?.iso_code,
      }
    })()
    const safe = raw.catch((): CurrencyFormatOpts => { this.#currencyCache.delete(planId); return { symbol: '' } })
    this.#currencyCache.set(planId, safe)
    return safe
  }

  // IMPORTANT 4 fix (currency-symbol review): NOT memoized. listPlans() used to share a cache with the
  // symbol lookup (both went through /plans) so the cache lived for the whole process lifetime in the
  // stdio deployment — a snapshot frozen at first call, where lastModified never updated and a newly
  // created budget never appeared. Now that symbol resolution has its own endpoint (#resolveCurrency,
  // above), listPlans() has no reason to be cached at all: it fetches fresh every call, as any other
  // read here does.
  async listPlans() {
    const data = await this.client.request<any>('/plans')
    // These report null rather than defaulting to USD/"$". The earlier defence — that list_plans is
    // "informational" and doesn't launder a false "$" into any *Text field — was true about other
    // tools and beside the point about this one: the model reads list_plans directly, so telling it a
    // SEK budget's currency is "USD" is a false statement at the source. Same defect class the *Text
    // work exists to close; unresolved must read as unresolved everywhere.
    return data.plans.map((p: any) => ({
      id: p.id,
      name: p.name,
      currency: p.currency_format?.iso_code ?? null,
      currencySymbol: p.currency_format?.currency_symbol ?? null,
      lastModified: p.last_modified_on,
    }))
  }

  async getMonth(planId: string, month: string) {
    const [data, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/months/${month}`),
      this.#resolveCurrency(planId),
    ])
    const m = data.month
    const readyToAssign = d(m.to_be_budgeted)
    return {
      month: m.month, readyToAssign, readyToAssignText: formatDollars(readyToAssign, fmt), ageOfMoney: m.age_of_money ?? null,
      categories: m.categories.filter((c: any) => !c.deleted).map((c: any) => mapCategory(c, fmt)),
    }
  }

  async listCategories(planId: string): Promise<CategorySnapshot[]> {
    const [data, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/categories`),
      this.#resolveCurrency(planId),
    ])
    return data.category_groups
      .filter((g: any) => !g.deleted && !g.hidden)
      .flatMap((g: any) => g.categories.filter((c: any) => !c.deleted).map((c: any) => mapCategory({ ...c, category_group_name: g.name }, fmt)))
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
    const [data, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/scheduled_transactions`),
      this.#resolveCurrency(planId),
    ])
    return data.scheduled_transactions.filter((s: any) => !s.deleted).map((s: any) => {
      const amount = d(s.amount)
      return {
        id: s.id, dateNext: s.date_next, frequency: s.frequency, amount, amountText: formatDollars(amount, fmt),
        payeeName: s.payee_name ?? null, categoryName: s.category_name ?? null, memo: s.memo ?? null,
      }
    })
  }

  async getPlanOverview(planId: string) {
    // Fix report (fix/currency-symbol, cache-seeding regression): this used to await /plans alone
    // first and seed #resolveCurrency's cache straight from its currency_format entry for a matched
    // REAL plan id, to save the one extra /settings round-trip #resolveCurrency would otherwise make.
    // Removed. Per this repo's own generated types (generated/api.d.ts: CurrencyFormat is `{...} |
    // null`, and PlanSummary.currency_format is OPTIONAL), a real plan's /plans entry can legitimately
    // have currency_format null or absent — independent of whether /plans/{id}/settings would resolve
    // it. The seeding guard only checked `if (rawPlan && ...)`, never whether currency_format was
    // actually populated, so that case seeded a fully-degraded `{ symbol: '' }` and PERMANENTLY cached
    // it for this instance's lifetime — the live /settings fetch that would have resolved it correctly
    // was never attempted. That's the same defect class this whole review chain has been closing (a
    // resolvable currency rendering as unresolved), just moved from alias ids to real ids. A truthiness
    // guard on currency_format would fix the correctness bug but reintroduces the sequencing problem
    // below (the seed has to win a race against getMonth's internal #resolveCurrency call, which
    // requires awaiting /plans alone first — see next paragraph). Given the seeding only ever saved one
    // request out of roughly forty in a realistic session, and it has now cost both a correctness
    // regression and this method's parallelism on its first outing, it's not worth keeping under either
    // guard. #resolveCurrency now does its normal live /settings fetch on every path, alias or not —
    // deduped per instance as always (see #resolveCurrency's docstring), so a real plan id still costs
    // only one extra request beyond the unavoidable three (/plans, /accounts, /months/current), same as
    // an alias id.
    //
    // Restoring the seeding also removes the reason /plans had to be awaited on its own before the rest:
    // the seed needed to land in the cache before getMonth's internal #resolveCurrency call raced it, so
    // the round-3 rewrite split this into `await /plans` then a second `Promise.all` for
    // accounts/month/fmt — an extra full YNAB round-trip of latency on the "Start here" tool. With no
    // data dependency between them, all four fire concurrently again, as they did before that rewrite.
    const [plansData, accountsData, month, fmt] = await Promise.all([
      this.client.request<any>('/plans'),
      this.client.request<any>(`/plans/${planId}/accounts`),
      this.getMonth(planId, 'current'),
      this.#resolveCurrency(planId),
    ])
    // fetches the raw /plans payload directly (not via listPlans(), whose mapped shape drops
    // currency_format) so the matched plan's own currency_format is available for the ISO-code
    // fallback below.
    const rawPlan = (plansData.plans as any[]).find((p) => p.id === planId)
    // IMPORTANT 2 fix (currency-symbol review round 3): plan metadata used to fall back to a fabricated
    // `{ name: '(current plan)', currency: 'USD' }` whenever `find` missed — which, for `currency`, is
    // EVERY alias call (`rawPlan` above can never match one), leaving a confident, unverified "USD" as
    // the model's only currency signal in the tool whose own description says "Start here". `currency`
    // now comes from `fmt.isoCode` — the plan's real, VERIFIED ISO code, resolved via #resolveCurrency
    // (which DOES understand aliases, via /settings) — falling back to `null`, never a guessed code,
    // when even that can't be resolved. `name` keeps its pre-existing '(current plan)' placeholder,
    // which was never a truthfulness problem (no alternate real name is being suppressed by it).
    const plan = { id: rawPlan?.id ?? planId, name: rawPlan?.name ?? '(current plan)', currency: fmt.isoCode ?? null }
    // NOTE 7 (truthful-output review, closed out): every *Text this method emits uses the plan's real,
    // VERIFIED currency format — resolved via #resolveCurrency, never via listPlans()'s `currencySymbol`
    // field (which still defaults to "$" for its own unrelated public contract, see #resolveCurrency's
    // docstring). A EUR budget must not get a confident, wrong "$" in a field we're telling the model
    // to quote verbatim; an unresolvable symbol renders currency-neutral (no symbol) instead.
    const accounts = accountsData.accounts.filter((a: any) => !a.deleted && !a.closed).map((a: any) => {
      const balance = d(a.balance), cleared = d(a.cleared_balance), uncleared = d(a.uncleared_balance)
      return {
        id: a.id, name: a.name, type: a.type, onBudget: !!a.on_budget,
        balance, balanceText: formatDollars(balance, fmt),
        cleared, clearedText: formatDollars(cleared, fmt),
        uncleared, unclearedText: formatDollars(uncleared, fmt),
        lastReconciledAt: a.last_reconciled_at ?? null,
      }
    })
    const groups = new Map<string, { assigned: number; activity: number; available: number }>()
    for (const c of month.categories) {
      const g = groups.get(c.group) ?? { assigned: 0, activity: 0, available: 0 }
      g.assigned += c.assigned; g.activity += c.activity; g.available += c.available
      groups.set(c.group, g)
    }
    const budgeted = month.categories.reduce((s: number, c: CategorySnapshot) => s + c.assigned, 0)
    const activity = month.categories.reduce((s: number, c: CategorySnapshot) => s + c.activity, 0)
    const roundedActivity = Math.round(activity * 100) / 100
    const roundedBudgeted = Math.round(budgeted * 100) / 100
    return {
      plan,
      month: {
        month: month.month, readyToAssign: month.readyToAssign, readyToAssignText: formatDollars(month.readyToAssign, fmt),
        ageOfMoney: month.ageOfMoney, activity: roundedActivity, activityText: formatDollars(roundedActivity, fmt),
        budgeted: roundedBudgeted, budgetedText: formatDollars(roundedBudgeted, fmt),
      },
      accounts,
      categoryGroups: [...groups.entries()].map(([name, v]) => {
        const assigned = Math.round(v.assigned * 100) / 100
        const groupActivity = Math.round(v.activity * 100) / 100
        const available = Math.round(v.available * 100) / 100
        return { name, assigned, assignedText: formatDollars(assigned, fmt), activity: groupActivity, activityText: formatDollars(groupActivity, fmt), available, availableText: formatDollars(available, fmt) }
      }),
    }
  }

  async listTransactions(planId: string, opts: TxnFilters & { limit?: number; offset?: number; fields?: (keyof Txn)[]; aggregate?: 'category' | 'payee' | 'month'; sort?: 'date_desc' | 'date_asc' } = {}) {
    const sinceDate = opts.sinceDate ?? defaultSince()
    const explicit = opts.sinceDate !== undefined
    const sub = [opts.accountId && `accounts/${opts.accountId}`, opts.categoryId && `categories/${opts.categoryId}`, opts.payeeId && `payees/${opts.payeeId}`].filter(Boolean)
    const path = sub.length === 1 ? `/plans/${planId}/${sub[0]}/transactions` : `/plans/${planId}/transactions`
    const [data, fmt] = await Promise.all([
      this.client.request<any>(path, { query: { since_date: sinceDate, until_date: opts.untilDate, type: opts.unapprovedOnly ? 'unapproved' : opts.unclearedOnly ? 'uncleared' : undefined } }),
      this.#resolveCurrency(planId),
    ])
    const all = applyFilters(data.transactions.filter((t: any) => !t.deleted).map((t: any) => mapTxn(t, fmt.symbol, fmt)), { ...opts, sinceDate, ...(sub.length === 1 ? { accountId: undefined, categoryId: undefined, payeeId: undefined } : {}) } as any)
    const effectiveWindow = {
      sinceDate, untilDate: opts.untilDate ?? null,
      note: explicit ? `Window: ${sinceDate} → ${opts.untilDate ?? 'today'}.` : `No since_date given — the YNAB API defaults to the last 365 days (${sinceDate} → today). Pass since_date for older history.`,
    }
    if (opts.aggregate) return { effectiveWindow, total: all.length, aggregate: aggregateTxns(all, opts.aggregate, fmt.symbol, fmt) }
    // The API returns ascending date order; newest-first is the useful default for "recent" questions.
    all.sort((a, b) => (opts.sort === 'date_asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)))
    const limit = Math.min(opts.limit ?? 25, 200)
    const offset = opts.offset ?? 0
    const page = all.slice(offset, offset + limit)
    const rows = opts.fields?.length
      ? page.map((t) => Object.fromEntries(opts.fields!.flatMap((f) => {
          const key = (TXN_FIELD_ALIASES[f as string] ?? f) as keyof Txn
          const v = t[key]
          const entries: [string, unknown][] = [[f, v === undefined ? null : v]]
          // MINOR 4 (truthful-output review): a `fields` projection narrows to exactly the requested
          // keys — without this, `fields: ['amount']` would return a bare `{ amount: -1000 }` with no
          // companion, even though the unprojected row always carries amountText alongside amount.
          if (MONEY_TXN_FIELDS.has(key)) entries.push([`${f}Text`, t[`${key}Text` as keyof Txn] ?? null])
          return entries
        })))
      : page.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !DEFAULT_OMIT_TXN_FIELDS.has(k as keyof Txn))))
    return { effectiveWindow, total: all.length, transactions: rows, page: { limit, offset, returned: page.length } }
  }

  async getTransaction(planId: string, id: string): Promise<Txn> {
    const [data, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/transactions/${id}`),
      this.#resolveCurrency(planId),
    ])
    return mapTxn(data.transaction, fmt.symbol, fmt)
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

  /**
   * Fetches the current state of a specific set of transactions in ONE request, not one per id.
   * updateTransactions needs prior values before it writes (to build its `inverse`, and the local
   * undo journal's patch_transactions op) — a naive Promise.all(ids.map(getTransaction)) would cost
   * one request per row, which on a 40-row bulk update alone would burn 20% of YNAB's 200/hr limit.
   * The plan-wide transactions list is one call regardless of how many ids we're after.
   *
   * Must pass an explicit since_date: per YNAB API changelog v1.85.0, listing endpoints default
   * since_date to one year ago when the query param is omitted. The single per-row GET this replaced
   * (plan transactions by-id) had no date window at all, so an unqualified bulk read here would
   * silently narrow coverage — rows older than ~1 year would fail to be found below. Uses
   * FAR_PAST_SINCE_DATE, the same "all history" convention as getNetWorthHistory's #allTxns call.
   */
  async #getTransactionsByIds(planId: string, ids: string[]): Promise<Map<string, Txn>> {
    const wanted = new Set(ids)
    const found = new Map<string, Txn>()
    for (const t of await this.#allTxns(planId, FAR_PAST_SINCE_DATE)) {
      if (wanted.has(t.id)) found.set(t.id, t)
    }
    return found
  }

  async updateTransactions(planId: string, updates: ({ id: string } & Partial<Pick<NewTxn, 'date' | 'amount' | 'payeeId' | 'payeeName' | 'categoryId' | 'memo' | 'cleared' | 'approved' | 'flagColor'>>)[], opts: { confirm?: boolean; expectedCount?: number } = {}) {
    this.assertWrites()
    if (updates.length > 5) {
      if (!opts.confirm || opts.expectedCount === undefined) throw new ConfirmationRequiredError('Bulk transaction update (>5 rows)')
      if (opts.expectedCount !== updates.length) throw new Error(`expected_count (${opts.expectedCount}) does not match the ${updates.length} rows provided — aborting; re-check the update set.`)
    }
    // MINOR (currency-symbol review): resolve the currency format IN PARALLEL with the prior-values
    // fetch rather than after it — both are read-only and independent, so awaiting them sequentially
    // added a full extra round-trip of latency uniquely on this write path, right before the PATCH.
    const [priorById, fmt] = await Promise.all([
      this.#getTransactionsByIds(planId, updates.map((u) => u.id)),
      this.#resolveCurrency(planId),
    ])
    const prior = updates.map((u) => {
      const p = priorById.get(u.id)
      if (!p) throw new Error(`Transaction ${u.id} not found — cannot read its prior values before updating it.`)
      return p
    })
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
    // Plain-language inverse for the hosted tier (no undo journal there — the conversation carries
    // this instead). Built from `prior`, fetched above BEFORE the write below.
    const rowSummaries = updates.map((u, i) => {
      const clauses = txnRevertClauses(prior[i]!, u as Record<string, unknown>, fmt)
      if (clauses.length === 0) return null
      return `${prior[i]!.payeeName ?? prior[i]!.id}: ${clauses.join(', ')}`
    }).filter((s): s is string => s !== null)
    const inverseText = rowSummaries.length > 0
      ? `To reverse: restore ${rowSummaries.length} transaction(s) — ${rowSummaries.join('; ')}.`
      : 'Nothing changed — no fields differed from their prior values.'
    const jid = this.journal?.begin(`update ${updates.length} transaction(s)`, inverse)
    await this.client.request<any>(`/plans/${planId}/transactions`, { method: 'PATCH', body: { transactions: updates.map((u) => ({ id: u.id, ...this.#toApiTxn(u) })) } })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { updated: updates.length, inverse: inverseText }
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
    return { id: data.category.id, name: data.category.name, inverse: `${NOT_REVERSIBLE} a category. If you don't want "${data.category.name}", hide it instead (update_category with hidden: true).` }
  }

  async updateCategory(planId: string, categoryId: string, patch: { name?: string; hidden?: boolean; goalTarget?: number | null; goalTargetDate?: string | null; goalFrequency?: 'monthly' | 'weekly' | 'yearly' | null; goalNeedsWholeAmount?: boolean | null }) {
    this.assertWrites()
    const [prior, fmt] = await Promise.all([this.#getCategoryRaw(planId, categoryId), this.#resolveCurrency(planId)])
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
    return { updated: categoryId, inverse: `To reverse: for category "${prior.name}", set ${categoryInverseClauses(body, prior, fmt)}.` }
  }

  async #patchMonthCategory(planId: string, month: string, categoryId: string, budgetedMilli: number): Promise<any> {
    return this.client.request<any>(`/plans/${planId}/months/${month}/categories/${categoryId}`, { method: 'PATCH', body: { category: { budgeted: budgetedMilli } } })
  }

  async assignBudget(planId: string, month: string, categoryId: string, amount: number, reason?: string, opts: { confirm?: boolean } = {}) {
    this.assertWrites()
    if (!opts.confirm) throw new ConfirmationRequiredError('Assigning budget to a category')
    const [priorData, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/months/${month}/categories/${categoryId}`),
      this.#resolveCurrency(planId),
    ])
    const prior = priorData.category
    const suffix = reason ? ` — reason: ${reason}` : ''
    const jid = this.journal?.begin(`assign ${amount} to category in ${month}${suffix}`, [{ kind: 'assign_budget', planId, month, categoryId, budgetedMilli: prior.budgeted }])
    await this.#patchMonthCategory(planId, month, categoryId, dollarsToMilli(amount))
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    // Symmetric — no extra API call: `prior` was already fetched above for the undo journal, so its
    // name/budgeted give us the reverse assignment for free.
    const inverse = `To reverse: set the assigned amount for ${prior.name ?? categoryId} in ${month} back to ${formatDollars(milliToDollars(prior.budgeted), fmt)} (it was just changed to ${formatDollars(amount, fmt)}).`
    return { month, categoryId, assigned: amount, assignedText: formatDollars(amount, fmt), ...(reason ? { reason } : {}), inverse }
  }

  async moveMoney(planId: string, month: string, fromCategoryId: string, toCategoryId: string, amount: number, reason?: string, opts: { confirm?: boolean } = {}) {
    this.assertWrites()
    if (!opts.confirm) throw new ConfirmationRequiredError('Moving money between categories')
    const [from, to, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/months/${month}/categories/${fromCategoryId}`),
      this.client.request<any>(`/plans/${planId}/months/${month}/categories/${toCategoryId}`),
      this.#resolveCurrency(planId),
    ])
    const fromPrior = from.category.budgeted as number
    const toPrior = to.category.budgeted as number
    const milli = dollarsToMilli(amount)
    const suffix = reason ? ` — reason: ${reason}` : ''
    const jid = this.journal?.begin(`move ${amount} between categories in ${month}${suffix}`, [
      { kind: 'assign_budget', planId, month, categoryId: fromCategoryId, budgetedMilli: fromPrior },
      { kind: 'assign_budget', planId, month, categoryId: toCategoryId, budgetedMilli: toPrior },
    ])
    // Symmetric — no extra API call: `from`/`to` were already fetched above for the undo journal;
    // their names give a readable reverse-direction description for free, and let a half-applied
    // failure below name which category holds what now.
    const fromName = from.category.name ?? fromCategoryId
    const toName = to.category.name ?? toCategoryId
    await this.#patchMonthCategory(planId, month, fromCategoryId, fromPrior - milli)
    try {
      await this.#patchMonthCategory(planId, month, toCategoryId, toPrior + milli)
    } catch (e) {
      try {
        await this.#patchMonthCategory(planId, month, fromCategoryId, fromPrior) // rollback
      } catch (rollbackErr) {
        // Rollback itself failed: the move is now half-applied (money left fromCategoryId but never
        // reached toCategoryId). Commit the journal entry — its two assign_budget inverses are exactly
        // the repair needed.
        if (jid) this.journal!.commit(jid)
        this.cache?.invalidate(planId)
        const lead = `${(e as Error).message}; rollback also failed: ${(rollbackErr as Error).message} — the move is half-applied`
        // Journal present (e.g. the local/desktop deployment): undo_last can replay the two
        // assign_budget inverses just committed above, so today's instruction is still true.
        // No journal (the hosted tier passes none — buildYnab): undo_last isn't registered, so naming
        // it would be a false deployment fact. State plainly which category holds what now and give
        // the manual correction instead.
        if (this.journal) {
          throw new Error(`${lead}; run undo_last to restore both categories.`)
        }
        throw new Error(`${lead}: "${fromName}" is short ${formatDollars(amount, fmt)} ` +
          `(now ${formatDollars(milliToDollars(fromPrior - milli), fmt)}, was ${formatDollars(milliToDollars(fromPrior), fmt)}); ` +
          `"${toName}" was never credited (still ${formatDollars(milliToDollars(toPrior), fmt)}). ` +
          // assign_budget sets the ABSOLUTE assigned amount, not a delta — naming `amount` here would
          // instruct a SECOND wrong write (e.g. setting Dining Out to $100 instead of restoring it to
          // $500). Must name the restore-to figure (fromPrior), matching the idiom assignBudget's own
          // inverse uses two functions above.
          `To fix it, manually set the assigned amount for "${fromName}" in ${month} back to ${formatDollars(milliToDollars(fromPrior), fmt)}.`)
      }
      throw new Error(`${(e as Error).message} — the first half of the move was rolled back; no money moved.`)
    }
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    const inverse = `To reverse: move ${formatDollars(amount, fmt)} from ${toName} back to ${fromName}.`
    const fromAssigned = milliToDollars(fromPrior - milli)
    const toAssigned = milliToDollars(toPrior + milli)
    return {
      moved: amount, movedText: formatDollars(amount, fmt),
      from: { id: fromCategoryId, assigned: fromAssigned, assignedText: formatDollars(fromAssigned, fmt) },
      to: { id: toCategoryId, assigned: toAssigned, assignedText: formatDollars(toAssigned, fmt) },
      ...(reason ? { reason } : {}), inverse,
    }
  }

  async renamePayee(planId: string, payeeId: string, name: string) {
    this.assertWrites()
    const prior = (await this.client.request<any>(`/plans/${planId}/payees/${payeeId}`)).payee
    const jid = this.journal?.begin(`rename payee ${prior.name} → ${name}`, [{ kind: 'rename_payee', planId, payeeId, name: prior.name }])
    await this.client.request(`/plans/${planId}/payees/${payeeId}`, { method: 'PATCH', body: { payee: { name } } })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { renamed: payeeId, inverse: `To reverse: rename the payee back to "${prior.name}" (it was just renamed to "${name}").` }
  }

  async createPayee(planId: string, name: string) {
    this.assertWrites()
    const data = await this.client.request<any>(`/plans/${planId}/payees`, { method: 'POST', body: { payee: { name } } })
    const jid = this.journal?.begin(`create payee "${name}" (not undoable — YNAB's API has no payee delete)`, [], { undoable: false })
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { id: data.payee.id, name: data.payee.name, inverse: `${NOT_REVERSIBLE} a payee. If you don't want "${data.payee.name}", rename it instead (rename_payee).` }
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
    const [data, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/transactions`, { query: { since_date: sinceDate, until_date: untilDate } }),
      this.#resolveCurrency(planId),
    ])
    return data.transactions.filter((t: any) => !t.deleted).map((t: any) => mapTxn(t, fmt.symbol, fmt))
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
    const fmt = await this.#resolveCurrency(planId)
    return { window: { since, until }, rows: spendingSummary(cur.filter((t) => t.amount < 0), { by: opts.by ?? 'category', compareTxns: compareTxns?.filter((t) => t.amount < 0), symbol: fmt.symbol, fmt }) }
  }

  async getBudgetHealth(planId: string) {
    const [month, accountsData, fmt] = await Promise.all([this.getMonth(planId, 'current'), this.client.request<any>(`/plans/${planId}/accounts`), this.#resolveCurrency(planId)])
    const accounts = accountsData.accounts.filter((a: any) => !a.deleted && !a.closed).map((a: any) => ({ name: a.name, type: a.type, balance: milliToDollars(a.balance) }))
    return budgetHealth({ readyToAssign: month.readyToAssign, categories: month.categories, accounts, symbol: fmt.symbol, fmt })
  }

  async getRecurringCharges(planId: string) {
    const [txns, fmt] = await Promise.all([
      this.#allTxns(planId, new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10)),
      this.#resolveCurrency(planId),
    ])
    return detectRecurring(txns, fmt.symbol, fmt)
  }

  async getIncomeVsExpense(planId: string, opts: { months?: number } = {}) {
    const n = opts.months ?? 6
    const today = new Date().toISOString().slice(0, 10)
    const since = monthWindowStart(today, n)
    const [txns, fmt] = await Promise.all([this.#allTxns(planId, since), this.#resolveCurrency(planId)])
    return incomeVsExpense(this.#nonTransfer(txns), today, fmt.symbol, fmt)
  }

  async getNetWorthHistory(planId: string) {
    const [txns, fmt] = await Promise.all([this.#allTxns(planId, FAR_PAST_SINCE_DATE), this.#resolveCurrency(planId)])
    return netWorthHistory(txns, fmt.symbol, fmt)
  }

  async #monthCloseRaw(planId: string, cutoff: string, lookbackDays: number) {
    const lookback = Math.min(Math.max(lookbackDays, 1), 365)
    const since = new Date(Date.parse(cutoff) - lookback * 86_400_000).toISOString().slice(0, 10)
    const monthKey = cutoff.slice(0, 8) + '01'
    const [accountsData, txnsData, monthData, fmt] = await Promise.all([
      this.client.request<any>(`/plans/${planId}/accounts`),
      this.client.request<any>(`/plans/${planId}/transactions`, { query: { since_date: since } }),
      this.client.request<any>(`/plans/${planId}/months/${monthKey}`),
      this.#resolveCurrency(planId),
    ])
    const accounts = accountsData.accounts.filter((a: RawAccount) => !a.deleted) as RawAccount[]
    const txns = txnsData.transactions as RawTxn[]
    const monthCats = monthData.month.categories as RawMonthCat[]
    return { accounts, txns, monthCats, rtaMilli: monthData.month.to_be_budgeted as number, fmt }
  }

  async monthClose(planId: string, opts: { cutoff: string; lookbackDays?: number }) {
    const { cutoff } = opts
    const { accounts, txns, monthCats, fmt } = await this.#monthCloseRaw(planId, cutoff, opts.lookbackDays ?? 120)
    const warnings: string[] = []
    const balances = asOfBalances(accounts, txns, cutoff)
    const { matches, warnings: matchWarnings } = matchCards(accounts, monthCats)
    warnings.push(...matchWarnings)
    const perCard = matches.map(({ account, category }) => {
      const b = balances.get(account.id)!
      const workingAsOf = milliToDollars(b.workingMilli)
      const clearedAsOf = milliToDollars(b.clearedMilli)
      const availableAtMonthEnd = milliToDollars(category.balance)
      const gap = milliToDollars(b.workingMilli + category.balance)
      return {
        account: account.name,
        workingAsOf, workingAsOfText: formatDollars(workingAsOf, fmt),
        clearedAsOf, clearedAsOfText: formatDollars(clearedAsOf, fmt),
        availableAtMonthEnd, availableAtMonthEndText: formatDollars(availableAtMonthEnd, fmt),
        gap, gapText: formatDollars(gap, fmt),
        paymentCategoryId: category.id,
      }
    })
    const onBudget = new Set(accounts.filter((a) => a.on_budget && !a.closed).map((a) => a.id))
    const accountName = new Map(accounts.map((a) => [a.id, a.name]))
    const raw = findBlockers(txns, cutoff, onBudget)
    const row = (t: RawTxn) => {
      const amount = milliToDollars(t.amount)
      return { id: t.id, date: t.date, payee: t.payee_name ?? null, account: t.account_name ?? accountName.get(t.account_id) ?? t.account_id, amount, amountText: formatDollars(amount, fmt) }
    }
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
      redCategories: reds.map((c) => {
        const available = milliToDollars(c.balance)
        return { id: c.id, name: c.name, available, availableText: formatDollars(available, fmt), group: c.category_group_name ?? '' }
      }),
      donors: donors.map((d) => {
        const available = milliToDollars(d.cat.balance)
        const excess = milliToDollars(d.excessMilli)
        return { id: d.cat.id, name: d.cat.name, group: d.cat.category_group_name ?? '', available, availableText: formatDollars(available, fmt), excess, excessText: formatDollars(excess, fmt), hasTarget: d.cat.goal_type != null }
      }),
    }
  }

  async proposeCoverage(planId: string, opts: { cutoff: string; strategy?: 'donors_first' | 'rta_only' }) {
    const { monthCats, rtaMilli, fmt } = await this.#monthCloseRaw(planId, opts.cutoff, 120)
    const reds = findRedCategories(monthCats)
    const donors = rankDonors(monthCats, new Set(reds.map((c) => c.id)))
    const res = proposeMoves(reds, donors, rtaMilli, opts.strategy ?? 'donors_first')
    const rtaUsed = milliToDollars(res.rtaUsedMilli)
    const rtaRemaining = milliToDollars(res.rtaRemainingMilli)
    return {
      month: opts.cutoff.slice(0, 8) + '01',
      moves: res.moves.map((m) => {
        const amount = milliToDollars(m.amountMilli)
        return { from: m.fromName, fromId: m.fromId, to: m.toName, toId: m.toId, amount, amountText: formatDollars(amount, fmt), source: m.source }
      }),
      unfundable: res.unfundable.map((u) => {
        const needed = milliToDollars(u.neededMilli)
        return { id: u.id, name: u.name, needed, neededText: formatDollars(needed, fmt) }
      }),
      rtaUsed, rtaUsedText: formatDollars(rtaUsed, fmt),
      rtaRemaining, rtaRemainingText: formatDollars(rtaRemaining, fmt),
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
    // Throws synchronously on an invalid range before any fetch fires — see the identical guard (and
    // its rationale) on #attributedFloat below. Without this, Promise.all would kick off the
    // #resolveCurrency /plans/{plan_id}/settings fetch before #categoryHistoryMilli's internal
    // monthRange rejection is observed, and "validates the range before any fetch" would no longer be true.
    monthRange(opts.sinceMonth, opts.untilMonth)
    const [h, fmt] = await Promise.all([this.#categoryHistoryMilli(planId, opts), this.#resolveCurrency(planId)])
    return {
      category: { id: opts.categoryId, name: h.name },
      points: h.pointsMilli.map((p) => {
        const assigned = milliToDollars(p.assignedMilli)
        const activity = milliToDollars(p.activityMilli)
        const available = milliToDollars(p.availableMilli)
        return { month: p.month, assigned, assignedText: formatDollars(assigned, fmt), activity, activityText: formatDollars(activity, fmt), available, availableText: formatDollars(available, fmt) }
      }),
      skippedMonths: h.skippedMonths,
    }
  }

  /**
   * Shared fetch+floatSeries+attributeChanges pipeline behind both getCreditCardFloatHistory and
   * backfillLedger — keeps the two in lockstep so a backfilled month and its live equivalent always agree.
   */
  async #attributedFloat(planId: string, opts: { paymentCategoryId: string; cardAccountId: string; sinceMonth: string; untilMonth: string }) {
    // Throws synchronously on an invalid range before any fetch fires — Promise.all below would
    // otherwise kick off the account/transactions calls before #categoryHistoryMilli's internal
    // monthRange rejection is observed. The result is discarded; it exists only to throw early.
    monthRange(opts.sinceMonth, opts.untilMonth)
    const [h, accountData, txnsData, fmt] = await Promise.all([
      this.#categoryHistoryMilli(planId, { categoryId: opts.paymentCategoryId, sinceMonth: opts.sinceMonth, untilMonth: opts.untilMonth }),
      this.client.request<any>(`/plans/${planId}/accounts/${opts.cardAccountId}`),
      this.client.request<any>(`/plans/${planId}/accounts/${opts.cardAccountId}/transactions`, { query: { since_date: `${opts.sinceMonth}-01` } }),
      this.#resolveCurrency(planId),
    ])
    const series = floatSeries(
      h.pointsMilli.map((p) => ({ month: p.month, availableMilli: p.availableMilli })),
      txnsData.transactions,
      accountData.account.balance,
    )
    const assignedByMonth = new Map(h.pointsMilli.map((p) => [p.month, p.assignedMilli]))
    const attributed = attributeChanges(
      series.map((p) => ({ month: p.month, gapChangeMilli: p.gapChangeMilli, availableMilli: p.availableMilli, assignedMilli: assignedByMonth.get(p.month) ?? 0 })),
      txnsData.transactions,
    )
    const attrByMonth = new Map(attributed.map((a) => [a.month, a]))
    return { account: accountData.account.name as string, series, attrByMonth, skippedMonths: h.skippedMonths, fetchedMonths: h.pointsMilli.length, fmt }
  }

  async getCreditCardFloatHistory(planId: string, opts: { paymentCategoryId: string; cardAccountId: string; sinceMonth: string; untilMonth: string }) {
    const { account, series, attrByMonth, skippedMonths, fetchedMonths, fmt } = await this.#attributedFloat(planId, opts)
    return {
      account,
      points: series.map((p): {
        month: string; owed: number; owedText: string; available: number; availableText: string
        gap: number; gapText: string; changed: boolean; gapChange: number; gapChangeText: string
        direction: 'grew' | 'shrank' | 'flat'; cause?: GapCause; evidence?: { components: ReturnType<typeof toEvidenceComponent>[] }
      } => {
        const owed = milliToDollars(p.owedMilli)
        const available = milliToDollars(p.availableMilli)
        const gap = milliToDollars(p.gapMilli)
        const gapChange = milliToDollars(p.gapChangeMilli)
        const base = {
          month: p.month, owed, owedText: formatDollars(owed, fmt), available, availableText: formatDollars(available, fmt),
          gap, gapText: formatDollars(gap, fmt), changed: p.changed, gapChange, gapChangeText: formatDollars(gapChange, fmt), direction: p.direction,
        }
        if (!p.changed) return base
        const a = attrByMonth.get(p.month)
        if (!a || a.components.length === 0) return base
        const primary = a.components.reduce((best, c) => (Math.abs(c.amountMilli) > Math.abs(best.amountMilli) ? c : best))
        return { ...base, cause: primary.cause, evidence: { components: a.components.map((c) => toEvidenceComponent(c, fmt)) } }
      }),
      skippedMonths,
      note: 'gap = available − owed at month end. 0 = covered; negative = payment category short (float). A STATIC gap is carried history; months with changed:true are where new float appeared or was paid down.' +
        (fetchedMonths === 0 ? ' WARNING: every month in the range was skipped (no data for this category) — the payment_category_id may be wrong.' : ''),
    }
  }

  /**
   * Backfills the LOCAL balance-forward ledger from history: one 'backfill' record per fully-elapsed month (never
   * touches YNAB), replacing any prior backfill records for this plan+card, plus a discovery summary
   * of how long float has been carried. `untilMonth` defaults to the current month (UTC).
   */
  async backfillLedger(planId: string, opts: { paymentCategoryId: string; cardAccountId: string; sinceMonth: string; untilMonth?: string }) {
    if (!this.ledger) throw new Error('No ledger configured — this server was started without a LedgerStore.')
    const untilMonth = opts.untilMonth ?? currentMonthUTC()
    const { account, series, attrByMonth, fmt } = await this.#attributedFloat(planId, { paymentCategoryId: opts.paymentCategoryId, cardAccountId: opts.cardAccountId, sinceMonth: opts.sinceMonth, untilMonth })

    // Records are a historical ledger line, stamped gapStatus:'final' — only months that have actually
    // finished get one. Writing the in-progress month would lie (a future cutoff, zero blockers, 'final'
    // on a month that hasn't happened yet). The discovery summary below still walks the FULL `series`
    // (including any in-progress month) since it needs the truest currentGap.
    const recordsCutoffMonth = lastCompleteMonth(new Date().toISOString())
    const recordableSeries = series.filter((p) => p.month <= recordsCutoffMonth)

    const records = recordableSeries.map((p) => {
      const workingAsOf = milliToDollars(-p.owedMilli)
      const availableAtMonthEnd = milliToDollars(p.availableMilli)
      const gap = milliToDollars(p.gapMilli)
      const causes = (attrByMonth.get(p.month)?.components ?? []).map((c) => {
        const change = milliToDollars(c.amountMilli)
        return { month: p.month, change, changeText: formatDollars(change, fmt), cause: c.cause as string }
      })
      return {
        planId, cutoff: lastDayOf(p.month), gapStatus: 'final' as const,
        perCard: [{
          account, workingAsOf, workingAsOfText: formatDollars(workingAsOf, fmt),
          clearedAsOf: workingAsOf, clearedAsOfText: formatDollars(workingAsOf, fmt),
          availableAtMonthEnd, availableAtMonthEndText: formatDollars(availableAtMonthEnd, fmt),
          gap, gapText: formatDollars(gap, fmt),
        }],
        blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 },
        causes,
        note: 'backfill: cleared state not reconstructable historically, blockers not reconstructable',
      }
    })
    // Never wipe existing backfill history when this run produced nothing to write
    // (e.g. a range containing no complete months) — replace only replaces with substance.
    const written = records.length > 0 ? await this.ledger.replaceBackfill(planId, account, records) : []

    // Walk backward from the newest point while the gap stays nonzero — that's the unbroken "carrying float" run.
    let nonZeroSince: string | null = null
    let sinceAtLeast = false
    for (let i = series.length - 1; i >= 0; i--) {
      if (Math.abs(series[i]!.gapMilli) <= 10) break
      nonZeroSince = series[i]!.month
      if (i === 0) sinceAtLeast = true
    }
    const last = series[series.length - 1]
    const currentGap = milliToDollars(last?.gapMilli ?? 0)
    // A negative gap is float (payment category short); a persistent POSITIVE gap is surplus, not float —
    // don't call an overfunded payment category "float".
    const summary = nonZeroSince === null
      ? `Card is covered as of ${last?.month ?? untilMonth}.`
      : currentGap < 0
        ? `You've been carrying ${formatDollars(Math.abs(currentGap), fmt)} of float since ${sinceAtLeast ? 'at least ' : ''}${nonZeroSince}.`
        : `Your payment category has run a ${formatDollars(Math.abs(currentGap), fmt)} surplus since ${sinceAtLeast ? 'at least ' : ''}${nonZeroSince}.`

    const changePoints = series.filter((p) => p.changed).map((p) => {
      const a = attrByMonth.get(p.month)
      const primary = a && a.components.length > 0
        ? a.components.reduce((best, c) => (Math.abs(c.amountMilli) > Math.abs(best.amountMilli) ? c : best))
        : undefined
      const gapChange = milliToDollars(p.gapChangeMilli)
      return { month: p.month, gapChange, gapChangeText: formatDollars(gapChange, fmt), cause: (primary?.cause ?? 'unattributed') as GapCause }
    })

    return {
      account, monthsWritten: written.length,
      discovery: { currentGap, currentGapText: formatDollars(currentGap, fmt), nonZeroSince, sinceAtLeast, summary },
      changePoints,
    }
  }

  /**
   * IMPORTANT 3 fix (currency-symbol review): this is a LOCAL-ONLY ledger append — its own description
   * (apps/mcp/src/tools.ts) says "never touches YNAB", which #resolveCurrency's `GET .../settings` call
   * used to silently contradict (a network request, a rate-limiter slot, on a tool documented as
   * network-free). No resolution here: withMoneyText fills any missing *Text field with currency-neutral
   * formatting ({ symbol: '' }) instead. A caller-supplied *Text value (this tool's schema currently
   * accepts none, but withMoneyText's contract allows it) still wins via its own `??` — this only affects
   * the fields synthesized here.
   */
  async recordMonthClose(record: Omit<MonthCloseRecord, 'id' | 'recordedAt'>): Promise<MonthCloseRecord> {
    if (!this.ledger) throw new Error('No ledger configured — this server was started without a LedgerStore.')
    return await this.ledger.append(withMoneyText(record, { symbol: '' }))
  }

  async getMonthCloseLedger(opts?: { limit?: number; cutoff?: string; kind?: 'close' | 'backfill' }): Promise<{ records: MonthCloseRecord[]; note?: string }> {
    if (!this.ledger) return { records: [], note: 'No ledger configured' }
    return { records: await this.ledger.list(opts) }
  }
}
