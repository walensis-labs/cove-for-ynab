# month_close + propose_coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two read-only tools — `month_close` (per-card coverage report + blockers + red categories + ranked donors for a cutoff date) and `propose_coverage` (ordered move proposals, applied by the user via existing write tools).

**Architecture:** A new pure module `packages/core/src/month-close.ts` computes everything from RAW API shapes in integer milliunits (never `mapTxn`, never floats); `domain.ts` gains two thin wrappers doing the three fetches and dollar conversion at the output boundary; `apps/mcp/src/tools.ts` gains two read-only tool entries (28 → 30).

**Tech Stack:** existing — TypeScript strict ESM, vitest, no new dependencies.

## Global Constraints

- Both tools are READ-ONLY: no `write: true`, no journal entries, no confirmation gates. They must never call a mutating endpoint.
- All arithmetic in integer milliunits; `milliToDollars` only at the output boundary (spec: "Never introduce floats before the final division").
- Paths use `/plans/...`; plan id accepts `last-used`.
- `lookback_days` default 120, clamped to ≤ 365 (the API silently drops rows older than one year when since_date is omitted; we always pass since_date computed from cutoff − lookback).
- The transactions fetch passes `since_date` only — NEVER `until_date` (post-cutoff rows are required for the as-of back-out).
- Sum parent `amount` only for balance math (splits double-count otherwise); walk non-deleted `subtransactions` for categorization checks.
- A transaction (or sub) with `transfer_account_id !== null` is never "uncategorized".
- Month category "available" is the `balance` field on the month resource.
- Sign convention: `gap = workingAsOf + availableAtMonthEnd` (card balances negative, available positive; 0 = covered).
- Donor exclusions: hidden, deleted, `internal`, the Credit Card Payments group, and any red category. Excess = `balance - goal_target` when a target exists (`goal_type != null`), else `balance`; only positive excess qualifies.
- Card→payment-category matching is by normalized name (trim, collapse whitespace, casefold) within the Credit Card Payments group; unmatched cards produce a `warnings` entry, never a silent drop.
- ≤ 3 donor slices per red category; otherwise one RTA draw; RTA insufficient → the whole red goes to `unfundable` (no silent partial funding).
- Tool count becomes exactly 30; README tool table updated to match.

## File Structure

```
packages/core/src/month-close.ts        # pure: raw types, as-of math, blockers, matching, reds, donors, proposer
packages/core/test/month-close.test.ts  # pure-function tests (no client)
packages/core/src/domain.ts             # + monthClose(), proposeCoverage() wrappers (fetch + dollars)
packages/core/test/domain-month-close.test.ts  # fake-client wrapper tests incl. cutoff=today identity
apps/mcp/src/tools.ts                   # + 2 tool entries
apps/mcp/test/server.test.ts            # tool count 28 → 30
README.md                               # tool table + count
```

---

### Task 1: Pure as-of math + blockers (`month-close.ts` part 1)

**Files:**
- Create: `packages/core/src/month-close.ts`
- Test: `packages/core/test/month-close.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './month-close.js'`)

**Interfaces:**
- Consumes: nothing from the codebase (pure).
- Produces (later tasks rely on these exact names):
```ts
export interface RawAccount { id: string; name: string; type: string; on_budget: boolean; closed: boolean; deleted: boolean; balance: number; cleared_balance: number }
export interface RawSub { id: string; amount: number; category_id: string | null; transfer_account_id: string | null; deleted: boolean }
export interface RawTxn { id: string; date: string; amount: number; cleared: 'cleared' | 'uncleared' | 'reconciled'; approved: boolean; account_id: string; account_name?: string; payee_name?: string | null; category_id: string | null; transfer_account_id: string | null; deleted: boolean; subtransactions?: RawSub[] }
export interface RawMonthCat { id: string; name: string; category_group_name?: string; hidden: boolean; deleted: boolean; internal?: boolean; balance: number; goal_type?: string | null; goal_target?: number | null }
export function asOfBalances(accounts: RawAccount[], txns: RawTxn[], cutoff: string): Map<string, { workingMilli: number; clearedMilli: number }>
export function findBlockers(txns: RawTxn[], cutoff: string, onBudgetIds: Set<string>): { unapproved: RawTxn[]; uncategorized: RawTxn[]; unclearedBeforeCutoff: RawTxn[] }
```
Semantics: `asOfBalances` = per account, `working = balance − Σ parent amounts dated > cutoff`, `cleared = cleared_balance − Σ CLEARED (incl. reconciled) parent amounts dated > cutoff`; deleted txns skipped. `findBlockers` looks at non-deleted txns with `date <= cutoff` in on-budget accounts only: `unapproved` = `!approved`; `unclearedBeforeCutoff` = `cleared === 'uncleared'`; `uncategorized` = parent with `category_id === null && transfer_account_id === null && no live subtransactions`, OR any live sub with `category_id === null && transfer_account_id === null` (report the parent once).

- [ ] **Step 1: Write failing tests**

`packages/core/test/month-close.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { asOfBalances, findBlockers, type RawAccount, type RawTxn } from '../src/month-close.js'

const acct = (o: Partial<RawAccount> = {}): RawAccount => ({
  id: 'a1', name: 'Citi Card', type: 'creditCard', on_budget: true, closed: false, deleted: false,
  balance: -3291760, cleared_balance: -3100000, ...o,
})
const txn = (o: Partial<RawTxn> = {}): RawTxn => ({
  id: Math.random().toString(36).slice(2), date: '2026-07-15', amount: -10000, cleared: 'cleared',
  approved: true, account_id: 'a1', payee_name: 'P', category_id: 'c1', transfer_account_id: null,
  deleted: false, ...o,
})

describe('asOfBalances', () => {
  it('backs post-cutoff transactions out of current balances', () => {
    const txns = [
      txn({ date: '2026-08-02', amount: -50000 }),                       // after cutoff, cleared
      txn({ date: '2026-08-03', amount: -25000, cleared: 'uncleared' }), // after cutoff, uncleared
      txn({ date: '2026-07-30', amount: -99000 }),                       // before cutoff — irrelevant
    ]
    const m = asOfBalances([acct()], txns, '2026-07-31')
    // working backs out ALL post-cutoff: -3291760 - (-75000) = -3216760
    // cleared backs out only cleared post-cutoff: -3100000 - (-50000) = -3050000
    expect(m.get('a1')).toEqual({ workingMilli: -3216760, clearedMilli: -3050000 })
  })
  it('sums parent amounts only (splits do not double-count) and skips deleted', () => {
    const split = txn({ date: '2026-08-01', amount: -30000, subtransactions: [
      { id: 's1', amount: -10000, category_id: 'c1', transfer_account_id: null, deleted: false },
      { id: 's2', amount: -20000, category_id: 'c2', transfer_account_id: null, deleted: false },
    ] })
    const dead = txn({ date: '2026-08-01', amount: -999000, deleted: true })
    const m = asOfBalances([acct()], [split, dead], '2026-07-31')
    expect(m.get('a1')!.workingMilli).toBe(-3291760 + 30000)
  })
  it('reconciled counts as cleared for the cleared back-out', () => {
    const m = asOfBalances([acct()], [txn({ date: '2026-08-01', amount: -7000, cleared: 'reconciled' })], '2026-07-31')
    expect(m.get('a1')!.clearedMilli).toBe(-3100000 + 7000)
  })
})

describe('findBlockers', () => {
  const onBudget = new Set(['a1'])
  it('flags unapproved, uncleared, and uncategorized before cutoff; ignores after-cutoff rows', () => {
    const txns = [
      txn({ id: 'u1', approved: false }),
      txn({ id: 'u2', cleared: 'uncleared' }),
      txn({ id: 'u3', category_id: null }),
      txn({ id: 'after', date: '2026-08-05', approved: false, cleared: 'uncleared', category_id: null }),
    ]
    const b = findBlockers(txns, '2026-07-31', onBudget)
    expect(b.unapproved.map((t) => t.id)).toEqual(['u1'])
    expect(b.unclearedBeforeCutoff.map((t) => t.id)).toEqual(['u2'])
    expect(b.uncategorized.map((t) => t.id)).toEqual(['u3'])
  })
  it('transfers are never uncategorized; a split with one uncategorized leg is; tracking accounts are skipped', () => {
    const transfer = txn({ id: 'tr', category_id: null, transfer_account_id: 'other' })
    const badSplit = txn({ id: 'sp', category_id: null, subtransactions: [
      { id: 's1', amount: -5000, category_id: 'c1', transfer_account_id: null, deleted: false },
      { id: 's2', amount: -5000, category_id: null, transfer_account_id: null, deleted: false },
    ] })
    const okSplitDeadLeg = txn({ id: 'ok', category_id: null, subtransactions: [
      { id: 's3', amount: -5000, category_id: 'c1', transfer_account_id: null, deleted: false },
      { id: 's4', amount: -5000, category_id: null, transfer_account_id: null, deleted: true },
    ] })
    const tracking = txn({ id: 'tk', account_id: 'a9', category_id: null })
    const b = findBlockers([transfer, badSplit, okSplitDeadLeg, tracking], '2026-07-31', new Set(['a1']))
    expect(b.uncategorized.map((t) => t.id)).toEqual(['sp'])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -F @walensis/mcp-for-ynab-core test month-close` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/month-close.ts`:
```ts
export interface RawAccount { id: string; name: string; type: string; on_budget: boolean; closed: boolean; deleted: boolean; balance: number; cleared_balance: number }
export interface RawSub { id: string; amount: number; category_id: string | null; transfer_account_id: string | null; deleted: boolean }
export interface RawTxn { id: string; date: string; amount: number; cleared: 'cleared' | 'uncleared' | 'reconciled'; approved: boolean; account_id: string; account_name?: string; payee_name?: string | null; category_id: string | null; transfer_account_id: string | null; deleted: boolean; subtransactions?: RawSub[] }
export interface RawMonthCat { id: string; name: string; category_group_name?: string; hidden: boolean; deleted: boolean; internal?: boolean; balance: number; goal_type?: string | null; goal_target?: number | null }

const isCleared = (t: RawTxn) => t.cleared === 'cleared' || t.cleared === 'reconciled'

export function asOfBalances(accounts: RawAccount[], txns: RawTxn[], cutoff: string): Map<string, { workingMilli: number; clearedMilli: number }> {
  const out = new Map(accounts.map((a) => [a.id, { workingMilli: a.balance, clearedMilli: a.cleared_balance }]))
  for (const t of txns) {
    if (t.deleted || t.date <= cutoff) continue
    const entry = out.get(t.account_id)
    if (!entry) continue
    entry.workingMilli -= t.amount
    if (isCleared(t)) entry.clearedMilli -= t.amount
  }
  return out
}

export function findBlockers(txns: RawTxn[], cutoff: string, onBudgetIds: Set<string>) {
  const unapproved: RawTxn[] = []
  const uncategorized: RawTxn[] = []
  const unclearedBeforeCutoff: RawTxn[] = []
  for (const t of txns) {
    if (t.deleted || t.date > cutoff || !onBudgetIds.has(t.account_id)) continue
    if (!t.approved) unapproved.push(t)
    if (t.cleared === 'uncleared') unclearedBeforeCutoff.push(t)
    const liveSubs = (t.subtransactions ?? []).filter((s) => !s.deleted)
    const parentUncat = t.category_id === null && t.transfer_account_id === null && liveSubs.length === 0
    const subUncat = liveSubs.some((s) => s.category_id === null && s.transfer_account_id === null)
    if (parentUncat || subUncat) uncategorized.push(t)
  }
  return { unapproved, uncategorized, unclearedBeforeCutoff }
}
```
Add `export * from './month-close.js'` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** — `git add -A && git commit -m "feat(core): month-close as-of balances and blockers (pure)"`

---

### Task 2: Card matching, red categories, donor ranking (`month-close.ts` part 2)

**Files:**
- Modify: `packages/core/src/month-close.ts`
- Test: `packages/core/test/month-close.test.ts` (append)

**Interfaces:**
- Consumes: `RawAccount`, `RawMonthCat` from Task 1.
- Produces:
```ts
export const CC_GROUP = 'Credit Card Payments'
export function matchCards(accounts: RawAccount[], monthCats: RawMonthCat[]): { matches: { account: RawAccount; category: RawMonthCat }[]; warnings: string[] }
export function findRedCategories(monthCats: RawMonthCat[]): RawMonthCat[]
export function rankDonors(monthCats: RawMonthCat[], excludeIds: Set<string>): { cat: RawMonthCat; excessMilli: number }[]
```
Semantics: `matchCards` considers non-closed, non-deleted accounts with `type === 'creditCard'`; match against non-deleted month categories whose `category_group_name === CC_GROUP` by normalized name (`s.trim().replace(/\s+/g, ' ').toLowerCase()`); each unmatched card yields `warnings` entry `` `No payment category found for credit card account "${name}" — it is NOT covered by this report.` ``. `findRedCategories` = non-hidden, non-deleted, non-`internal`, group ≠ CC_GROUP, `balance < 0`. `rankDonors` = same base filter, `balance > 0`, id not in `excludeIds`; `excessMilli = goal_type != null ? balance - (goal_target ?? 0) : balance`, keep only `excessMilli > 0`, sort descending.

- [ ] **Step 1: Write failing tests** (append to `month-close.test.ts`)

```ts
import { matchCards, findRedCategories, rankDonors, type RawMonthCat } from '../src/month-close.js'

const cat = (o: Partial<RawMonthCat> = {}): RawMonthCat => ({
  id: Math.random().toString(36).slice(2), name: 'X', category_group_name: 'Bills', hidden: false,
  deleted: false, internal: false, balance: 0, goal_type: null, goal_target: null, ...o,
})

describe('matchCards', () => {
  it('matches by normalized name in the CC Payments group and warns on misses', () => {
    const cards = [acct({ id: 'a1', name: ' Citi  Card ' }), acct({ id: 'a2', name: 'Amex' }), acct({ id: 'a3', name: 'Closed', closed: true })]
    const cats = [cat({ id: 'p1', name: 'citi card', category_group_name: 'Credit Card Payments' }), cat({ id: 'nope', name: 'Amex', category_group_name: 'Bills' })]
    const { matches, warnings } = matchCards(cards, cats)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ account: { id: 'a1' }, category: { id: 'p1' } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Amex/)
  })
})

describe('findRedCategories / rankDonors', () => {
  const cats = [
    cat({ id: 'red', name: 'Kid Things', balance: -348170 }),
    cat({ id: 'ccred', name: 'Visa', category_group_name: 'Credit Card Payments', balance: -100000 }),
    cat({ id: 'int', name: 'Deferred', internal: true, balance: -5000 }),
    cat({ id: 'hid', name: 'Hidden', hidden: true, balance: -5000 }),
    cat({ id: 'd1', name: 'Dining', balance: 412000 }),
    cat({ id: 'd2', name: 'Vacation', balance: 900000, goal_type: 'NEED', goal_target: 600000 }),
    cat({ id: 'd3', name: 'Fully needed', balance: 100000, goal_type: 'NEED', goal_target: 100000 }),
  ]
  it('reds exclude CC payments, internal, hidden', () => {
    expect(findRedCategories(cats).map((c) => c.id)).toEqual(['red'])
  })
  it('donors rank by excess (target-aware), excluding reds and non-positive excess', () => {
    const donors = rankDonors(cats, new Set(['red']))
    expect(donors.map((d) => [d.cat.id, d.excessMilli])).toEqual([['d1', 412000], ['d2', 300000]])
  })
})
```

- [ ] **Step 2: Verify failure, implement** (append to `month-close.ts`)

```ts
export const CC_GROUP = 'Credit Card Payments'
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const isLive = (c: RawMonthCat) => !c.hidden && !c.deleted && !c.internal

export function matchCards(accounts: RawAccount[], monthCats: RawMonthCat[]) {
  const payCats = new Map(monthCats.filter((c) => !c.deleted && c.category_group_name === CC_GROUP).map((c) => [norm(c.name), c]))
  const matches: { account: RawAccount; category: RawMonthCat }[] = []
  const warnings: string[] = []
  for (const a of accounts) {
    if (a.closed || a.deleted || a.type !== 'creditCard') continue
    const category = payCats.get(norm(a.name))
    if (category) matches.push({ account: a, category })
    else warnings.push(`No payment category found for credit card account "${a.name}" — it is NOT covered by this report.`)
  }
  return { matches, warnings }
}

export function findRedCategories(monthCats: RawMonthCat[]): RawMonthCat[] {
  return monthCats.filter((c) => isLive(c) && c.category_group_name !== CC_GROUP && c.balance < 0)
}

export function rankDonors(monthCats: RawMonthCat[], excludeIds: Set<string>) {
  return monthCats
    .filter((c) => isLive(c) && c.category_group_name !== CC_GROUP && c.balance > 0 && !excludeIds.has(c.id))
    .map((cat) => ({ cat, excessMilli: cat.goal_type != null ? cat.balance - (cat.goal_target ?? 0) : cat.balance }))
    .filter((d) => d.excessMilli > 0)
    .sort((a, b) => b.excessMilli - a.excessMilli)
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit** — `git commit -am "feat(core): card/payment-category matching, reds, donor ranking"`

---

### Task 3: Coverage proposer (pure)

**Files:**
- Modify: `packages/core/src/month-close.ts`
- Test: `packages/core/test/month-close.test.ts` (append)

**Interfaces:**
- Consumes: `RawMonthCat`, `rankDonors` output shape.
- Produces:
```ts
export interface CoverageMove { fromId: string | null; fromName: string; toId: string; toName: string; amountMilli: number; source: 'category' | 'rta' }
export function proposeMoves(
  reds: RawMonthCat[],
  donors: { cat: RawMonthCat; excessMilli: number }[],
  rtaMilli: number,
  strategy: 'donors_first' | 'rta_only',
): { moves: CoverageMove[]; unfundable: { id: string; name: string; neededMilli: number }[]; rtaUsedMilli: number; rtaRemainingMilli: number }
```
Semantics: reds processed largest shortfall first. `rta_only`: each red draws its full need from RTA or goes to `unfundable` whole. `donors_first`: greedily take from ranked donors (mutating a working copy of each donor's remaining excess); if a red would need MORE THAN 3 donor slices, use zero donor slices for it and draw the whole need from RTA instead; if RTA (remaining) can't cover a red's full need, the red goes to `unfundable` whole (donor slices tentatively consumed for it are returned). Never partially fund a red.

- [ ] **Step 1: Write failing tests** (append)

```ts
import { proposeMoves } from '../src/month-close.js'

describe('proposeMoves', () => {
  const red = (id: string, name: string, balance: number) => cat({ id, name, balance })
  it('donors_first covers reds from ranked donors, then RTA, tagging sources', () => {
    const reds = [red('r1', 'Kid Things', -348170), red('r2', 'Medical', -172400)]
    const donors = [{ cat: cat({ id: 'd1', name: 'Dining Out' }), excessMilli: 348170 }]
    const res = proposeMoves(reds, donors, 7_178_050, 'donors_first')
    expect(res.moves).toEqual([
      { fromId: 'd1', fromName: 'Dining Out', toId: 'r1', toName: 'Kid Things', amountMilli: 348170, source: 'category' },
      { fromId: null, fromName: 'Ready to Assign', toId: 'r2', toName: 'Medical', amountMilli: 172400, source: 'rta' },
    ])
    expect(res.rtaUsedMilli).toBe(172400)
    expect(res.rtaRemainingMilli).toBe(7_178_050 - 172400)
    expect(res.unfundable).toEqual([])
  })
  it('caps at 3 donor slices per red — falls back to one RTA draw', () => {
    const reds = [red('r1', 'Big Red', -400000)]
    const donors = ['d1', 'd2', 'd3', 'd4'].map((id, i) => ({ cat: cat({ id, name: id }), excessMilli: 100000 + i }))
    const res = proposeMoves(reds, donors, 500000, 'donors_first')
    expect(res.moves).toHaveLength(1)
    expect(res.moves[0]).toMatchObject({ source: 'rta', amountMilli: 400000 })
  })
  it('never partially funds: insufficient donors+RTA puts the whole red in unfundable and frees donors for later reds', () => {
    const reds = [red('r1', 'Huge', -900000), red('r2', 'Small', -50000)]
    const donors = [{ cat: cat({ id: 'd1', name: 'D1' }), excessMilli: 60000 }]
    const res = proposeMoves(reds, donors, 100000, 'donors_first')
    expect(res.unfundable).toEqual([{ id: 'r1', name: 'Huge', neededMilli: 900000 }])
    // r2 still covered by the donor that r1 tentatively consumed
    expect(res.moves).toEqual([{ fromId: 'd1', fromName: 'D1', toId: 'r2', toName: 'Small', amountMilli: 50000, source: 'category' }])
    expect(res.rtaUsedMilli).toBe(0)
  })
  it('rta_only ignores donors entirely', () => {
    const res = proposeMoves([red('r1', 'R', -30000)], [{ cat: cat({ id: 'd1', name: 'D' }), excessMilli: 99000 }], 40000, 'rta_only')
    expect(res.moves).toEqual([{ fromId: null, fromName: 'Ready to Assign', toId: 'r1', toName: 'R', amountMilli: 30000, source: 'rta' }])
  })
})
```

- [ ] **Step 2: Verify failure, implement** (append)

```ts
export interface CoverageMove { fromId: string | null; fromName: string; toId: string; toName: string; amountMilli: number; source: 'category' | 'rta' }

export function proposeMoves(
  reds: RawMonthCat[],
  donors: { cat: RawMonthCat; excessMilli: number }[],
  rtaMilli: number,
  strategy: 'donors_first' | 'rta_only',
) {
  const moves: CoverageMove[] = []
  const unfundable: { id: string; name: string; neededMilli: number }[] = []
  const pool = donors.map((d) => ({ id: d.cat.id, name: d.cat.name, remaining: d.excessMilli }))
  let rtaRemaining = rtaMilli
  let rtaUsed = 0
  const sortedReds = [...reds].sort((a, b) => a.balance - b.balance) // most negative first

  for (const red of sortedReds) {
    const need = -red.balance
    const rtaDraw = (): boolean => {
      if (rtaRemaining < need) return false
      moves.push({ fromId: null, fromName: 'Ready to Assign', toId: red.id, toName: red.name, amountMilli: need, source: 'rta' })
      rtaRemaining -= need
      rtaUsed += need
      return true
    }
    if (strategy === 'rta_only') {
      if (!rtaDraw()) unfundable.push({ id: red.id, name: red.name, neededMilli: need })
      continue
    }
    // donors_first: tentatively slice donors, roll back if >3 slices or still short
    const slices: { donor: (typeof pool)[number]; take: number }[] = []
    let remaining = need
    for (const donor of pool) {
      if (remaining === 0 || slices.length === 3) break
      if (donor.remaining <= 0) continue
      const take = Math.min(donor.remaining, remaining)
      slices.push({ donor, take })
      remaining -= take
    }
    if (remaining === 0 && slices.length <= 3) {
      for (const { donor, take } of slices) {
        donor.remaining -= take
        moves.push({ fromId: donor.id, fromName: donor.name, toId: red.id, toName: red.name, amountMilli: take, source: 'category' })
      }
    } else if (!rtaDraw()) {
      unfundable.push({ id: red.id, name: red.name, neededMilli: need })
    }
  }
  return { moves, unfundable, rtaUsedMilli: rtaUsed, rtaRemainingMilli: rtaRemaining }
}
```
Note the tentative-slice design: slices are only committed (donor.remaining decremented / moves pushed) when the red is fully coverable within 3 slices — otherwise the pool is untouched and RTA/unfundable handles it. This is what the "frees donors for later reds" test pins.

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit** — `git commit -am "feat(core): coverage move proposer (donors_first / rta_only)"`

---

### Task 4: Domain wrappers `monthClose` + `proposeCoverage`

**Files:**
- Modify: `packages/core/src/domain.ts`
- Test: `packages/core/test/domain-month-close.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1–3; existing `milliToDollars`, `YnabClient`.
- Produces on `Ynab` (all output amounts in DOLLARS):
```ts
monthClose(planId: string, opts: { cutoff: string; lookbackDays?: number }): Promise<{
  cutoff: string
  warnings: string[]
  perCard: { account: string; workingAsOf: number; clearedAsOf: number; availableAtMonthEnd: number; gap: number; paymentCategoryId: string }[]
  blockers: { unapproved: BlockerRow[]; uncategorized: BlockerRow[]; unclearedBeforeCutoff: BlockerRow[] }
  redCategories: { id: string; name: string; available: number; group: string }[]
  donors: { id: string; name: string; group: string; available: number; excess: number; hasTarget: boolean }[]
}>  // BlockerRow = { id: string; date: string; payee: string | null; account: string; amount: number }
proposeCoverage(planId: string, opts: { cutoff: string; strategy?: 'donors_first' | 'rta_only' }): Promise<{
  moves: { from: string; fromId: string | null; to: string; toId: string; amount: number; source: 'category' | 'rta' }[]
  unfundable: { id: string; name: string; needed: number }[]
  rtaUsed: number
  rtaRemaining: number
}>
```
Mechanics: `lookbackDays` default 120, `Math.min(lookbackDays, 365)`. Month key = `cutoff.slice(0, 8) + '01'`. Three parallel GETs: `/plans/{p}/accounts`, `/plans/{p}/transactions?since_date=<cutoff − lookback>` (NO until_date), `/plans/{p}/months/{monthKey}`. RTA milli = the month response's `to_be_budgeted`. `gap = workingMilli + category.balance` computed in milli, converted once. Blocker rows are capped at 50 per list with a `warnings` entry when truncated (token safety).

- [ ] **Step 1: Write failing tests**

`packages/core/test/domain-month-close.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'

const accounts = { accounts: [
  { id: 'a1', name: 'Citi Card', type: 'creditCard', on_budget: true, closed: false, deleted: false, balance: -3291760, cleared_balance: -3291760 },
  { id: 'chk', name: 'Checking', type: 'checking', on_budget: true, closed: false, deleted: false, balance: 5000000, cleared_balance: 5000000 },
] }
const month = { month: { month: '2026-07-01', to_be_budgeted: 7178050, categories: [
  { id: 'p1', name: 'Citi Card', category_group_name: 'Credit Card Payments', hidden: false, deleted: false, internal: false, balance: 2662650, goal_type: null, goal_target: null },
  { id: 'r1', name: 'Kid Things', category_group_name: 'Just for Fun', hidden: false, deleted: false, internal: false, balance: -348170, goal_type: null, goal_target: null },
  { id: 'd1', name: 'Dining Out', category_group_name: 'Just for Fun', hidden: false, deleted: false, internal: false, balance: 412000, goal_type: null, goal_target: null },
] } }
const txns = { transactions: [
  { id: 'aug', date: '2026-08-02', amount: -50000, cleared: 'cleared', approved: true, account_id: 'a1', payee_name: 'Aug', category_id: 'c9', transfer_account_id: null, deleted: false, subtransactions: [] },
  { id: 'pend', date: '2026-07-20', amount: -42100, cleared: 'uncleared', approved: false, account_id: 'a1', payee_name: 'Pend', account_name: 'Citi Card', category_id: null, transfer_account_id: null, deleted: false, subtransactions: [] },
] }

function client() {
  return { request: vi.fn(async (path: string) => {
    if (path.endsWith('/accounts')) return accounts
    if (path.includes('/months/')) return month
    if (path.endsWith('/transactions')) return txns
    throw new Error(`unmocked ${path}`)
  }) } as any
}

describe('monthClose', () => {
  it('produces per-card gap in dollars with the spec sign convention', async () => {
    const c = client()
    const y = new Ynab({ client: c, allowWrites: false })
    const res = await y.monthClose('last-used', { cutoff: '2026-07-31' })
    // fetch contract: month key from cutoff; since_date = cutoff − 120d; NO until_date
    expect(c.request.mock.calls.some(([p]: any[]) => String(p).includes('/months/2026-07-01'))).toBe(true)
    const txnCall = c.request.mock.calls.find(([p]: any[]) => String(p).endsWith('/transactions'))!
    expect(txnCall[1].query).toEqual({ since_date: '2026-04-02' })
    const card = res.perCard[0]!
    // workingAsOf = -3291760 - (-50000) = -3241760 → -3241.76
    expect(card).toMatchObject({ account: 'Citi Card', workingAsOf: -3241.76, availableAtMonthEnd: 2662.65, paymentCategoryId: 'p1' })
    expect(card.gap).toBe(-579.11) // -3241.76 + 2662.65 — integer milli math, exact
    expect(res.blockers.unapproved.map((t) => t.id)).toEqual(['pend'])
    expect(res.blockers.uncategorized.map((t) => t.id)).toEqual(['pend'])
    expect(res.redCategories).toEqual([{ id: 'r1', name: 'Kid Things', available: -348.17, group: 'Just for Fun' }])
    expect(res.donors[0]).toMatchObject({ id: 'd1', excess: 412, hasTarget: false })
  })
  it('cutoff=today identity: workingAsOf equals current balance when nothing post-dates it', async () => {
    const y = new Ynab({ client: client(), allowWrites: false })
    const res = await y.monthClose('last-used', { cutoff: '2026-08-31' })
    expect(res.perCard[0]).toMatchObject({ workingAsOf: -3291.76, clearedAsOf: -3291.76 })
  })
  it('clamps lookback to 365 days', async () => {
    const c = { request: vi.fn(async (path: string, opts?: any) => {
      if (path.endsWith('/transactions')) { expect(opts.query.since_date).toBe('2025-07-31'); return { transactions: [] } }
      if (path.endsWith('/accounts')) return accounts
      return month
    }) } as any
    await new Ynab({ client: c, allowWrites: false }).monthClose('last-used', { cutoff: '2026-07-31', lookbackDays: 9999 })
  })
})

describe('proposeCoverage', () => {
  it('covers the red from the donor and reports RTA in dollars', async () => {
    const y = new Ynab({ client: client(), allowWrites: false })
    const res = await y.proposeCoverage('last-used', { cutoff: '2026-07-31' })
    expect(res.moves).toEqual([{ from: 'Dining Out', fromId: 'd1', to: 'Kid Things', toId: 'r1', amount: 348.17, source: 'category' }])
    expect(res.rtaUsed).toBe(0)
    expect(res.rtaRemaining).toBe(7178.05)
  })
})
```
(The shared `client()` fake carries no assertions — it answers any `/months/...` with the same fixture, so the `cutoff: '2026-08-31'` identity test works unchanged; fetch-contract assertions live inside test 1 via `mock.calls`.)

- [ ] **Step 2: Verify failure, implement in `domain.ts`**

```ts
import { asOfBalances, findBlockers, matchCards, findRedCategories, rankDonors, proposeMoves, type RawTxn, type RawAccount, type RawMonthCat } from './month-close.js'

const BLOCKER_CAP = 50

// inside class Ynab:
  async #monthCloseRaw(planId: string, cutoff: string, lookbackDays: number) {
    const lookback = Math.min(lookbackDays, 365)
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
    const { accounts, txns, monthCats, rtaMilli } = await this.#monthCloseRaw(planId, cutoff, opts.lookbackDays ?? 120)
    void rtaMilli
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
    return {
      cutoff,
      warnings,
      perCard,
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
    const { accounts, txns, monthCats, rtaMilli } = await this.#monthCloseRaw(planId, opts.cutoff, 120)
    void accounts; void txns
    const reds = findRedCategories(monthCats)
    const donors = rankDonors(monthCats, new Set(reds.map((c) => c.id)))
    const res = proposeMoves(reds, donors, rtaMilli, opts.strategy ?? 'donors_first')
    return {
      moves: res.moves.map((m) => ({ from: m.fromName, fromId: m.fromId, to: m.toName, toId: m.toId, amount: milliToDollars(m.amountMilli), source: m.source })),
      unfundable: res.unfundable.map((u) => ({ id: u.id, name: u.name, needed: milliToDollars(u.neededMilli) })),
      rtaUsed: milliToDollars(res.rtaUsedMilli),
      rtaRemaining: milliToDollars(res.rtaRemainingMilli),
    }
  }
```

- [ ] **Step 3: Run full core suite + typecheck** — PASS (rebuild core dist first if apps/mcp typecheck runs: `pnpm -F @walensis/mcp-for-ynab-core build`).
- [ ] **Step 4: Commit** — `git commit -am "feat(core): monthClose and proposeCoverage domain wrappers"`

---

### Task 5: Tool registration, count test, README

**Files:**
- Modify: `apps/mcp/src/tools.ts` (two entries, after `net_worth_history`, before `undo_last`)
- Modify: `apps/mcp/test/server.test.ts` (28 → 30)
- Modify: `README.md` (tool table + any "28" counts)

**Interfaces:**
- Consumes: `Ynab.monthClose` / `Ynab.proposeCoverage` (Task 4 signatures).

- [ ] **Step 1: Update the count test to 30 and add a call-through test** (in `server.test.ts`, RED first)

```ts
  it('month_close is registered read-only and returns the report', async () => {
    const fake = { request: vi.fn(async (path: string) => {
      if (path.endsWith('/accounts')) return { accounts: [] }
      if (path.endsWith('/transactions')) return { transactions: [] }
      return { month: { month: '2026-07-01', to_be_budgeted: 0, categories: [] } }
    }) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'month_close', arguments: { plan_id: 'p1', cutoff: '2026-07-31' } })
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(res.content[0].text).cutoff).toBe('2026-07-31')
  })
```
Change `expect(tools).toHaveLength(28)` → `30`.

- [ ] **Step 2: Verify failure, add tool entries**

```ts
  { name: 'month_close', description: 'READ-ONLY month-close report for a cutoff date (normally the closing month\'s last day): per-credit-card coverage (working & cleared as-of balances vs payment-category available at month end; gap 0 = covered), blockers (unapproved / uncategorized / uncleared before cutoff), overspent (red) categories, and ranked donor categories. Proposes nothing and moves nothing — pair with propose_coverage, then apply approved moves via move_money / assign_budget.', schema: { plan_id: planId, cutoff: z.string().describe("ISO date cutoff, e.g. '2026-07-31'"), lookback_days: z.number().int().max(365).optional().describe('straggler scan window, default 120') }, handler: (y, a) => y.monthClose(a.plan_id, { cutoff: a.cutoff, lookbackDays: a.lookback_days }) },
  { name: 'propose_coverage', description: 'READ-ONLY: ordered move proposals to bring every overspent category to zero for the cutoff month — donors first (max 3 donor slices per category) then Ready to Assign, RTA moves tagged source:"rta", anything uncoverable listed in unfundable. Applies nothing: review with the user, then execute approved moves via move_money (category→category) or assign_budget (RTA draws).', schema: { plan_id: planId, cutoff: z.string().describe('same cutoff passed to month_close'), strategy: z.enum(['donors_first', 'rta_only']).optional() }, handler: (y, a) => y.proposeCoverage(a.plan_id, { cutoff: a.cutoff, strategy: a.strategy }) },
```

- [ ] **Step 3: README** — add two rows to the tool table (Read type), update the "28 tools" phrasing to 30 wherever it appears (`grep -n "28" README.md`).
- [ ] **Step 4: Full workspace verify** — `pnpm -F @walensis/mcp-for-ynab-core build && pnpm test && pnpm typecheck && pnpm build` → all green (build core first — stale-dist gotcha).
- [ ] **Step 5: Commit** — `git commit -am "feat(mcp): month_close + propose_coverage tools (30 tools)"`

---

## Verification (end of plan — AJ, against the real budget)

Per the spec's validation section, via Claude Code or `pnpm smoke`-style script:
1. `month_close` with `cutoff` = today → each card's `workingAsOf` equals its current balance, `clearedAsOf` its cleared balance.
2. `cutoff` = last day of current month (no future-dated txns) → same equality.
3. Cross-check one card's `availableAtMonthEnd` against the YNAB web UI on the closing month.
4. A known card payment does not appear in `blockers.uncategorized`.
5. `propose_coverage` on the real July close → review the proposed moves for sanity before applying any.
