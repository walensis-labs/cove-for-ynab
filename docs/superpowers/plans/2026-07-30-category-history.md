# get_category_history + credit_card_float_history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two READ-ONLY tools: a compact single-category monthly series (assigned/activity/available) over a month range, and the credit-card float analysis built on it (owed vs available vs gap per month, flagging months where the gap changes).

**Architecture:** New pure module `packages/core/src/category-history.ts` (month-range generation + float-series math, integer milliunits); two domain wrappers on `Ynab` using the existing `YnabClient` (batched per-month fetches, 404-skip, 60-month cap); two tool entries (30 → 32).

**Tech Stack:** existing — TypeScript strict ESM, vitest, no new dependencies.

## Global Constraints

- Both tools READ-ONLY: no write flag, no journal, no cache writes, GETs only.
- Integer milliunits until the output boundary (`milliToDollars` once per emitted number). `changed` threshold: `|gapMilli − prevGapMilli| > 5`; first point `changed: false`.
- Month params match `^\d{4}-\d{2}$`; `since_month <= until_month`; range ≤ **60 months** — violations throw a clear Error BEFORE any fetch.
- Per-month fetch: `GET /plans/{p}/months/{YYYY-MM-01}/categories/{c}`; a `YnabApiError` with `status === 404` skips that month (pre-`first_month`); any other error propagates. Batched `Promise.all` of 6.
- Owed anchor: account's WORKING `balance` (not cleared). `owedMilli(m) = -(currentBalanceMilli − Σ txn amounts where date > \`${m}-31\`)` — positive when money is owed. Single transactions fetch via the account sub-endpoint with `since_date = ${since_month}-01`, no until_date; deleted txns excluded; parent amounts only.
- `gapMilli = availableMilli − owedMilli`.
- Output series sorted ascending by month.
- Tool count becomes exactly 32.

## File Structure

```
packages/core/src/category-history.ts        # pure: monthRange, floatSeries
packages/core/test/category-history.test.ts  # pure tests
packages/core/src/domain.ts                  # + getCategoryHistory(), getCreditCardFloatHistory()
packages/core/test/domain-category-history.test.ts  # fake-client tests
apps/mcp/src/tools.ts                        # + 2 entries (after propose_coverage, before undo_last)
apps/mcp/test/server.test.ts                 # count 30 → 32
README.md                                    # + 2 rows, count sweep 30 → 32
```

---

### Task 1: Pure helpers (`category-history.ts`)

**Files:**
- Create: `packages/core/src/category-history.ts`
- Test: `packages/core/test/category-history.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './category-history.js'`)

**Interfaces:**
- Produces (later tasks rely on exact names):
```ts
export function monthRange(sinceMonth: string, untilMonth: string): string[]
  // inclusive first-of-month ISO dates; throws Error on bad format, since > until, or > 60 months
export interface FloatPoint { month: string; owedMilli: number; availableMilli: number; gapMilli: number; changed: boolean }
export function floatSeries(
  avail: { month: string; availableMilli: number }[],           // ascending by month
  txns: { date: string; amount: number; deleted?: boolean }[],  // parent rows, milli
  currentBalanceMilli: number,
): FloatPoint[]
```

- [ ] **Step 1: Write failing tests**

`packages/core/test/category-history.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { monthRange, floatSeries } from '../src/category-history.js'

describe('monthRange', () => {
  it('produces inclusive first-of-month dates across a year boundary', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'])
  })
  it('single month', () => {
    expect(monthRange('2026-07', '2026-07')).toEqual(['2026-07-01'])
  })
  it('rejects bad formats, inverted ranges, and ranges over 60 months', () => {
    expect(() => monthRange('2026-7', '2026-08')).toThrow(/YYYY-MM/)
    expect(() => monthRange('2026-08', '2026-07')).toThrow(/before/)
    expect(() => monthRange('2020-01', '2026-01')).toThrow(/60 months/)
  })
})

describe('floatSeries', () => {
  // current working balance -1000_000 milli (owes $1000).
  // Txns: -200000 in July (2026-07-10), -300000 in August (2026-08-05).
  // Owed at June EOM: -( -1000000 - (-200000 + -300000) ) = -(-500000) = 500000 (owes $500)
  // Owed at July EOM: -( -1000000 - (-300000) ) = 700000
  // Owed at Aug  EOM: -( -1000000 - 0 ) = 1000000
  const txns = [
    { date: '2026-07-10', amount: -200000 },
    { date: '2026-08-05', amount: -300000 },
    { date: '2026-08-06', amount: -999999, deleted: true },
  ]
  const avail = [
    { month: '2026-06', availableMilli: 500000 },
    { month: '2026-07', availableMilli: 500000 },
    { month: '2026-08', availableMilli: 1000000 },
  ]
  it('computes owed by backing out post-month-end txns from the current balance', () => {
    const s = floatSeries(avail, txns, -1000000)
    expect(s.map((p) => [p.month, p.owedMilli, p.gapMilli, p.changed])).toEqual([
      ['2026-06', 500000, 0, false],       // covered; first point never "changed"
      ['2026-07', 700000, -200000, true],  // new $200 float appeared
      ['2026-08', 1000000, 0, true],       // caught back up
    ])
  })
  it('a static gap is not flagged as changed', () => {
    const s = floatSeries(
      [{ month: '2026-06', availableMilli: 0 }, { month: '2026-07', availableMilli: 0 }],
      [], -100000)
    expect(s.map((p) => [p.gapMilli, p.changed])).toEqual([[-100000, false], [-100000, false]])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -F @walensis/mcp-for-ynab-core test category-history` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/category-history.ts`:
```ts
const MONTH_RE = /^\d{4}-\d{2}$/
const MAX_MONTHS = 60

export function monthRange(sinceMonth: string, untilMonth: string): string[] {
  if (!MONTH_RE.test(sinceMonth) || !MONTH_RE.test(untilMonth)) {
    throw new Error(`Months must be formatted YYYY-MM (got "${sinceMonth}" / "${untilMonth}").`)
  }
  if (sinceMonth > untilMonth) throw new Error(`since_month (${sinceMonth}) must be before or equal to until_month (${untilMonth}).`)
  const out: string[] = []
  const [sy, sm] = sinceMonth.split('-').map(Number) as [number, number]
  const [uy, um] = untilMonth.split('-').map(Number) as [number, number]
  let y = sy, m = sm
  while (y < uy || (y === uy && m <= um)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
    if (++m > 12) { m = 1; y++ }
  }
  if (out.length > MAX_MONTHS) {
    throw new Error(`Range spans ${out.length} months — the limit is 60 months (each month costs one API call against YNAB's 200/hour budget). Narrow the range.`)
  }
  return out
}

export interface FloatPoint { month: string; owedMilli: number; availableMilli: number; gapMilli: number; changed: boolean }

export function floatSeries(
  avail: { month: string; availableMilli: number }[],
  txns: { date: string; amount: number; deleted?: boolean }[],
  currentBalanceMilli: number,
): FloatPoint[] {
  const live = txns.filter((t) => !t.deleted)
  let prevGap: number | null = null
  return avail.map((p) => {
    const monthEnd = `${p.month}-31` // ISO string compare: safely "after this month" for all real dates
    const after = live.filter((t) => t.date > monthEnd).reduce((s, t) => s + t.amount, 0)
    const owedMilli = -(currentBalanceMilli - after)
    const gapMilli = p.availableMilli - owedMilli
    const changed = prevGap !== null && Math.abs(gapMilli - prevGap) > 5
    prevGap = gapMilli
    return { month: p.month, owedMilli, availableMilli: p.availableMilli, gapMilli, changed }
  })
}
```
Add `export * from './category-history.js'` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** — `git add -A && git commit -m "feat(core): category-history month range and float-series math (pure)"`

---

### Task 2: Domain wrappers

**Files:**
- Modify: `packages/core/src/domain.ts`
- Test: `packages/core/test/domain-category-history.test.ts` (create)

**Interfaces:**
- Consumes: `monthRange`, `floatSeries` (Task 1), `YnabClient`, `YnabApiError`, `milliToDollars`.
- Produces on `Ynab` (dollars out):
```ts
getCategoryHistory(planId: string, opts: { categoryId: string; sinceMonth: string; untilMonth: string }): Promise<{
  category: { id: string; name: string | null }
  points: { month: string; assigned: number; activity: number; available: number }[]
  skippedMonths: string[]   // months that 404ed (before the plan's first month), 'YYYY-MM'
}>
getCreditCardFloatHistory(planId: string, opts: { paymentCategoryId: string; cardAccountId: string; sinceMonth: string; untilMonth: string }): Promise<{
  account: string
  points: { month: string; owed: number; available: number; gap: number; changed: boolean }[]
  note: string   // explains gap semantics: 0 covered, negative short, static-vs-changed
}>
```
Mechanics: `getCategoryHistory` builds `monthRange`, fetches in `Promise.all` batches of 6 via `#fetchMonthCategory(planId, monthIso, categoryId)` which returns the raw category or `null` on `YnabApiError` `status === 404`; name taken from the first successful response; points sorted ascending. `getCreditCardFloatHistory` composes: category history (milli — see below) + `GET /plans/{p}/accounts/{a}` (working `balance`) + `GET /plans/{p}/accounts/{a}/transactions?since_date=${sinceMonth}-01` (parent amounts, deleted filtered by floatSeries) → `floatSeries` → dollars. To keep milli precision internally, factor a private `#categoryHistoryMilli(planId, opts)` returning `{ name, pointsMilli: { month, assignedMilli, activityMilli, availableMilli }[], skippedMonths }` used by both public methods.

- [ ] **Step 1: Write failing tests**

`packages/core/test/domain-category-history.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'
import { YnabApiError } from '../src/client.js'

function seriesClient() {
  return { request: vi.fn(async (path: string) => {
    const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/c1$/)
    if (m) {
      const month = m[1]!
      if (month === '2026-05') throw new YnabApiError(404, '404.2', 'not found') // pre-first_month
      const base = month === '2026-06' ? 500000 : 700000
      return { category: { id: 'c1', name: 'Citi Card', budgeted: 100000, activity: -50000, balance: base } }
    }
    throw new Error(`unmocked ${path}`)
  }) } as any
}

describe('getCategoryHistory', () => {
  it('returns a compact dollar series, skipping 404 months', async () => {
    const c = seriesClient()
    const y = new Ynab({ client: c, allowWrites: false })
    const res = await y.getCategoryHistory('last-used', { categoryId: 'c1', sinceMonth: '2026-05', untilMonth: '2026-07' })
    expect(res.category).toEqual({ id: 'c1', name: 'Citi Card' })
    expect(res.skippedMonths).toEqual(['2026-05'])
    expect(res.points).toEqual([
      { month: '2026-06', assigned: 100, activity: -50, available: 500 },
      { month: '2026-07', assigned: 100, activity: -50, available: 700 },
    ])
    expect(c.request).toHaveBeenCalledTimes(3)
  })
  it('validates the range before any fetch', async () => {
    const c = { request: vi.fn() } as any
    const y = new Ynab({ client: c, allowWrites: false })
    await expect(y.getCategoryHistory('p', { categoryId: 'c1', sinceMonth: '2020-01', untilMonth: '2026-01' })).rejects.toThrow(/60 months/)
    expect(c.request).not.toHaveBeenCalled()
  })
})

describe('getCreditCardFloatHistory', () => {
  it('composes owed/available/gap in dollars with changed flags', async () => {
    const c = { request: vi.fn(async (path: string) => {
      const m = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/p1$/)
      if (m) return { category: { id: 'p1', name: 'Citi Card', budgeted: 0, activity: 0, balance: m[1] === '2026-08' ? 1000000 : 500000 } }
      if (path.endsWith('/accounts/a1')) return { account: { id: 'a1', name: 'Citi Card', balance: -1000000 } }
      if (path.endsWith('/accounts/a1/transactions')) return { transactions: [
        { date: '2026-07-10', amount: -200000, deleted: false },
        { date: '2026-08-05', amount: -300000, deleted: false },
      ] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const y = new Ynab({ client: c, allowWrites: false })
    const res = await y.getCreditCardFloatHistory('last-used', { paymentCategoryId: 'p1', cardAccountId: 'a1', sinceMonth: '2026-06', untilMonth: '2026-08' })
    expect(res.account).toBe('Citi Card')
    expect(res.points).toEqual([
      { month: '2026-06', owed: 500, available: 500, gap: 0, changed: false },
      { month: '2026-07', owed: 700, available: 500, gap: -200, changed: true },
      { month: '2026-08', owed: 1000, available: 1000, gap: 0, changed: true },
    ])
    const txnCall = c.request.mock.calls.find(([p]: any[]) => String(p).endsWith('/accounts/a1/transactions'))!
    expect(txnCall[1].query).toEqual({ since_date: '2026-06-01' })
  })
})
```

- [ ] **Step 2: Verify failure, implement in `domain.ts`**

Add to imports: `import { monthRange, floatSeries } from './category-history.js'` (and `YnabApiError` is already imported).

```ts
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
      points: series.map((p) => ({ month: p.month, owed: milliToDollars(p.owedMilli), available: milliToDollars(p.availableMilli), gap: milliToDollars(p.gapMilli), changed: p.changed })),
      note: 'gap = available − owed at month end. 0 = covered; negative = payment category short (float). A STATIC gap is carried history; months with changed:true are where new float appeared or was paid down.',
    }
  }
```

- [ ] **Step 3: Run full core suite + typecheck** (build core dist first: `pnpm -F @walensis/mcp-for-ynab-core build`) — PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(core): getCategoryHistory and getCreditCardFloatHistory wrappers"`

---

### Task 3: Tool registration, count test, README

**Files:**
- Modify: `apps/mcp/src/tools.ts` (two entries after `propose_coverage`, before `undo_last`)
- Modify: `apps/mcp/test/server.test.ts` (30 → 32)
- Modify: `README.md` (two rows, count sweep)

**Interfaces:**
- Consumes: `Ynab.getCategoryHistory` / `Ynab.getCreditCardFloatHistory` (Task 2 signatures).

- [ ] **Step 1: Update count test 30 → 32 and add a call-through (RED first)** — in `server.test.ts`:

```ts
  it('get_category_history is registered and returns the series shape', async () => {
    const fake = { request: vi.fn(async () => ({ category: { id: 'c1', name: 'X', budgeted: 0, activity: 0, balance: 0 } })) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'get_category_history', arguments: { plan_id: 'p1', category_id: 'c1', since_month: '2026-06', until_month: '2026-07' } })
    expect(res.isError).toBeUndefined()
    const body = JSON.parse(res.content[0].text)
    expect(body.points).toHaveLength(2)
    expect(body.category.id).toBe('c1')
  })
```

- [ ] **Step 2: Verify failure, add the two entries**

```ts
  { name: 'get_category_history', description: "READ-ONLY: one category's monthly series (assigned / activity / available) across a month range in a single compact response — use for any single-category trend instead of paging get_month (which returns every category). Months before the plan's start are skipped and listed in skippedMonths. Cost: one API call per month in the range (max 60).", schema: { plan_id: planId, category_id: z.string(), since_month: z.string().describe("first month, 'YYYY-MM'"), until_month: z.string().describe("last month inclusive, 'YYYY-MM'") }, handler: (y, a) => y.getCategoryHistory(a.plan_id, { categoryId: a.category_id, sinceMonth: a.since_month, untilMonth: a.until_month }) },
  { name: 'credit_card_float_history', description: "READ-ONLY: per-month credit-card float analysis over a range — the card's owed balance at each month end (backed out of the current balance) vs its payment category's available, the gap, and changed:true on months where the gap moved (new float appeared or was paid down; a static gap is just carried history). Pass the payment CATEGORY id and the card ACCOUNT id. For a single cutoff with blockers and donor proposals use month_close instead. Cost: ~one API call per month plus two.", schema: { plan_id: planId, payment_category_id: z.string().describe('the Credit Card Payments category id'), card_account_id: z.string().describe('the credit card account id'), since_month: z.string().describe("'YYYY-MM'"), until_month: z.string().describe("'YYYY-MM' inclusive") }, handler: (y, a) => y.getCreditCardFloatHistory(a.plan_id, { paymentCategoryId: a.payment_category_id, cardAccountId: a.card_account_id, sinceMonth: a.since_month, untilMonth: a.until_month }) },
```

- [ ] **Step 3: README** — two Read rows; `grep -n "30" README.md` → update tool-count mentions to 32 (leave unrelated numbers).
- [ ] **Step 4: Full verify** — `pnpm -F @walensis/mcp-for-ynab-core build && pnpm test && pnpm typecheck && pnpm build` all green.
- [ ] **Step 5: Commit** — `git commit -am "feat(mcp): get_category_history + credit_card_float_history tools (32 tools)"`

---

## Verification (end of plan — AJ, live)

1. `get_category_history` on a payment category over 24 months → compare a few months' `available` against the YNAB UI.
2. `credit_card_float_history` on one card for the same range → the latest month's `owed` must equal the card's current working balance (positive), and `gap` for the current month should match `month_close`'s `gap` for a cutoff of today (sign convention: float-history gap = available − owed; month_close gap = working + available — same number since owed = −working).
3. A range starting before the plan's first month → those months listed in `skippedMonths`, no error.
