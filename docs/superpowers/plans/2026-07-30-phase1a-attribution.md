# Phase 1a: Attribution Engine + Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the §8 deterministic attribution classifier inline in `credit_card_float_history`, the `backfill_ledger` tool with the discovery summary (34 → 35 tools), and the corrected uncleared-investigation session copy. Spec: `docs/superpowers/specs/2026-07-30-phase1a-attribution-design.md`.

**Architecture:** New pure module `packages/core/src/attribution.ts` (integer milli, no I/O); `getCreditCardFloatHistory` feeds it data it already fetches and attaches `cause`/`evidence` to changed points; `backfillLedger` reuses the same computation, writes `kind:'backfill'` records via a new `LedgerStore.replaceBackfill`, and derives the discovery summary; session copy updated across the three synced files.

**Tech Stack:** existing (TypeScript strict ESM, vitest). No new dependencies.

## Global Constraints

- Attribution is pure and deterministic: integer milli, no API calls, no LLM, never force-fit — `unattributed` is a legitimate output. Tolerances: match epsilon 1000 milli; component floor 10 milli. Priority order exactly: assignment/drain → reversal/uncategorized-debt scan → absorption → residual.
- The spec's fixture table is BINDING: every row must be reproduced by a unit test, including the 2026-07 compound month (deliberate_cover 2,501.05 + uncovered_spending −29.77) and the corrected 2025-05 deliberate_cover.
- Float-history response changes are ADDITIVE (`changed:true` points gain `cause` + `evidence`; nothing existing changes shape). Evidence amounts in DOLLARS at the tool boundary; txn evidence carries `{id, date, amount}`.
- `backfill_ledger` writes ONLY the local ledger (never YNAB); re-runs replace prior `kind:'backfill'` records for the same plan+account; `kind:'close'` records are never touched by backfill. Existing ledger files without `kind` are treated as `'close'`.
- Backfill records: `cutoff` = real last day of each month; `clearedAsOf` = `workingAsOf` with the spec's honesty note. Discovery: `nonZeroSince` = first month of the current unbroken nonzero-gap run; `sinceAtLeast: true` when the run starts at the window edge.
- Session copy: three playbook copies stay verbatim-identical; uncleared copy changes to the investigation flow (clear-if-settled via update_transactions / delete-if-stale with user approval); `month_close` tool description updated to match. Sentinel tests keep passing.
- Exactly 35 tools at the end. All existing tests stay green.

## File Structure

```
packages/core/src/attribution.ts        # pure classifier (new)
packages/core/test/attribution.test.ts  # spec fixture table as tests (new)
packages/core/src/ledger.ts             # + kind field, replaceBackfill()
packages/core/src/domain.ts             # float-history inline attribution; backfillLedger()
packages/core/test/ledger.test.ts       # + kind/replace tests
packages/core/test/domain-category-history.test.ts  # + inline-cause and backfill tests
apps/mcp/src/tools.ts                   # + backfill_ledger (35); month_close description fix
apps/mcp/src/playbook.ts + docs/playbooks/month-close.md + .claude/skills/month-close/SKILL.md  # synced copy updates
apps/mcp/test/server.test.ts            # count 35; backfill call-through
README.md                               # 35; backfill row; session section touch-up
```

---

### Task 1: Attribution classifier (pure) + binding fixture suite

**Files:**
- Create: `packages/core/src/attribution.ts`, `packages/core/test/attribution.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces (later tasks rely on exact names):**
```ts
export type GapCause = 'deliberate_cover' | 'payment_category_drain' | 'payment_reversal' | 'uncategorized_debt' | 'overpayment_absorption' | 'uncovered_spending' | 'unattributed'
export interface AttributionComponent { cause: GapCause; amountMilli: number; evidence: { assignedMilli?: number; priorRedMilli?: number; txns?: { id: string; date: string; amountMilli: number }[]; residualMilli?: number } }
export interface AttributedChange { month: string; gapChangeMilli: number; components: AttributionComponent[] }
export interface AttributionMonthInput { month: string; gapChangeMilli: number; availableMilli: number; assignedMilli: number }
export function attributeChanges(points: AttributionMonthInput[], cardTxns: { id: string; date: string; amount: number; category_id: string | null; transfer_account_id: string | null; deleted?: boolean }[]): AttributedChange[]
```
Semantics (spec classifier, exactly): points ascending; for each with `|gapChangeMilli| > 10`, build components; `remaining = gapChangeMilli`.
1. `assignedMilli > 0` → `deliberate_cover` component `{amountMilli: assignedMilli, evidence: {assignedMilli}}`, `remaining -= assignedMilli`; `< 0` → `payment_category_drain` likewise. Skip if `|remaining| <= 10` after.
2. Reversal scan (only when `|remaining| > 10`): candidate txns = non-deleted card txns with date in `[month-01 − 30d, monthEnd + 30d]`. Group by `Math.abs(amount)`; for each group with ≥ 2 members whose |amount| differs from `|remaining|` by ≤ 1000 and whose NET sum ≈ `−remaining` (±1000): emit `payment_reversal` `{amountMilli: −net, evidence: {txns}}`, `remaining += net`, stop scanning. Else: categoryless owed-increasing transfers (amount < 0, category_id null, transfer_account_id non-null, same window) whose sum ≈ `remaining` (±1000) → `uncategorized_debt` `{amountMilli: sum, evidence: {txns}}`, `remaining -= sum`.
3. Absorption (when `|remaining| > 10`): previous point's `availableMilli < 0` and `|remaining − (−prevAvailable)| ≤ 1000` → `overpayment_absorption` `{amountMilli: −prevAvailable, evidence: {priorRedMilli: prevAvailable}}`, `remaining -= −prevAvailable`.
4. Residual: `remaining < −10` → `uncovered_spending` `{amountMilli: remaining, evidence: {residualMilli: remaining}}`; `remaining > 10` → `unattributed` `{amountMilli: remaining, evidence: {residualMilli: remaining}}`. If the components list is still empty (nothing matched at all), the single component is `unattributed` with the full change.

- [ ] **Step 1: Write the failing fixture suite** — `packages/core/test/attribution.test.ts` encoding the spec table verbatim:

```ts
import { describe, it, expect } from 'vitest'
import { attributeChanges, type AttributionMonthInput } from '../src/attribution.js'

const pt = (month: string, gapChangeMilli: number, availableMilli: number, assignedMilli = 0): AttributionMonthInput =>
  ({ month, gapChangeMilli, availableMilli, assignedMilli })

describe('attributeChanges — §12 fixture table (binding)', () => {
  it('flat run produces zero change-points', () => {
    const flat = ['2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02'].map((m) => pt(m, 0, -865750))
    expect(attributeChanges(flat, [])).toEqual([])
  })
  it('2025-03: absorption of the Feb red', () => {
    const res = attributeChanges([pt('2025-02', 0, -3660), pt('2025-03', 3660, 102670)], [])
    expect(res).toHaveLength(1)
    expect(res[0]!.components).toEqual([{ cause: 'overpayment_absorption', amountMilli: 3660, evidence: { priorRedMilli: -3660 } }])
  })
  it('2025-05: deliberate cover (brief-corrected from unattributed)', () => {
    const res = attributeChanges([pt('2025-04', 0, 766270), pt('2025-05', 7320, 2094240, 7320)], [])
    expect(res[0]!.components).toEqual([{ cause: 'deliberate_cover', amountMilli: 7320, evidence: { assignedMilli: 7320 } }])
  })
  it('2025-12: absorption of the Nov red', () => {
    const res = attributeChanges([pt('2025-11', 0, -189490), pt('2025-12', 189490, 3223110)], [])
    expect(res[0]!.components).toEqual([{ cause: 'overpayment_absorption', amountMilli: 189490, evidence: { priorRedMilli: -189490 } }])
  })
  it('2026-04: the reversal trio', () => {
    const trio = [
      { id: 'pay1', date: '2026-04-10', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
      { id: 'rev1', date: '2026-04-15', amount: -3322550, category_id: null, transfer_account_id: null },
      { id: 'pay2', date: '2026-04-17', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
    ]
    const res = attributeChanges([pt('2026-03', 0, 6966920), pt('2026-04', -3322550, 1417170)], trio)
    expect(res[0]!.components).toHaveLength(1)
    const c = res[0]!.components[0]!
    expect(c.cause).toBe('payment_reversal')
    expect(c.amountMilli).toBe(-3322550)
    expect(c.evidence.txns!.map((t) => t.id).sort()).toEqual(['pay1', 'pay2', 'rev1'])
  })
  it('2026-06: deliberate cover, exact', () => {
    const res = attributeChanges([pt('2026-05', 0, 1101370), pt('2026-06', 1516550, 0, 1516550)], [])
    expect(res[0]!.components).toEqual([{ cause: 'deliberate_cover', amountMilli: 1516550, evidence: { assignedMilli: 1516550 } }])
  })
  it('2026-07: compound — cover 2501.05 plus uncovered spending −29.77', () => {
    const res = attributeChanges([pt('2026-06', 0, 0), pt('2026-07', 2471280, 1350960, 2501050)], [])
    expect(res[0]!.components).toEqual([
      { cause: 'deliberate_cover', amountMilli: 2501050, evidence: { assignedMilli: 2501050 } },
      { cause: 'uncovered_spending', amountMilli: -29770, evidence: { residualMilli: -29770 } },
    ])
  })
  it('synthetic: honest unattributed when nothing matches', () => {
    const res = attributeChanges([pt('2026-01', 0, 500000), pt('2026-02', 7320, 507320)], [])
    expect(res[0]!.components).toEqual([{ cause: 'unattributed', amountMilli: 7320, evidence: { residualMilli: 7320 } }])
  })
  it('uncategorized owed-side debt: categoryless transfer matches the change', () => {
    const cashAdvance = [{ id: 'ca1', date: '2026-05-10', amount: -400000, category_id: null, transfer_account_id: 'chk' }]
    const res = attributeChanges([pt('2026-04', 0, 100000), pt('2026-05', -400000, 100000)], cashAdvance)
    expect(res[0]!.components[0]).toMatchObject({ cause: 'uncategorized_debt', amountMilli: -400000 })
    expect(res[0]!.components[0]!.evidence.txns![0]!.id).toBe('ca1')
  })
})
```

- [ ] **Step 2: Verify RED** (`pnpm -F @walensis/mcp-for-ynab-core test attribution` → module not found).

- [ ] **Step 3: Implement `attribution.ts`** per Interfaces:

```ts
const EPS = 1000
const FLOOR = 10
const DAY = 86_400_000

export type GapCause = 'deliberate_cover' | 'payment_category_drain' | 'payment_reversal' | 'uncategorized_debt' | 'overpayment_absorption' | 'uncovered_spending' | 'unattributed'
export interface AttributionComponent { cause: GapCause; amountMilli: number; evidence: { assignedMilli?: number; priorRedMilli?: number; txns?: { id: string; date: string; amountMilli: number }[]; residualMilli?: number } }
export interface AttributedChange { month: string; gapChangeMilli: number; components: AttributionComponent[] }
export interface AttributionMonthInput { month: string; gapChangeMilli: number; availableMilli: number; assignedMilli: number }
interface CardTxn { id: string; date: string; amount: number; category_id: string | null; transfer_account_id: string | null; deleted?: boolean }

const near = (a: number, b: number) => Math.abs(a - b) <= EPS

function windowTxns(txns: CardTxn[], month: string): CardTxn[] {
  const start = new Date(Date.parse(`${month}-01`) - 30 * DAY).toISOString().slice(0, 10)
  const end = new Date(Date.parse(`${month}-28`) + 33 * DAY).toISOString().slice(0, 10)
  return txns.filter((t) => !t.deleted && t.date >= start && t.date <= end)
}

export function attributeChanges(points: AttributionMonthInput[], cardTxns: CardTxn[]): AttributedChange[] {
  const out: AttributedChange[] = []
  points.forEach((p, i) => {
    if (Math.abs(p.gapChangeMilli) <= FLOOR) return
    const components: AttributionComponent[] = []
    let remaining = p.gapChangeMilli

    if (p.assignedMilli > 0) {
      components.push({ cause: 'deliberate_cover', amountMilli: p.assignedMilli, evidence: { assignedMilli: p.assignedMilli } })
      remaining -= p.assignedMilli
    } else if (p.assignedMilli < 0) {
      components.push({ cause: 'payment_category_drain', amountMilli: p.assignedMilli, evidence: { assignedMilli: p.assignedMilli } })
      remaining -= p.assignedMilli
    }

    if (Math.abs(remaining) > FLOOR) {
      const win = windowTxns(cardTxns, p.month)
      // reversal sets: equal-|amount| groups whose net ≈ −remaining and |amount| ≈ |remaining|
      const groups = new Map<number, CardTxn[]>()
      for (const t of win) {
        const key = Math.abs(t.amount)
        groups.set(key, [...(groups.get(key) ?? []), t])
      }
      let matched = false
      for (const [absAmount, members] of groups) {
        if (members.length < 2 || !near(absAmount, Math.abs(remaining))) continue
        const net = members.reduce((s, t) => s + t.amount, 0)
        if (near(net, -remaining)) {
          components.push({ cause: 'payment_reversal', amountMilli: -net, evidence: { txns: members.map((t) => ({ id: t.id, date: t.date, amountMilli: t.amount })) } })
          remaining += net
          matched = true
          break
        }
      }
      if (!matched) {
        const debts = win.filter((t) => t.amount < 0 && t.category_id === null && t.transfer_account_id !== null)
        const sum = debts.reduce((s, t) => s + t.amount, 0)
        if (debts.length > 0 && near(sum, remaining)) {
          components.push({ cause: 'uncategorized_debt', amountMilli: sum, evidence: { txns: debts.map((t) => ({ id: t.id, date: t.date, amountMilli: t.amount })) } })
          remaining -= sum
        }
      }
    }

    if (Math.abs(remaining) > FLOOR && i > 0) {
      const prev = points[i - 1]!
      if (prev.availableMilli < 0 && near(remaining, -prev.availableMilli)) {
        components.push({ cause: 'overpayment_absorption', amountMilli: -prev.availableMilli, evidence: { priorRedMilli: prev.availableMilli } })
        remaining -= -prev.availableMilli
      }
    }

    if (remaining < -FLOOR) components.push({ cause: 'uncovered_spending', amountMilli: remaining, evidence: { residualMilli: remaining } })
    else if (remaining > FLOOR) components.push({ cause: 'unattributed', amountMilli: remaining, evidence: { residualMilli: remaining } })

    out.push({ month: p.month, gapChangeMilli: p.gapChangeMilli, components })
  })
  return out
}
```
Export from `index.ts`. NOTE the trio test's `pay1/pay2` have `transfer_account_id` set and negative-`amount` filter keeps them out of the `uncategorized_debt` branch — the equal-|amount| reversal branch catches all three first.

- [ ] **Step 4: GREEN** — all fixture rows pass. **Step 5: Commit** — `git commit -am "feat(core): §8 attribution classifier with binding §12 fixture suite"`

---

### Task 2: Inline attribution in `credit_card_float_history`

**Files:**
- Modify: `packages/core/src/domain.ts` (float wrapper), `packages/core/test/domain-category-history.test.ts`

**Interfaces:**
- Float response points where `changed === true` gain `cause: GapCause` (primary = first component's cause; when multiple components, `cause` is the LARGEST |amountMilli| component's cause) and `evidence: { components: [{cause, amount (dollars), assigned?, priorRed?, residual?, txns?: [{id,date,amount}] }] }` — full component list in dollars. Unchanged points get neither key.

- [ ] **Step 1: Failing test** (extend the float test in `domain-category-history.test.ts`): using the existing fixture (2026-06 flat→2026-07 grew −200 →2026-08 shrank +200), extend the month fixture so 2026-08's category has `budgeted: 200000` (assigned $200) — then assert:
```ts
    const grew = res.points.find((p: any) => p.month === '2026-07')!
    expect(grew.cause).toBe('uncovered_spending')
    expect(grew.evidence.components[0]).toMatchObject({ cause: 'uncovered_spending', amount: -200 })
    const shrank = res.points.find((p: any) => p.month === '2026-08')!
    expect(shrank.cause).toBe('deliberate_cover')
    expect(res.points.find((p: any) => p.month === '2026-06')!.cause).toBeUndefined()
```
(Adapt the fake month responses so `budgeted` is present per month: the shared fake returns `budgeted: 0` today — parameterize by month like `balance` already is.)

- [ ] **Step 2: Implement** — in `getCreditCardFloatHistory`: `#categoryHistoryMilli` already returns `assignedMilli` per point. Build `AttributionMonthInput[]` from the float series (month, gapChangeMilli from `floatSeries` output, availableMilli, assignedMilli), call `attributeChanges(inputs, txnsData.transactions)`, index by month, and when mapping points: for changed points attach `cause` (largest-|amount| component) and `evidence.components` (dollars via `milliToDollars`, txn amounts too). Static import from `./attribution.js`.

- [ ] **Step 3: Full verify (build core first).** **Step 4: Commit** — `git commit -am "feat(core): inline §8 attribution on float-history change points"`

---

### Task 3: Ledger `kind` + `replaceBackfill` + `backfill_ledger` tool (35)

**Files:**
- Modify: `packages/core/src/ledger.ts`, `packages/core/test/ledger.test.ts`, `packages/core/src/domain.ts`, `packages/core/test/domain-category-history.test.ts`, `apps/mcp/src/tools.ts`, `apps/mcp/test/server.test.ts`

**Interfaces:**
```ts
// ledger.ts additions
export interface MonthCloseRecord { /* existing */ kind?: 'close' | 'backfill' }  // absent = 'close'
// append() accepts kind; replaceBackfill(planId: string, account: string, records: Omit<MonthCloseRecord,'id'|'recordedAt'>[]): MonthCloseRecord[]
//   — removes ALL existing kind==='backfill' records with matching planId AND perCard[0].account, then appends the new ones (each kind:'backfill'); returns them.
// list(opts) gains kind?: 'close' | 'backfill' filter.

// domain.ts
backfillLedger(planId: string, opts: { paymentCategoryId: string; cardAccountId: string; sinceMonth: string; untilMonth?: string }): Promise<{
  account: string
  monthsWritten: number
  discovery: { currentGap: number; nonZeroSince: string | null; sinceAtLeast: boolean; summary: string }
  changePoints: { month: string; gapChange: number; cause: GapCause }[]
}>
```
Mechanics: `untilMonth` defaults to the current month (UTC). Runs the same fetch+floatSeries+attributeChanges pipeline as the float wrapper (factor a private helper `#attributedFloat(planId, opts)` both call — returns the milli series, attribution, account, raw fetch products). One record per point: `{ kind: 'backfill', planId, cutoff: lastDayOf(month), gapStatus: 'final', perCard: [{ account, workingAsOf: −owed, clearedAsOf: −owed, availableAtMonthEnd, gap }], blockers: {0,0,0}, causes: [that month's components → {month, change, cause}], note: 'backfill: cleared state not reconstructable historically' }` written via `replaceBackfill`. `lastDayOf('2026-02')` = real month end (`new Date(Date.UTC(y, m, 0))`). Discovery: walk the gap series backward from the newest point while `|gap| > 5` milli; `nonZeroSince` = oldest month of that unbroken run (null when current gap ≈ 0); `sinceAtLeast` = run reaches the window's first point. `summary` = one sentence, e.g. `"You've been carrying $865.75 of float since at least 2024-08."` / `"Card is covered as of 2026-07."`
Tool: `backfill_ledger` — description: `"Backfill the LOCAL balance-forward ledger from history (writes ~/.mcp-for-ynab/ledger.json only — never touches YNAB): one record per month for a card with gap, causes, and the discovery summary ('carrying $X since <date>'). Re-runs replace prior backfill records for the same card; real close records are never touched. Run once per card at first setup; costs ~one API call per month."` — schema mirrors `credit_card_float_history` params. NOT write-gated.

- [ ] **Step 1: Failing tests** — ledger: `append` defaults kind 'close'; `replaceBackfill` removes only matching backfill records (seed: one close + two backfill for account A + one backfill for account B; replace A with one new record → list shows close + B + new A); `list({kind})` filters. Domain: backfill test on the existing float fake (3 months) → asserts `monthsWritten: 3`, record cutoffs `['2026-06-30','2026-07-31','2026-08-31']` via a temp LedgerStore, discovery `{currentGap: 0, nonZeroSince: null}` shape and a second scenario (make 2026-08 balance produce nonzero gap) asserting `nonZeroSince`/`sinceAtLeast`. Server: count 35 + call-through.
- [ ] **Step 2: Implement** per Interfaces (factor `#attributedFloat`; keep `getCreditCardFloatHistory` behavior identical — its tests must not change except additive attribution fields from Task 2).
- [ ] **Step 3: Full verify.** **Step 4: Commit** — `git commit -am "feat: backfill_ledger with discovery summary + ledger kinds (35 tools)"`

---

### Task 4: Uncleared-investigation copy + README

**Files:**
- Modify: `docs/playbooks/month-close.md`, `apps/mcp/src/playbook.ts`, `.claude/skills/month-close/SKILL.md` (verbatim-identical edits), `apps/mcp/src/tools.ts` (month_close description), `apps/mcp/test/server.test.ts` (sentinels if touched), `README.md`

- [ ] **Step 1: Playbook edits (all three copies, identical):**
  - Step 1 sentence "Uncleared-before-cutoff rows are for the reconciliation step — note them, don't force them." → `Uncleared-before-cutoff rows need INVESTIGATION, not force: uncleared is YNAB register state, not "pending at the bank". For each one, either it settled (mark it cleared via update_transactions) or it never happened and is corrupting the gap (delete_transaction, with the user's approval). Walk them with the user.`
  - Step 2's caveat sentence "If only `unclearedBeforeCutoff` blockers remain (transactions still pending at the bank), the gap stays provisional — present it WITH that caveat and continue; never force-clear transactions to chase a "final" status." → `"Final" is reached by cleaning the register, not by waiting: resolve every uncleared-before-cutoff row per step 1's investigation. Only present a provisional gap if the user explicitly defers an unresolved row — say so when you do.`
  - Step 3 first-run sentence gains: `On first run (empty ledger), run backfill_ledger for each card first — it writes the historical balance-forward records and returns the discovery summary ("carrying $X since <date>"); lead with that.`
- [ ] **Step 2: month_close description** — replace the trailing sentence "unclearedBeforeCutoff rows are bank-pending and cannot be forced: if only those remain, present the gap as provisional with that caveat." → `unclearedBeforeCutoff rows are register state needing investigation: settled → mark cleared via update_transactions; stale → delete_transaction (user-approved) — a stale entry corrupts workingAsOf.`
- [ ] **Step 3: README** — 34 → 35 sweep, `backfill_ledger` row (local write), one sentence in the session section about the first-run discovery.
- [ ] **Step 4: Verify copies identical** (diff extraction as before), full workspace verify, sentinel tests green (update the `PROVISIONAL until blockers` sentinel only if the phrase moved — keep the phrase intact in the copy).
- [ ] **Step 5: Commit** — `git commit -am "feat: uncleared-investigation session copy + backfill first-run flow (35 tools)"`

---

## Verification (end of plan)

1. Full suites green; 35 tools; three copies byte-identical.
2. AJ live: re-run `pnpm validate:fixtures` (unchanged — data layer regression), then in Claude Code: `backfill_ledger` on the Chase pair since 2024-08 → discovery line should read the −865.75 story with `sinceAtLeast: true`; `get_month_close_ledger` shows the backfill records plus the real dogfood close untouched; `credit_card_float_history` on the same range shows causes on every §12 change month matching the spec table (esp. 2026-04 payment_reversal with the trio ids, 2026-07 compound).
