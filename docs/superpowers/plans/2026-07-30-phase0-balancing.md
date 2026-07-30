# Phase 0: Balancing Suite Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 0 of the Balancing & Planning Suite (spec: `docs/superpowers/specs/2026-07-30-balancing-suite-brief.md`): fix the two known bugs, add gap direction + provisional/final state + `reason` audit params, add local balance-forward ledger tools (32 → 34), and ship the month-close session as a skill + MCP prompt + playbook, with a live fixture-validation script.

**Architecture:** All changes land in the existing stdio server. New `LedgerStore` (file-backed, like `UndoJournal`) in core; a client-level request timeout; field-name normalization in `listTransactions`; additive fields on float-history and month_close responses; session content as repo skill + registered MCP prompt + markdown playbook.

**Tech Stack:** existing (TypeScript strict ESM, vitest, MCP SDK, zod). No new dependencies.

## Global Constraints

- The brief's §9 principles bind all copy written in this plan (tool descriptions, skill, playbook): blocker-aware numbers ("provisional" until blockers empty), donors before RTA, never auto-approve, every problem paired with its fix, quiet-when-healthy tone.
- `reason` params are audit metadata: recorded in the undo-journal description and echoed in responses. They NEVER go to YNAB (assignments have no memo surface — spec addendum §2).
- Ledger tools write ONLY the local file `~/.mcp-for-ynab/ledger.json` — never YNAB. They are NOT gated by `YNAB_ALLOW_WRITES`; their descriptions must state "writes a local file only, never touches YNAB".
- Ledger records store DOLLARS (human-readable JSON; it doubles as the Phase 1 schema draft).
- Client timeout default 45,000 ms, constructor-overridable; a timed-out request throws a clear Error naming the path and duration — never a silent hang.
- Direction semantics: the float GROWS when gap becomes more negative. `direction: 'grew' | 'shrank' | 'flat'` with the same 5-milli deadband as `changed`.
- `gapStatus: 'provisional' | 'final'` on month_close: provisional iff any blocker list is non-empty (counts BEFORE the 50-cap).
- Exactly 34 tools at the end. All existing tests stay green (additive response fields only — no breaking shape changes).
- Fixture ids (validation script only, never in unit tests): account `1213c7f4-7499-4d72-8727-a968902d8755`, payment category `b20cf9b7-0c98-4eaf-9256-59abc598cb11`, plan `last-used`.

## File Structure

```
packages/core/src/client.ts                 # + timeoutMs (AbortSignal.timeout)
packages/core/src/filters.ts                # + TXN_FIELD_ALIASES export
packages/core/src/domain.ts                 # fields normalization; gapStatus; reason params; ledger methods
packages/core/src/category-history.ts       # floatSeries points + gapChangeMilli/direction
packages/core/src/ledger.ts                 # LedgerStore + MonthCloseRecord (new)
packages/core/test/*.test.ts                # per-module additions
apps/mcp/src/tools.ts                       # reason params; 2 ledger tools (34)
apps/mcp/src/server.ts                      # + registerPrompt('month-close-session')
apps/mcp/src/main.ts                        # + LedgerStore wiring
apps/mcp/test/server.test.ts                # count 34; prompt test; ledger call-through
.claude/skills/month-close/SKILL.md         # the session skill (new)
docs/playbooks/month-close.md               # portable playbook (new)
scripts/diagnose-category-history.ts        # instrumented live repro (new)
scripts/validate-fixtures.ts                # live §12 gap-series check (new)
README.md                                   # 34 tools; session section
```

---

### Task 1: Client request timeout + hang diagnosis script

**Files:**
- Modify: `packages/core/src/client.ts`
- Test: `packages/core/test/client.test.ts` (append)
- Create: `scripts/diagnose-category-history.ts`

**Interfaces:**
- Produces: `YnabClient` constructor gains `timeoutMs?: number` (default 45_000). Every request passes `signal: AbortSignal.timeout(timeoutMs)` to fetch; a timeout rejection is caught and rethrown as `Error` with message matching `/timed out after \d+ms .* retry/` and naming the path.

- [ ] **Step 1: Write failing test** (append to `client.test.ts`)

```ts
  it('times out a stalled request with a clear error instead of hanging', async () => {
    const fetchImpl = vi.fn((_url: any, init: any) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    }))
    const c = new YnabClient({ token: 't', fetchImpl: fetchImpl as any, timeoutMs: 50 })
    await expect(c.request('/plans/p1/months/2026-07-01/categories/c1')).rejects.toThrow(/timed out after 50ms.*\/plans\/p1\/months\/2026-07-01\/categories\/c1.*retry/s)
  })
```

- [ ] **Step 2: Verify failure, implement** — in `client.ts`: add `readonly #timeoutMs: number` set from `opts.timeoutMs ?? 45_000`; in `request`, wrap the fetch:

```ts
    let res: Response
    try {
      res = await this.#fetch(url, {
        method: opts.method ?? 'GET',
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new Error(`YNAB API request timed out after ${this.#timeoutMs}ms (${path}). Network stall or YNAB slowness — retry; if it persists, check status.ynab.com.`)
      }
      throw e
    }
```

- [ ] **Step 3: Write `scripts/diagnose-category-history.ts`** (live instrumented repro for spec §11.1; AJ runs it with his PAT)

```ts
import { Ynab, YnabClient, RateLimiter } from '@walensis/mcp-for-ynab-core'

const token = process.env.YNAB_ACCESS_TOKEN?.trim()
const categoryId = process.env.CATEGORY_ID ?? 'b20cf9b7-0c98-4eaf-9256-59abc598cb11'
const since = process.env.SINCE ?? '2024-08'
const until = process.env.UNTIL ?? '2026-07'
if (!token) { console.error('Set YNAB_ACCESS_TOKEN.'); process.exit(1) }

const limiter = new RateLimiter()
const base = new YnabClient({ token, limiter })
let n = 0
const instrumented = {
  request: async (path: string, opts?: any) => {
    const id = ++n
    const t0 = Date.now()
    console.error(`[${id}] -> ${path}`)
    try {
      const out = await base.request(path, opts)
      console.error(`[${id}] <- ${Date.now() - t0}ms`)
      return out
    } catch (e) {
      console.error(`[${id}] !! ${Date.now() - t0}ms: ${(e as Error).message}`)
      throw e
    }
  },
} as any

const y = new Ynab({ client: instrumented, allowWrites: false })
console.error(`diagnosing get_category_history ${since}..${until} category=${categoryId} (rate-limit remaining: ${limiter.remaining()})`)
const t0 = Date.now()
const res = await y.getCategoryHistory('last-used', { categoryId, sinceMonth: since, untilMonth: until })
console.error(`TOTAL ${Date.now() - t0}ms, ${res.points.length} points, skipped ${res.skippedMonths.length}`)
console.log(JSON.stringify(res, null, 2))
```
Add root script: `"diagnose": "pnpm -F @walensis/mcp-for-ynab-core build && tsx scripts/diagnose-category-history.ts"`.

- [ ] **Step 4: Full core tests + typecheck** — PASS. **Step 5: Commit** — `git commit -am "feat(core): request timeout (45s) + category-history diagnosis script"`

---

### Task 2: `list_transactions` fields normalization (spec §11.2)

**Files:**
- Modify: `packages/core/src/filters.ts` (export the alias map), `packages/core/src/domain.ts` (projection)
- Test: `packages/core/test/domain-transactions.test.ts` (append)

**Interfaces:**
- Produces in `filters.ts`:
```ts
export const TXN_FIELD_ALIASES: Record<string, string> = {
  payee_name: 'payeeName', payee_id: 'payeeId', category_name: 'categoryName', category_id: 'categoryId',
  account_name: 'accountName', account_id: 'accountId', transfer_account_id: 'transferAccountId',
  import_id: 'importId', flag_color: 'flagColor',
}
```
- `listTransactions` projection resolves each requested field through the alias map (`TXN_FIELD_ALIASES[f] ?? f`), emits the key AS REQUESTED (echo the caller's name back), and emits `null` (never omits the key) when the value is null/undefined — undefined must not silently vanish in JSON.

- [ ] **Step 1: Write failing test** (append to the listTransactions describe)

```ts
  it('fields accepts snake_case names and never drops requested keys', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [apiTxn({ transfer_account_id: null })] })) } as any
    const y = new Ynab({ client, allowWrites: false })
    const res: any = await y.listTransactions('p1', { fields: ['payee_name', 'transfer_account_id', 'amount'] as any })
    expect(res.transactions[0]).toEqual({ payee_name: 'Kroger', transfer_account_id: null, amount: -45.5 })
    expect(JSON.stringify(res.transactions[0])).toContain('transfer_account_id')
  })
```

- [ ] **Step 2: Verify failure, implement** — in `listTransactions`, replace the projection line:

```ts
    const rows = opts.fields?.length
      ? page.map((t) => Object.fromEntries(opts.fields!.map((f) => {
          const key = (TXN_FIELD_ALIASES[f as string] ?? f) as keyof Txn
          const v = t[key]
          return [f, v === undefined ? null : v]
        })))
      : page
```
(import `TXN_FIELD_ALIASES` from `./filters.js`.) Update the tool schema's `fields` describe text in `apps/mcp/src/tools.ts`: `'project only these fields (snake_case or camelCase; e.g. payee_name, category_name, transfer_account_id)'`.

- [ ] **Step 3: Run tests + typecheck** — PASS. **Step 4: Commit** — `git commit -am "fix(core): list_transactions fields accept snake_case and never drop keys"`

---

### Task 3: Float direction + month_close gapStatus (spec §11.3, §9.2)

**Files:**
- Modify: `packages/core/src/category-history.ts` (floatSeries), `packages/core/src/domain.ts` (both wrappers)
- Test: `packages/core/test/category-history.test.ts`, `packages/core/test/domain-month-close.test.ts` (append/extend)

**Interfaces:**
- `FloatPoint` gains `gapChangeMilli: number` (this point's gap − previous point's gap; first point 0) and `direction: 'grew' | 'shrank' | 'flat'` (`grew` when `gapChangeMilli < -5`, `shrank` when `> 5`, else `flat`). `changed` unchanged.
- Float wrapper output points gain `gapChange` (dollars) + `direction`.
- `monthClose` response gains `gapStatus: 'provisional' | 'final'` and `blockerCount: number` (sum of the three lists, PRE-cap). Tool description gains the §9.2 language.

- [ ] **Step 1: Failing tests**

Append to `category-history.test.ts` floatSeries describe:
```ts
  it('reports signed gap change and direction (grew = more negative)', () => {
    const s = floatSeries(avail, txns, -1000000)
    expect(s.map((p) => [p.month, p.gapChangeMilli, p.direction])).toEqual([
      ['2026-06', 0, 'flat'],
      ['2026-07', -200000, 'grew'],
      ['2026-08', 200000, 'shrank'],
    ])
  })
```
Extend `domain-month-close.test.ts` first monthClose test:
```ts
    expect(res.gapStatus).toBe('provisional') // the 'pend' txn is unapproved+uncategorized+uncleared before cutoff
    expect(res.blockerCount).toBe(3)
```
and the second (identity) test:
```ts
    expect(res.gapStatus).toBe('final')
```
Append to `domain-category-history.test.ts` float test: `expect(res.points.map((p: any) => p.direction)).toEqual(['flat', 'grew', 'shrank'])`.

- [ ] **Step 2: Verify failure, implement**

`floatSeries` map body: compute `const gapChangeMilli = prevGap === null ? 0 : gapMilli - prevGap` before updating `prevGap`; `const direction = gapChangeMilli < -5 ? 'grew' : gapChangeMilli > 5 ? 'shrank' : 'flat'`; include both in the returned object. Wrapper: `gapChange: milliToDollars(p.gapChangeMilli), direction: p.direction` on each point.

`monthClose`: after computing `raw` blockers: `const blockerCount = raw.unapproved.length + raw.uncategorized.length + raw.unclearedBeforeCutoff.length` and `const gapStatus = blockerCount === 0 ? 'final' as const : 'provisional' as const`; add both to the return. Tool description for `month_close` — append: `gapStatus is 'provisional' until every blocker is resolved: never present a provisional gap as the final number — resolve blockers (categorize/approve via update_transactions) and re-run.` Float tool description — append: `Each point carries gapChange and direction ('grew' = float increased).`

- [ ] **Step 3: Full tests + typecheck (build core first)** — PASS. **Step 4: Commit** — `git commit -am "feat(core): float direction/gapChange + month_close provisional-vs-final gapStatus"`

---

### Task 4: `reason` audit param on move_money / assign_budget

**Files:**
- Modify: `packages/core/src/domain.ts` (both methods), `apps/mcp/src/tools.ts` (both schemas)
- Test: `packages/core/test/domain-writes.test.ts` (append)

**Interfaces:**
- `assignBudget(planId, month, categoryId, amount, reason?: string)` and `moveMoney(planId, month, fromCategoryId, toCategoryId, amount, reason?: string)`. When present: journal description gets `` ` — reason: ${reason}` `` appended, and the response gains `reason`. YNAB payloads unchanged (no memo surface — Global Constraints).

- [ ] **Step 1: Failing test** (append to domain-writes)

```ts
  it('assignBudget records reason in the journal description and echoes it', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: 'c1', budgeted: 100000 } }
      expect(JSON.stringify(opts.body)).not.toContain('cover Jul float') // never sent to YNAB
      return { category: { id: 'c1', budgeted: 250000 } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res: any = await y.assignBudget('p1', '2026-07-01', 'c1', 250, '[suite] cover Jul float: payment reversal $3,322.55')
    expect(res.reason).toBe('[suite] cover Jul float: payment reversal $3,322.55')
    expect(journal.popLastCommitted()!.description).toMatch(/reason: \[suite\] cover Jul float/)
  })
```

- [ ] **Step 2: Verify failure, implement** — in both methods: `const suffix = reason ? \` — reason: ${reason}\` : ''`; append `suffix` to the `journal.begin(...)` description; spread `...(reason ? { reason } : {})` into the return object. Tool schemas both gain: `reason: z.string().optional().describe('why this move is being made — recorded in the local audit journal and echoed back (YNAB has no memo on assignments; this never reaches YNAB)')`, handlers pass it through.

- [ ] **Step 3: Full tests + typecheck** — PASS. **Step 4: Commit** — `git commit -am "feat(core): reason audit param on move_money and assign_budget"`

---

### Task 5: LedgerStore + record/get ledger tools (32 → 34)

**Files:**
- Create: `packages/core/src/ledger.ts`, `packages/core/test/ledger.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/domain.ts` (ledger wiring + 2 methods), `apps/mcp/src/main.ts` (construct LedgerStore), `apps/mcp/src/tools.ts` (+2 entries), `apps/mcp/test/server.test.ts` (count 34 + call-through)

**Interfaces:**
```ts
// ledger.ts
export interface MonthCloseRecord {
  id: string; recordedAt: string   // set by append()
  planId: string; cutoff: string; gapStatus: 'provisional' | 'final'
  perCard: { account: string; workingAsOf: number; clearedAsOf: number; availableAtMonthEnd: number; gap: number }[]
  blockers: { unapproved: number; uncategorized: number; unclearedBeforeCutoff: number }
  causes?: { month: string; change: number; cause: string; narrative?: string }[]
  moves?: { from: string; to: string; amount: number; source: 'category' | 'rta'; reason?: string }[]
  buffer?: number; note?: string
}
export class LedgerStore {
  constructor(filePath: string)
  append(record: Omit<MonthCloseRecord, 'id' | 'recordedAt'>): MonthCloseRecord  // validates cutoff format + non-empty perCard; persists; returns full record
  list(opts?: { limit?: number; cutoff?: string }): MonthCloseRecord[]           // newest-first by recordedAt
}
```
File format `{ records: MonthCloseRecord[] }`; corrupt/missing file → empty. `Ynab` gains optional `ledger?: LedgerStore` (constructor opts) and methods `recordMonthClose(record)` (throws a clear Error if no ledger configured) and `getMonthCloseLedger(opts)` (returns `{ records: [], note: 'No ledger configured' }` shape when absent — reads never throw for config). `main.ts` constructs `new LedgerStore(join(homedir(), '.mcp-for-ynab', 'ledger.json'))` and passes it. Tools: `record_month_close` (NOT write-gated; description: "Writes a LOCAL file only (~/.mcp-for-ynab/ledger.json) — never touches YNAB. Persist the balance-forward line at the end of a month-close session: per-card gaps, blocker counts, attributed causes, applied moves with reasons.") and `get_month_close_ledger` ("Read past balance-forward records (newest first) — compare this close against the last one; optional cutoff filter."). Schemas mirror the record shape with zod (snake_case params mapping to the record's camelCase — per_card→perCard etc.).

- [ ] **Step 1: Failing tests** — `ledger.test.ts` (temp-dir file, mirror undo-journal test patterns):
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/ledger.js'

let path: string
beforeEach(() => { path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json') })
const rec = (cutoff = '2026-07-31') => ({
  planId: 'p1', cutoff, gapStatus: 'final' as const,
  perCard: [{ account: 'Citi', workingAsOf: -3241.76, clearedAsOf: -3241.76, availableAtMonthEnd: 2662.65, gap: -579.11 }],
  blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 },
  moves: [{ from: 'Dining Out', to: 'Kid Things', amount: 348.17, source: 'category' as const, reason: 'cover Jul float' }],
})
describe('LedgerStore', () => {
  it('appends with id+recordedAt, persists, survives reload, lists newest-first', () => {
    const s = new LedgerStore(path)
    const a = s.append(rec('2026-06-30'))
    const b = s.append(rec('2026-07-31'))
    expect(a.id).toBeTruthy(); expect(a.recordedAt).toMatch(/^\d{4}-/)
    const reloaded = new LedgerStore(path)
    expect(reloaded.list().map((r) => r.cutoff)).toEqual(['2026-07-31', '2026-06-30'])
    expect(reloaded.list({ cutoff: '2026-06-30' })).toHaveLength(1)
    expect(reloaded.list({ limit: 1 })[0]!.cutoff).toBe(b.cutoff)
  })
  it('validates cutoff and perCard', () => {
    const s = new LedgerStore(path)
    expect(() => s.append({ ...rec(), cutoff: 'July' })).toThrow(/ISO date/)
    expect(() => s.append({ ...rec(), perCard: [] })).toThrow(/perCard/)
  })
  it('tolerates a corrupt file', () => {
    writeFileSync(path, 'not json')
    expect(new LedgerStore(path).list()).toEqual([])
  })
})
```
Plus in `server.test.ts`: count 34; call-through creating a record via `record_month_close` (server built with a temp LedgerStore — `buildServer` signature unchanged; wire ledger through the `Ynab` instance) then reading it via `get_month_close_ledger`.

- [ ] **Step 2: Implement** — `LedgerStore` mirrors `UndoJournal`'s read/flush structure (readFileSync/try-catch/writeFileSync with mkdirSync); `append` validates (`/^\d{4}-\d{2}-\d{2}$/` cutoff → else throw `cutoff must be an ISO date (YYYY-MM-DD)`; `perCard.length > 0` → else throw `perCard must contain at least one card`), stamps `id: randomUUID()`, `recordedAt: new Date().toISOString()`, pushes, flushes. `list` sorts by `recordedAt` desc, filters by cutoff, slices to limit. Domain methods + main wiring + tool entries per Interfaces. Tool zod schemas:
```ts
    schema: { plan_id: planId, cutoff: z.string(), gap_status: z.enum(['provisional', 'final']),
      per_card: z.array(z.object({ account: z.string(), working_as_of: z.number(), cleared_as_of: z.number(), available_at_month_end: z.number(), gap: z.number() })).min(1),
      blockers: z.object({ unapproved: z.number().int(), uncategorized: z.number().int(), uncleared_before_cutoff: z.number().int() }),
      causes: z.array(z.object({ month: z.string(), change: z.number(), cause: z.string(), narrative: z.string().optional() })).optional(),
      moves: z.array(z.object({ from: z.string(), to: z.string(), amount: z.number(), source: z.enum(['category', 'rta']), reason: z.string().optional() })).optional(),
      buffer: z.number().optional(), note: z.string().optional() }
```
with handler mapping snake→camel into `recordMonthClose`. `get_month_close_ledger` schema: `{ limit: z.number().int().max(50).optional(), cutoff: z.string().optional() }`.

- [ ] **Step 3: Full workspace verify (build core first)** — PASS. **Step 4: Commit** — `git commit -am "feat: local balance-forward ledger (record_month_close + get_month_close_ledger, 34 tools)"`

---

### Task 6: Session content — skill, MCP prompt, playbook

**Files:**
- Create: `.claude/skills/month-close/SKILL.md`, `docs/playbooks/month-close.md`
- Modify: `apps/mcp/src/server.ts` (registerPrompt), `apps/mcp/test/server.test.ts` (prompt test)

**Interfaces:**
- MCP prompt `month-close-session` with optional arg `cutoff`; returns one user-role message containing the playbook text (with the cutoff substituted when given). Verified via `client.listPrompts()` / `client.getPrompt(...)`.

- [ ] **Step 1: Write `docs/playbooks/month-close.md`** (single source of session truth — the skill and prompt both derive from it):

````markdown
# The Month-Close Session (Balance → Plan)

You are guiding a monthly catch-up session against YNAB via the "MCP for YNAB" tools.
Anchor everything to the user's cutoff date (ask if not given — normally the last day of
the month being closed). Principles, non-negotiable: numbers are PROVISIONAL until blockers
are empty; donor moves before Ready-to-Assign; never auto-approve; every applied move gets
a `reason`; pair every surfaced problem with its one-tap fix; keep healthy findings to one line.

## BALANCE

**1. Hygiene.** Run `month_close` with the cutoff. If `gapStatus` is "provisional", present the
blocker counts and work through them: show `blockers.uncategorized` and `blockers.unapproved`
rows, propose categories (from payee history via `list_transactions` if helpful), and apply
ONLY what the user approves via `update_transactions` (categorize + approve together; never
approve without the user seeing the categorization). Uncleared-before-cutoff rows are for the
reconciliation step — note them, don't force them.

**2. Trusted gap.** Re-run `month_close` until `gapStatus` is "final". Present per-card:
working/cleared as-of balances, available at month end, and the gap (0 = covered; negative =
short). Heed any `warnings` (unmatched or ambiguous cards are NOT covered by the report).

**3. Attribution.** For each card with a non-zero gap, run `credit_card_float_history` from the
last recorded close (check `get_month_close_ledger`) or 24 months on first run. Walk the
`changed:true` points using `direction` ("grew" = float increased). For each change the user
cares about, look for: that month's payment-category assignment (deliberate cover or drain),
reversal pairs in the card's transactions (`list_transactions` on the account around that month,
fields: date, amount, payee_name, transfer_account_id), or a prior-month overpayment absorbed at
rollover. Label honestly — "unattributed" is an acceptable answer; never force-fit a cause.

**4. Cover.** Run `propose_coverage` for the cutoff month. Present the moves (donors first; RTA
draws are tagged and drawn last). Apply ONLY user-approved moves via `move_money` — and for RTA
draws via `assign_budget`, remember it sets the ABSOLUTE assigned amount (read current assigned
from `get_month`, pass current + amount). Give every applied move a `reason` like
`[month-close 2026-07] cover float: payment reversal $3,322.55`.

**5. Balance-forward line.** Write the record with `record_month_close`: per-card gaps, blocker
counts (should be zeros now), the causes you attributed, and the moves you applied with reasons.
This is next month's baseline.

## PLAN

**6. True starting number.** If the user runs a month-ahead buffer (a "Next Month" holding
category), derive the real usable Ready-to-Assign: `get_month` for the new month's RTA, plus the
buffer category's balance via `get_category_history`, minus any rollover absorptions found in
step 3. State it plainly: "Your true new-month starting number is $X."

**7. Fund the month.** Walk underfunded targets (`month_close` reds / `get_month`
goal_under_funded) and assign with the user's approval (`assign_budget`, with reasons). Per-card
safe-to-pay = that card's payment category available — state it for each card.

**8. Done line.** One sentence: "<Month> balanced. <Next month> funded. All cards covered.
Buffer: $X." (Adjust honestly if cards aren't covered — say which and by how much, and what
remains to fix.)
````

- [ ] **Step 2: Write `.claude/skills/month-close/SKILL.md`**:

````markdown
---
name: month-close
description: Guided YNAB month-close session (Balance → Plan) over the MCP for YNAB tools — blocker-aware gaps, float attribution, donor-first coverage, balance-forward ledger. Use when the user wants to close out a month, do their monthly YNAB catch-up, check credit-card coverage, or asks for /month-close.
---

Run the month-close session exactly as specified in the playbook below. Before starting:
confirm the cutoff date (default: last day of the month being closed) and that the "MCP for
YNAB" server is connected (34 tools). Writes require YNAB_ALLOW_WRITES=1 — if writes are
disabled, run the Balance steps read-only, present the moves you WOULD make, and tell the
user how to enable writes for the apply step.

<playbook contents: identical to docs/playbooks/month-close.md — inline the full text here>
````
(In the actual file, inline the playbook text verbatim rather than referencing it — skills must be self-contained.)

- [ ] **Step 3: Register the MCP prompt** — in `server.ts` (after tool registration):

```ts
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLAYBOOK = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'month-close-playbook.md'), 'utf8')
```
— BUT bundling a separate file complicates the single-file .mcpb build. Instead: create `apps/mcp/src/playbook.ts` exporting `export const MONTH_CLOSE_PLAYBOOK = \`...\`` (the full markdown as a template literal, backticks in content escaped), generated by hand from the playbook doc; add a unit test asserting `playbook.ts` and `docs/playbooks/month-close.md` stay in sync is NOT required (they will drift — instead the ts file is the source and a build-free check: `apps/mcp/test/server.test.ts` asserts the prompt text contains sentinel phrases). Register:

```ts
  server.registerPrompt('month-close-session', {
    description: 'Guided month-close session (Balance → Plan): blocker-aware gaps, float attribution, donor-first coverage, balance-forward record.',
    argsSchema: { cutoff: z.string().optional().describe("cutoff date, e.g. '2026-08-31'") },
  }, ({ cutoff }) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${cutoff ? `Cutoff: ${cutoff}.\n\n` : ''}${MONTH_CLOSE_PLAYBOOK}` } }],
  }))
```
(Adapt minimally to the installed SDK's registerPrompt signature — check it first, as with registerTool.)

- [ ] **Step 4: Prompt test** (append to server.test.ts):
```ts
  it('exposes the month-close-session prompt', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false }))
    const prompts = await client.listPrompts()
    expect(prompts.prompts.map((p) => p.name)).toContain('month-close-session')
    const got = await client.getPrompt({ name: 'month-close-session', arguments: { cutoff: '2026-08-31' } })
    const text = (got.messages[0]!.content as any).text as string
    expect(text).toContain('Cutoff: 2026-08-31')
    expect(text).toContain('PROVISIONAL until blockers')
    expect(text).toContain('never auto-approve')
    expect(text).toContain('record_month_close')
  })
```

- [ ] **Step 5: Full verify** — PASS. **Step 6: Commit** — `git commit -am "feat: month-close session — skill, MCP prompt, playbook"`

---

### Task 7: Fixture validation script + README

**Files:**
- Create: `scripts/validate-fixtures.ts`
- Modify: root `package.json` (script), `README.md`

- [ ] **Step 1: Write `scripts/validate-fixtures.ts`** (live; AJ runs with PAT; asserts the §12 gap series):

```ts
import { Ynab, YnabClient, RateLimiter } from '@walensis/mcp-for-ynab-core'

const token = process.env.YNAB_ACCESS_TOKEN?.trim()
if (!token) { console.error('Set YNAB_ACCESS_TOKEN.'); process.exit(1) }
const y = new Ynab({ client: new YnabClient({ token, limiter: new RateLimiter() }), allowWrites: false })

const EXPECT: Record<string, number> = {
  '2024-08': -865.75, '2024-09': -865.75, '2024-10': -865.75, '2024-11': -865.75,
  '2024-12': -865.75, '2025-01': -865.75, '2025-02': -865.75,
  '2025-03': -862.09, '2025-05': -854.77, '2025-12': -665.28,
  '2026-04': -3987.83, '2026-06': -2471.28, '2026-07': 0.0,
}
const res = await y.getCreditCardFloatHistory('last-used', {
  paymentCategoryId: 'b20cf9b7-0c98-4eaf-9256-59abc598cb11',
  cardAccountId: '1213c7f4-7499-4d72-8727-a968902d8755',
  sinceMonth: '2024-08', untilMonth: '2026-07',
})
let fail = 0
for (const [month, want] of Object.entries(EXPECT)) {
  const p = res.points.find((x) => x.month === month)
  const got = p?.gap
  const ok = got !== undefined && Math.abs(got - want) < 0.005
  console.log(`${ok ? 'PASS' : 'FAIL'} ${month}: gap ${got} (expected ${want})${p ? ` direction=${p.direction}` : ' [missing]'}`)
  if (!ok) fail++
}
console.log(fail === 0 ? 'ALL FIXTURES PASS' : `${fail} FIXTURE(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
```
Root script: `"validate:fixtures": "pnpm -F @walensis/mcp-for-ynab-core build && tsx scripts/validate-fixtures.ts"`.
NOTE: expected values assume the fixture months' data is stable; a FAIL after new budget activity in those months is signal, not necessarily a bug — the script prints both numbers so drift is inspectable.

- [ ] **Step 2: README** — count sweep 32 → 34, two ledger-tool rows, and a new short section "The month-close session" (what it is, `/month-close` skill for Claude, the `month-close-session` MCP prompt for other clients, link to `docs/playbooks/month-close.md`).

- [ ] **Step 3: Full verify** (`pnpm -F @walensis/mcp-for-ynab-core build && pnpm test && pnpm typecheck && pnpm build`) — all green. **Step 4: Commit** — `git commit -am "feat: fixture validation script + README session docs (34 tools)"`

---

## Verification (end of plan)

1. All suites green; 34 tools; prompt listed.
2. AJ live runs: `pnpm diagnose` (with PAT — captures §11.1 evidence; if it reproduces, fix follows the evidence in a follow-up commit), then `pnpm validate:fixtures` (all §12 months PASS).
3. AJ dogfoods the August close via the `/month-close` skill (success criterion: ≤20 min, persisted record via `record_month_close`, every applied move carries a reason).
