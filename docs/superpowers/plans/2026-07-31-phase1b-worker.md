# Phase 1b: Always-On Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/worker`: a single-tenant Cloudflare Worker with a bearer-auth Streamable-HTTP MCP endpoint (same 35 tools), hourly float monitoring with §9.7-compliant email alerts/digests via Cloudflare Email Service, and a D1 ledger. Spec: `docs/superpowers/specs/2026-07-31-phase1b-worker-design.md`.

**Architecture:** Task 1 refactors core (`LedgerLike` interface, awaited) and exposes a library entrypoint from `@walensis/mcp-for-ynab` (`tools`, `buildServer`, playbook). Tasks 2–3 build the worker: Hono app copying the hevy-mcp stateless transport pattern; `D1Ledger`; pure monitor/digest logic unit-tested without a Workers runtime; `scheduled()` branching on cron. Task 4 is docs + the deploy runbook.

**Tech Stack:** existing + `hono`, `@hono/mcp`, `wrangler` (devDep). Worker package is `"private": true` (never npm-published).

## Global Constraints

- Worker lives at `apps/worker`, private package, OSS in-repo (§10 mode-2 self-host recipe).
- Remote MCP: bearer auth with constant-time SHA-256 digest compare (hevy pattern verbatim); stateless per-request server; `POST /mcp` only (405 otherwise); unauthenticated `GET /health`.
- The worker serves the SAME tool table as stdio — imported, never copied. No undo journal on the worker (documented; `undo_last` degrades to nothing-to-undo). Writes gated by `WORKER_ALLOW_WRITES === '1'`.
- `LedgerLike` methods may return `T | Promise<T>`; `Ynab` awaits every ledger call. File `LedgerStore` behavior unchanged (existing tests untouched).
- Email ONLY via the `send_email` binding: `env.EMAIL.send({ to, from: { email, name }, subject, text })` — always include `text`; no other providers, no API keys.
- Alert rule: |gap − lastGap| > threshold (default $250, var `ALERT_THRESHOLD_DOLLARS`) OR gap < 0 while lastGap ≥ 0. Dedupe: signature = `${cardKey}:${month}:${gapMilli}` — an alert fires once per signature. §9.7: healthy weekly digest is ONE line; alert emails name the cause and end with the fix ("run /month-close — propose_coverage will draft the moves").
- Cron expressions exactly: `0 * * * *`, `0 13 * * SUN`, `0 13 1 * *`; one `scheduled()` handler branching on `event.cron`.
- Integer milli in monitor logic; dollars only in email copy (via `milliToDollars`/`formatDollars` from core).
- Monitor/digest decision + formatting logic is PURE (no bindings) and unit-tested in plain vitest; D1/email/fetch touchpoints are thin adapters. `D1Ledger` tests use a recorded-statement stub asserting SQL + params (no D1 runtime in tests).
- Version bumps via changesets: core minor (LedgerLike), mcp minor (library entrypoint) — 0.2.0 each on the OIDC train.

## File Structure

```
packages/core/src/ledger.ts            # + LedgerLike interface (LedgerStore implements)
packages/core/src/domain.ts            # ledger?: LedgerLike; awaits all ledger calls
apps/mcp/src/index.ts                  # NEW library entrypoint: export { tools, buildServer, MONTH_CLOSE_PLAYBOOK, ToolDef }
apps/mcp/package.json + tsup.config.ts # exports map + second entry (bin unchanged)
apps/worker/package.json               # private; hono, @hono/mcp, deps on the two workspace packages
apps/worker/wrangler.jsonc             # crons, d1 binding, send_email binding, vars (placeholders)
apps/worker/schema.sql                 # ledger_records + monitor_state (committed, OSS)
apps/worker/src/env.ts                 # Env type + config parsing (CARD_PAIRS JSON, threshold)
apps/worker/src/d1-ledger.ts           # D1Ledger implements LedgerLike
apps/worker/src/monitor.ts             # PURE: decideAlert, signatures, gap math
apps/worker/src/emails.ts              # PURE: formatAlert, formatWeeklyDigest, formatMonthlyReport
apps/worker/src/index.ts               # Hono app (fetch: /health, /mcp) + scheduled() branching
apps/worker/test/*.test.ts             # monitor, emails, d1-ledger (stubbed), env parsing
docs + README                          # self-host recipe, deploy runbook
.changeset/phase1b-*.md                # core minor + mcp minor
```

---

### Task 1: Core `LedgerLike` + mcp library entrypoint

**Files:**
- Modify: `packages/core/src/ledger.ts`, `packages/core/src/domain.ts`, `packages/core/src/index.ts`
- Create: `apps/mcp/src/index.ts`
- Modify: `apps/mcp/package.json`, `apps/mcp/tsup.config.ts`
- Test: `packages/core/test/ledger.test.ts` (append), `apps/mcp/test/server.test.ts` (append)
- Create: `.changeset/phase1b-ledgerlike.md`, `.changeset/phase1b-library-entrypoint.md`

**Interfaces:**
```ts
// ledger.ts
export interface LedgerLike {
  append(record: Omit<MonthCloseRecord, 'id' | 'recordedAt'>): MonthCloseRecord | Promise<MonthCloseRecord>
  list(opts?: { limit?: number; cutoff?: string; kind?: 'close' | 'backfill' }): MonthCloseRecord[] | Promise<MonthCloseRecord[]>
  replaceBackfill(planId: string, account: string, records: Omit<MonthCloseRecord, 'id' | 'recordedAt'>[]): MonthCloseRecord[] | Promise<MonthCloseRecord[]>
}
export class LedgerStore implements LedgerLike { /* unchanged body */ }
// domain.ts: Ynab opts/property typed LedgerLike; every this.ledger.X(...) call awaited
// apps/mcp/src/index.ts
export { tools, type ToolDef } from './tools.js'
export { buildServer } from './server.js'
export { MONTH_CLOSE_PLAYBOOK } from './playbook.js'
```
`apps/mcp/package.json`: add `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }` (keep `bin`); tsup entry `['src/main.ts', 'src/index.ts']` with `dts: true` for the mcpb-unaffected default build (MCPB_BUNDLE path unchanged, still main.ts-only single file — set `entry: mcpb ? ['src/main.ts'] : ['src/main.ts', 'src/index.ts']`, `dts: !mcpb`).

- [ ] **Step 1 (RED):** append tests — core: an async-ledger stub `{ append: async (r) => ({...r, id: 'x', recordedAt: 'now', kind: r.kind}), list: async () => [], replaceBackfill: async (_p, _a, rs) => rs.map(...) }` passed as `ledger`, then `await y.recordMonthClose(...)`/`getMonthCloseLedger()`/`backfillLedger(...)` resolve correctly (backfill test reuses an existing fake client fixture). mcp: `import { tools, buildServer } from '../src/index.js'` and `expect(tools).toHaveLength(35)`.
- [ ] **Step 2 (GREEN):** implement per Interfaces (mechanical `await` insertions in domain.ts; typecheck drives completeness).
- [ ] **Step 3:** changesets:
```md
---
"@walensis/mcp-for-ynab-core": minor
---
LedgerLike interface: Ynab accepts any sync-or-async ledger implementation (file LedgerStore unchanged; enables D1-backed ledgers in workers).
```
```md
---
"@walensis/mcp-for-ynab": minor
---
Library entrypoint: export the 35-tool table, buildServer, and the month-close playbook for embedding (worker/self-host reuse). CLI behavior unchanged.
```
- [ ] **Step 4:** full workspace verify (build core first) + `.mcpb` still single-file (`./scripts/build-mcpb.sh` self-test passes). **Step 5: Commit** — `git commit -am "feat: LedgerLike interface + mcp library entrypoint (worker substrate)"`

---

### Task 2: Worker scaffold — Hono app, /mcp, D1Ledger, schema

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/wrangler.jsonc`, `apps/worker/schema.sql`, `apps/worker/src/env.ts`, `apps/worker/src/d1-ledger.ts`, `apps/worker/src/index.ts` (fetch side only; `scheduled` stub logging "not yet implemented"), `apps/worker/test/env.test.ts`, `apps/worker/test/d1-ledger.test.ts`, `apps/worker/test/mcp-route.test.ts`

**Interfaces:**
```ts
// env.ts
export interface WorkerEnv {
  YNAB_ACCESS_TOKEN: string; MCP_AUTH_TOKEN: string
  WORKER_ALLOW_WRITES?: string; PLAN_ID?: string
  CARD_PAIRS?: string; DIGEST_TO?: string; DIGEST_FROM?: string; DIGEST_FROM_NAME?: string; ALERT_THRESHOLD_DOLLARS?: string
  DB: D1Database; EMAIL: { send(msg: { to: string; from: { email: string; name?: string }; subject: string; text: string; html?: string }): Promise<unknown> }
}
export interface CardPair { name: string; paymentCategoryId: string; cardAccountId: string }
export function parseCardPairs(json: string | undefined): CardPair[]   // [] on absent; throws clear Error on malformed
export function alertThresholdMilli(env: WorkerEnv): number            // default 250_000
// d1-ledger.ts
export class D1Ledger implements LedgerLike { constructor(db: D1Database) /* async methods over ledger_records */ }
```
`schema.sql`: `ledger_records(id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL, plan_id TEXT NOT NULL, cutoff TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'close', account TEXT NOT NULL, record TEXT NOT NULL)` + index on (plan_id, kind, account); `monitor_state(card_key TEXT PRIMARY KEY, last_gap_milli INTEGER, last_alert_signature TEXT, updated_at TEXT)`. `D1Ledger` stores the full record as JSON in `record` with the indexed columns extracted; `list` orders by `rowid DESC` (insertion order, matching file-store semantics), applies kind/cutoff/limit in SQL; `replaceBackfill` = `DELETE ... WHERE plan_id=? AND kind='backfill' AND account=?` + inserts (skip delete when records empty — mirror the core guard).
`wrangler.jsonc`: name `mcp-for-ynab-worker`, main `src/index.ts`, compatibility_date current, `triggers.crons` = the three expressions, `d1_databases: [{ binding: 'DB', database_name: 'mcp-for-ynab', database_id: 'REPLACE_ME' }]`, `send_email: [{ name: 'EMAIL' }]`, `vars` placeholders for the non-secret config.
`/mcp` route: hevy worker.ts pattern verbatim (Hono, tokenMatches SHA-256, 401 without bearer, 405 non-POST, stateless `buildServer(ynab, limiter)` per request with `new Ynab({ client: new YnabClient({ token: env.YNAB_ACCESS_TOKEN, limiter }), ledger: new D1Ledger(env.DB), allowWrites: env.WORKER_ALLOW_WRITES === '1' })`, `StreamableHTTPTransport` from `@hono/mcp`).

- [ ] **Step 1 (RED):** tests — `env.test.ts`: parseCardPairs happy/absent/malformed + threshold default/override. `d1-ledger.test.ts`: stub `D1Database` recording `prepare(sql).bind(...args)` calls with canned results; assert append INSERT sql+params (id/recordedAt stamped), list SQL (ORDER BY rowid DESC, kind filter, LIMIT), replaceBackfill DELETE+INSERTs and the empty-records guard (no DELETE issued). `mcp-route.test.ts`: instantiate the Hono app with a fake env (stub DB/EMAIL, real tokens): GET /health → 200; POST /mcp without bearer → 401; wrong bearer → 401; GET /mcp → 405. (Full MCP round-trip over HTTP is deploy-time verification — Hono apps are testable in plain vitest via `app.request()`.)
- [ ] **Step 2 (GREEN):** implement. **Step 3:** workspace verify — worker package gets `"test": "vitest run"`, `"typecheck": "tsc --noEmit"` wired into the root scripts via pnpm recursion automatically. **Step 4: Commit** — `git commit -am "feat(worker): scaffold — bearer /mcp route, D1 ledger, schema, config parsing"`

---

### Task 3: Monitor + digests + scheduled()

**Files:**
- Create: `apps/worker/src/monitor.ts`, `apps/worker/src/emails.ts`, `apps/worker/test/monitor.test.ts`, `apps/worker/test/emails.test.ts`
- Modify: `apps/worker/src/index.ts` (real `scheduled`)

**Interfaces (pure — no bindings):**
```ts
// monitor.ts
export interface CardCheck { cardKey: string; name: string; gapMilli: number; availableMilli: number; owedMilli: number }
export interface MonitorState { lastGapMilli: number | null; lastAlertSignature: string | null }
export function alertSignature(cardKey: string, month: string, gapMilli: number): string
export function decideAlert(check: CardCheck, state: MonitorState, thresholdMilli: number, month: string):
  { alert: boolean; reason: 'moved' | 'went_red' | null; signature: string }
  // alert when (|gap − lastGap| > threshold) OR (gap < 0 && (lastGap ?? 0) >= 0); suppressed when signature === lastAlertSignature; first-ever observation (lastGapMilli null) records state but never alerts
// emails.ts (all take dollars-ready data, return { subject, text })
export function formatAlert(name: string, gapChange: number, gap: number, causes: { cause: string; amount: number }[], month: string): { subject: string; text: string }
export function formatWeeklyDigest(cards: { name: string; gap: number }[], bufferNote?: string): { subject: string; text: string }
  // all gaps ≈ 0 → subject 'All cards covered', text is ONE line
export function formatMonthlyReport(month: string, cards: { name: string; gap: number; gapChange: number; causes: { cause: string; amount: number }[] }[]): { subject: string; text: string }
```
Every alert/monthly text ends with: `Fix: run /month-close in Claude — propose_coverage will draft the covering moves for your approval.` Weekly healthy text is exactly one line + nothing else.
`scheduled(event, env, ctx)`: branch on `event.cron`; hourly: for each pair — fetch month-category (`/plans/{p}/months/current/categories/{id}`) + account → `gapMilli = balanceMilli(cat) + balanceMilli(account)`… (use `category.balance + account.balance` raw milli — same identity as month_close), read `monitor_state`, `decideAlert`; on alert: fetch account txns since first of month, run `attributeChanges` (from core) on a single current-month point built from gapChange = gap − lastGap and assigned from the month-category `budgeted`, then `env.EMAIL.send(formatAlert(...))`; upsert state (always, alert or not). Weekly/monthly: fetch gaps per card (+ for monthly: last month's ledger records via D1Ledger for causes; missing records → 'no close recorded' line) and send the digest. Wrap each pair in try/catch — one card's failure must not kill the sweep; errors `console.error`ed (visible in `wrangler tail`).

- [ ] **Step 1 (RED):** monitor tests: first-observation-no-alert; moved-over-threshold alerts with reason 'moved'; went_red alerts even under threshold; same-signature suppressed; recovery (red→0) alerts as 'moved' only if over threshold. emails tests: healthy weekly is one line; alert contains cause lines, dollar formatting, and the Fix: sentence; monthly lists per-card sections.
- [ ] **Step 2 (GREEN):** implement pure modules; wire `scheduled` (thin, untested beyond typecheck — deploy-time verification).
- [ ] **Step 3:** workspace verify. **Step 4: Commit** — `git commit -am "feat(worker): hourly float monitor, weekly/monthly digests, scheduled handler"`

---

### Task 4: Docs + deploy runbook

**Files:**
- Modify: `README.md` (worker/self-host section), `docs/playbooks/month-close.md` + 2 synced copies ONLY IF a mention of the remote endpoint is added (optional — skip if nothing to say; do NOT touch otherwise)
- Create: `apps/worker/README.md` (the runbook)

- [ ] **Step 1:** `apps/worker/README.md` — self-host runbook, exact commands:
```bash
# one-time
wrangler d1 create mcp-for-ynab            # paste database_id into wrangler.jsonc
wrangler d1 execute mcp-for-ynab --file=./schema.sql --remote
wrangler email sending enable <your-domain>   # domain must be on Cloudflare
wrangler secret put YNAB_ACCESS_TOKEN
wrangler secret put MCP_AUTH_TOKEN            # any long random string; used as the Bearer token
# config: edit wrangler.jsonc vars — CARD_PAIRS, DIGEST_TO, DIGEST_FROM, PLAN_ID, ALERT_THRESHOLD_DOLLARS
wrangler deploy
# verify
curl https://<worker-url>/health
# claude.ai → Settings → Connectors → add custom connector: https://<worker-url>/mcp with Bearer MCP_AUTH_TOKEN
```
plus: what each cron does, quiet-when-healthy expectations, WORKER_ALLOW_WRITES caveat (remote writes have NO undo journal — leave off unless needed), and the §10 disclaimer + not-affiliated footer.
- [ ] **Step 2:** root README — short "Always-on monitoring (self-host)" section linking the runbook; note the library entrypoint (`import { tools, buildServer } from '@walensis/mcp-for-ynab'`).
- [ ] **Step 3:** full verify; confirm `.mcpb` build unaffected. **Step 4: Commit** — `git commit -am "docs(worker): self-host runbook + README section"`

---

## Verification (end of plan)

1. Suites green; worker typechecks; `.mcpb` self-test passes; tool table still 35 via the new entrypoint.
2. Merge → OIDC train publishes core+mcp 0.2.0 (worker consumes workspace versions locally; self-hosters get npm).
3. Deploy (AJ + me together): the runbook top-to-bottom on AJ's account — D1 create/migrate, email enable on the walensis domain, secrets, deploy.
4. Live: `/health` 200; claude.ai custom connector lists 35 tools and runs `month_close` read-only; force one digest (`wrangler cron trigger` or temporary manual route) and receive the email; watch one real hourly cycle in `wrangler tail`.

---

## AMENDMENT (2026-07-31, during execution)

Review of Task 3 corrected three plan-authored semantics — the shipped behavior is:
1. Monthly report causes come from per-card `getCreditCardFloatHistory` over the closing month (close records are session-scoped and conflate cards); the ledger is consulted only for the "no close recorded" nudge.
2. Hourly attribution's `assignedMilli` is the assignment DELTA since the last check (`monitor_state.last_budgeted_milli` added), never the month's cumulative `budgeted`.
3. Signature-based alert suppression is REMOVED from `decideAlert` (state-diff logic already prevents repeats; suppression's only real effect was swallowing legitimate oscillation alerts). Signatures are stored for observability only.
