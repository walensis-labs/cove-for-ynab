# mcp-for-ynab Core MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@walensis/mcp-for-ynab` — a full-coverage, token-efficient, safe-by-default YNAB MCP server (stdio, PAT auth) with a pure-logic core package ready for a future hosted worker.

**Architecture:** pnpm monorepo. `packages/core` (`@walensis/mcp-for-ynab-core`) holds a thin typed client over YNAB API v1 (`/plans` paths, generated types from a vendored OpenAPI spec), money conversion, delta cache, rate limiter, undo journal, domain service, and analytics — zero MCP dependency. `apps/mcp` (`@walensis/mcp-for-ynab`) is a table-driven MCP stdio server over core: 28 tools, read-only by default.

**Tech Stack:** TypeScript (strict, ESM), pnpm workspaces, vitest, zod v3, `@modelcontextprotocol/sdk`, `openapi-typescript` (codegen only), tsup (build). Node >= 20.

## Global Constraints

- All amounts exposed to models are **decimal dollars**; milliunits never leave core (spec: "Units and conventions").
- API paths use `/plans/...`, never `/budgets/...`. Base URL `https://api.ynab.com/v1`.
- Read-only by default: write tools refuse unless env `YNAB_ALLOW_WRITES=1` (refusal text teaches the flag).
- Deletes and bulk updates (>5 rows) require `confirm: true`; bulk updates also require `expected_count` matching actual.
- Rate limiter: client-side, 190/hr; append warning to tool output when <50 remain; hard-stop at 0.
- Token from `YNAB_ACCESS_TOKEN` or `YNAB_ACCESS_TOKEN_FILE`; never logged; redacted from errors.
- The API's 1-year default transaction lookback must always be explicit in `list_transactions` output.
- Delta-cache scope, v1 (deliberate narrowing of the spec's "all list endpoints"): the `DeltaCache` is wired to payees only. Transaction reads are scoped by `since_date`/sub-endpoint instead — YNAB delta requests return changes since a knowledge point across the *whole* resource, which composes poorly with per-filter queries; revisit when a hosted tier polls. Every write still calls `cache.invalidate(planId)`.
- Exactly 28 tools (spec: "Tool surface"). Names/branding: package `@walensis/mcp-for-ynab`, GitHub `walensis-labs/mcp-for-ynab`, registry `io.github.walensis-labs/mcp-for-ynab`; never "YNAB X" phrasing in user-facing copy — "… for YNAB".
- Undo journal at `~/.mcp-for-ynab/undo.json`, journal-first (written before API call, committed after).
- MIT license. No telemetry.

## File Structure

```
package.json                      # workspace root, scripts
pnpm-workspace.yaml
tsconfig.base.json
LICENSE                           # MIT
.gitignore
packages/core/
  package.json                    # @walensis/mcp-for-ynab-core
  tsconfig.json
  tsup.config.ts
  openapi/ynab-v1.yaml            # vendored, pinned upstream spec
  src/index.ts                    # public exports
  src/money.ts                    # milliunit <-> dollar conversion + formatting
  src/rate-limiter.ts
  src/client.ts                   # YnabClient + YnabApiError + redaction
  src/generated/api.d.ts          # openapi-typescript output (committed)
  src/types.ts                    # lean domain types (PlanSummary, Txn, CategorySnapshot, ...)
  src/delta-cache.ts
  src/undo-journal.ts
  src/filters.ts                  # transaction filter + aggregate helpers
  src/domain.ts                   # Ynab service (all reads/writes, gating, undoLast)
  src/analytics.ts                # spending summary, health, recurring, income/expense, net worth
  test/*.test.ts                  # one test file per src module
apps/mcp/
  package.json                    # @walensis/mcp-for-ynab, bin: mcp-for-ynab
  tsconfig.json
  tsup.config.ts
  src/tools.ts                    # ToolDef[] table (28 entries)
  src/server.ts                   # buildServer(ynab, opts) -> McpServer
  src/env.ts                      # token/flag resolution
  src/main.ts                     # stdio entry
  test/server.test.ts             # in-memory transport tests
scripts/smoke.ts                  # read-only live smoke (manual)
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `LICENSE`, `.gitignore`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/tsup.config.ts`, `packages/core/src/index.ts`, `packages/core/test/scaffold.test.ts`, `apps/mcp/package.json`, `apps/mcp/tsconfig.json`, `apps/mcp/tsup.config.ts`, `apps/mcp/src/main.ts`

**Interfaces:**
- Produces: workspace layout + `pnpm test` / `pnpm build` working across packages. Core package name `@walensis/mcp-for-ynab-core`; app `@walensis/mcp-for-ynab` with `bin.mcp-for-ynab`.

- [ ] **Step 1: Write workspace files**

`package.json` (root):
```json
{
  "name": "mcp-for-ynab-workspace",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0", "tsup": "^8.0.0" }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "declaration": true, "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true, "noUncheckedIndexedAccess": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.mcpb
.env
```

`LICENSE`: standard MIT text, `Copyright (c) 2026 walensis-labs`.

`packages/core/package.json`:
```json
{
  "name": "@walensis/mcp-for-ynab-core",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "gen:api": "openapi-typescript openapi/ynab-v1.yaml -o src/generated/api.d.ts"
  },
  "devDependencies": { "openapi-typescript": "^7.0.0" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/core/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup'
export default defineConfig({ entry: ['src/index.ts'], format: ['esm'], dts: true, clean: true })
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.0.0'
```

`apps/mcp/package.json`:
```json
{
  "name": "@walensis/mcp-for-ynab",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "bin": { "mcp-for-ynab": "dist/main.js" },
  "files": ["dist"],
  "scripts": { "build": "tsup", "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@walensis/mcp-for-ynab-core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  }
}
```

`apps/mcp/tsconfig.json`: same one-liner as core. `apps/mcp/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup'
export default defineConfig({ entry: ['src/main.ts'], format: ['esm'], dts: false, clean: true, banner: { js: '#!/usr/bin/env node' } })
```

`apps/mcp/src/main.ts` (placeholder until Task 11):
```ts
console.error('mcp-for-ynab: not yet implemented')
```

- [ ] **Step 2: Write a trivial failing-then-passing scaffold test**

`packages/core/test/scaffold.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { CORE_VERSION } from '../src/index.js'
describe('scaffold', () => { it('exports core version', () => expect(CORE_VERSION).toBe('0.0.0')) })
```

- [ ] **Step 3: Install and verify**

Run: `cd ~/develop/mcp-for-ynab && pnpm install && pnpm test && pnpm build && pnpm typecheck`
Expected: install succeeds, 1 test passes, both packages build.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo (core + mcp app)"
```

---

### Task 2: Money module

**Files:**
- Create: `packages/core/src/money.ts`, `packages/core/test/money.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

**Interfaces:**
- Produces: `milliToDollars(milli: number): number`, `dollarsToMilli(dollars: number): number`, `formatDollars(dollars: number, opts?: { symbol?: string; decimals?: number }): string`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/money.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { milliToDollars, dollarsToMilli, formatDollars } from '../src/money.js'

describe('money', () => {
  it('converts milliunits to dollars', () => {
    expect(milliToDollars(1234560)).toBe(1234.56)
    expect(milliToDollars(-500)).toBe(-0.5)
    expect(milliToDollars(0)).toBe(0)
    expect(milliToDollars(1234567)).toBe(1234.567) // exact tenth-of-cent preserved
  })
  it('converts dollars to milliunits (rounds to integer milli)', () => {
    expect(dollarsToMilli(1234.56)).toBe(1234560)
    expect(dollarsToMilli(-0.5)).toBe(-500)
    expect(dollarsToMilli(0.005)).toBe(5)
    expect(dollarsToMilli(19.999)).toBe(19999)
  })
  it('round-trips', () => {
    for (const m of [0, 1, -1, 999, 123456789, -42010]) expect(dollarsToMilli(milliToDollars(m))).toBe(m)
  })
  it('formats', () => {
    expect(formatDollars(1234.5)).toBe('$1,234.50')
    expect(formatDollars(-3.211, { decimals: 2 })).toBe('-$3.21')
    expect(formatDollars(10, { symbol: '€' })).toBe('€10.00')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -F @walensis/mcp-for-ynab-core test` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/money.ts`:
```ts
export function milliToDollars(milli: number): number {
  return Math.round(milli) / 1000
}

export function dollarsToMilli(dollars: number): number {
  return Math.round(dollars * 1000)
}

export function formatDollars(dollars: number, opts: { symbol?: string; decimals?: number } = {}): string {
  const { symbol = '$', decimals = 2 } = opts
  const sign = dollars < 0 ? '-' : ''
  const abs = Math.abs(dollars)
  const fixed = abs.toFixed(decimals)
  const [int, frac] = fixed.split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${symbol}${grouped}${frac ? '.' + frac : ''}`
}
```

Add to `packages/core/src/index.ts`: `export * from './money.js'`

- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): money conversion and formatting"`

---

### Task 3: Rate limiter

**Files:**
- Create: `packages/core/src/rate-limiter.ts`, `packages/core/test/rate-limiter.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `class RateLimiter { constructor(limit?: number, windowMs?: number, now?: () => number); take(): void; remaining(): number; warning(): string | null }` and `class RateLimitError extends Error`. Default limit 190, window 3,600,000 ms. `take()` throws `RateLimitError` when exhausted. `warning()` returns a string when `remaining() < 50`, else null.

- [ ] **Step 1: Write failing tests**

`packages/core/test/rate-limiter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { RateLimiter, RateLimitError } from '../src/rate-limiter.js'

describe('RateLimiter', () => {
  it('allows up to limit within window then throws', () => {
    let t = 0
    const rl = new RateLimiter(3, 1000, () => t)
    rl.take(); rl.take(); rl.take()
    expect(() => rl.take()).toThrow(RateLimitError)
  })
  it('rolls the window', () => {
    let t = 0
    const rl = new RateLimiter(2, 1000, () => t)
    rl.take(); t = 500; rl.take()
    expect(() => rl.take()).toThrow(RateLimitError)
    t = 1001 // first stamp expired
    expect(() => rl.take()).not.toThrow()
  })
  it('reports remaining and warns under 50', () => {
    let t = 0
    const rl = new RateLimiter(51, 60_000, () => t)
    expect(rl.warning()).toBeNull()
    rl.take(); rl.take()
    expect(rl.remaining()).toBe(49)
    expect(rl.warning()).toMatch(/49 YNAB API requests remain/)
  })
})
```

- [ ] **Step 2: Verify failure** — `pnpm -F @walensis/mcp-for-ynab-core test rate-limiter` → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/rate-limiter.ts`:
```ts
export class RateLimitError extends Error {
  constructor(minutesUntilNext: number) {
    super(`YNAB API rate limit reached (200 requests/hour, rolling window; this server stops at 190 to leave headroom). ` +
      `The next request slot opens in about ${minutesUntilNext} minute(s). Prefer aggregate/list tools over many small calls.`)
  }
}

export class RateLimiter {
  #stamps: number[] = []
  constructor(
    readonly limit = 190,
    readonly windowMs = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  #prune(): void {
    const cutoff = this.now() - this.windowMs
    this.#stamps = this.#stamps.filter((s) => s > cutoff)
  }

  take(): void {
    this.#prune()
    if (this.#stamps.length >= this.limit) {
      const oldest = this.#stamps[0]!
      const ms = oldest + this.windowMs - this.now()
      throw new RateLimitError(Math.max(1, Math.ceil(ms / 60_000)))
    }
    this.#stamps.push(this.now())
  }

  remaining(): number {
    this.#prune()
    return this.limit - this.#stamps.length
  }

  warning(): string | null {
    const rem = this.remaining()
    return rem < 50 ? `Warning: only ${rem} YNAB API requests remain in this hour's window. Prefer aggregate tools; avoid per-item calls.` : null
  }
}
```

Add export to `index.ts`.

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** — `git commit -am "feat(core): client-side rate limiter (190/hr)"`

---

### Task 4: Vendored OpenAPI spec, generated types, YnabClient

**Files:**
- Create: `packages/core/openapi/ynab-v1.yaml` (downloaded), `packages/core/src/generated/api.d.ts` (generated, committed), `packages/core/src/client.ts`, `packages/core/test/client.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `RateLimiter` from Task 3.
- Produces:
  - `class YnabApiError extends Error { status: number; id: string; hint?: string }`
  - `class YnabClient { constructor(opts: { token: string; fetchImpl?: typeof fetch; baseUrl?: string; limiter?: RateLimiter }); request<T>(path: string, opts?: { method?: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; query?: Record<string, string | number | undefined>; body?: unknown }): Promise<T> }`
  - `request` returns the parsed `data` member of YNAB's response envelope.

- [ ] **Step 1: Vendor the spec + generate types**

Run:
```bash
curl -fsSL https://api.ynab.com/papi/open_api_spec.yaml -o packages/core/openapi/ynab-v1.yaml
pnpm -F @walensis/mcp-for-ynab-core exec pnpm install
pnpm -F @walensis/mcp-for-ynab-core gen:api
```
Expected: `src/generated/api.d.ts` created. Sanity check: `grep -c "/plans/" packages/core/openapi/ynab-v1.yaml` returns > 0 (confirms current-era spec). Commit both files.

- [ ] **Step 2: Write failing client tests** (mock fetch — no network)

`packages/core/test/client.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { YnabClient, YnabApiError } from '../src/client.js'
import { RateLimiter } from '../src/rate-limiter.js'

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const err = (status: number, id: string, detail: string) =>
  new Response(JSON.stringify({ error: { id, name: 'x', detail } }), { status })

describe('YnabClient', () => {
  it('GETs with auth header and unwraps data envelope', async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.ynab.com/v1/plans?include_accounts=true')
      expect(init.headers.Authorization).toBe('Bearer tok123')
      return ok({ plans: [{ id: 'p1' }] })
    })
    const c = new YnabClient({ token: 'tok123', fetchImpl })
    const data = await c.request<{ plans: { id: string }[] }>('/plans', { query: { include_accounts: 'true' } })
    expect(data.plans[0]!.id).toBe('p1')
  })
  it('omits undefined query params and serializes bodies', async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.ynab.com/v1/plans/p1/transactions')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body).transactions[0].amount).toBe(-4500)
      return ok({ transaction_ids: ['t1'] })
    })
    const c = new YnabClient({ token: 't', fetchImpl })
    await c.request('/plans/p1/transactions', { method: 'POST', query: { last_knowledge_of_server: undefined }, body: { transactions: [{ amount: -4500 }] } })
  })
  it('maps YNAB error ids to hints and redacts the token', async () => {
    const fetchImpl = vi.fn(async () => err(403, '403.1', 'subscription lapsed for tok-secret'))
    const c = new YnabClient({ token: 'tok-secret', fetchImpl })
    const e = await c.request('/plans').catch((x) => x as YnabApiError)
    expect(e).toBeInstanceOf(YnabApiError)
    expect(e.id).toBe('403.1')
    expect(e.hint).toMatch(/subscription/i)
    expect(e.message).not.toContain('tok-secret')
    expect(e.message).toContain('[redacted]')
  })
  it('surfaces 429 with rolling-window guidance', async () => {
    const fetchImpl = vi.fn(async () => err(429, '429', 'too many requests'))
    const c = new YnabClient({ token: 't', fetchImpl })
    const e = await c.request('/plans').catch((x) => x as YnabApiError)
    expect(e.hint).toMatch(/200 requests\/hour/)
  })
  it('consumes the limiter before fetching', async () => {
    const fetchImpl = vi.fn(async () => ok({}))
    let t = 0
    const limiter = new RateLimiter(1, 1000, () => t)
    const c = new YnabClient({ token: 't', fetchImpl, limiter })
    await c.request('/user')
    await expect(c.request('/user')).rejects.toThrow(/rate limit/i)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Verify failure**, then implement

`packages/core/src/client.ts`:
```ts
import { RateLimiter } from './rate-limiter.js'

const HINTS: Record<string, string> = {
  '401': 'The YNAB access token is invalid or was revoked. Create a new one: app.ynab.com → Account Settings → Developer Settings.',
  '403.1': "The YNAB subscription for this account has lapsed — the API rejects requests until it's renewed.",
  '403.2': 'The YNAB trial for this account has expired.',
  '403.3': 'This token is not authorized for that operation (it may be a read-only OAuth scope).',
  '403.4': 'This YNAB account has hit a data limit; the API refused the request.',
  '404.2': 'Resource not found — the plan/account/transaction id may be wrong or deleted.',
  '429': 'YNAB rate limit: 200 requests/hour per token, rolling window. Wait for the window to roll; prefer aggregate tools.',
  '500': 'YNAB had an internal error. Retry once; if persistent, check status.ynab.com.',
}

export class YnabApiError extends Error {
  constructor(readonly status: number, readonly id: string, detail: string, readonly hint?: string) {
    super(hint ? `${detail} — ${hint}` : detail)
    this.name = 'YnabApiError'
  }
}

export class YnabClient {
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #base: string
  readonly #limiter?: RateLimiter

  constructor(opts: { token: string; fetchImpl?: typeof fetch; baseUrl?: string; limiter?: RateLimiter }) {
    this.#token = opts.token
    this.#fetch = opts.fetchImpl ?? fetch
    this.#base = opts.baseUrl ?? 'https://api.ynab.com/v1'
    this.#limiter = opts.limiter
  }

  #redact(s: string): string {
    return s.split(this.#token).join('[redacted]')
  }

  async request<T>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    this.#limiter?.take()
    const url = new URL(this.#base + path)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const res = await this.#fetch(url, {
      method: opts.method ?? 'GET',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const text = await res.text()
    if (!res.ok) {
      let id = String(res.status)
      let detail = res.statusText || 'YNAB API error'
      try {
        const parsed = JSON.parse(text).error
        if (parsed?.id) id = parsed.id
        if (parsed?.detail) detail = parsed.detail
      } catch { /* non-JSON error body */ }
      throw new YnabApiError(res.status, id, this.#redact(detail), HINTS[id] ?? HINTS[String(res.status)])
    }
    return (text ? JSON.parse(text).data : undefined) as T
  }
}
```

Export from `index.ts`.

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** — `git commit -am "feat(core): vendored OpenAPI spec + typed YNAB client with error hints"`

---

### Task 5: Delta cache

**Files:**
- Create: `packages/core/src/delta-cache.ts`, `packages/core/test/delta-cache.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `class DeltaCache { knowledge(planId: string, resource: string): number | undefined; merge<T extends { id: string; deleted?: boolean }>(planId: string, resource: string, serverKnowledge: number, incoming: T[]): T[]; invalidate(planId: string): void }`. `merge` upserts incoming items, drops `deleted: true`, stores knowledge, returns all live items sorted by id-insertion order.

- [ ] **Step 1: Write failing tests**

`packages/core/test/delta-cache.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { DeltaCache } from '../src/delta-cache.js'

describe('DeltaCache', () => {
  it('stores knowledge and merges deltas', () => {
    const c = new DeltaCache()
    expect(c.knowledge('p1', 'transactions')).toBeUndefined()
    const first = c.merge('p1', 'transactions', 100, [{ id: 'a', v: 1 } as any, { id: 'b', v: 1 } as any])
    expect(first.map((x: any) => x.id)).toEqual(['a', 'b'])
    expect(c.knowledge('p1', 'transactions')).toBe(100)
    const second = c.merge('p1', 'transactions', 120, [{ id: 'b', v: 2 } as any, { id: 'c', v: 1 } as any])
    expect(second.map((x: any) => `${x.id}${x.v}`)).toEqual(['a1', 'b2', 'c1'])
  })
  it('drops deleted items', () => {
    const c = new DeltaCache()
    c.merge('p1', 'payees', 1, [{ id: 'a' }, { id: 'b' }])
    const live = c.merge('p1', 'payees', 2, [{ id: 'a', deleted: true }])
    expect(live.map((x) => x.id)).toEqual(['b'])
  })
  it('invalidates per plan', () => {
    const c = new DeltaCache()
    c.merge('p1', 'payees', 1, [{ id: 'a' }])
    c.merge('p2', 'payees', 1, [{ id: 'z' }])
    c.invalidate('p1')
    expect(c.knowledge('p1', 'payees')).toBeUndefined()
    expect(c.knowledge('p2', 'payees')).toBe(1)
  })
})
```

- [ ] **Step 2: Verify failure, implement**

`packages/core/src/delta-cache.ts`:
```ts
interface Entry { serverKnowledge: number; items: Map<string, { id: string; deleted?: boolean }> }

export class DeltaCache {
  #store = new Map<string, Entry>()
  #key(planId: string, resource: string): string { return `${planId} ${resource}` }

  knowledge(planId: string, resource: string): number | undefined {
    return this.#store.get(this.#key(planId, resource))?.serverKnowledge
  }

  merge<T extends { id: string; deleted?: boolean }>(planId: string, resource: string, serverKnowledge: number, incoming: T[]): T[] {
    const key = this.#key(planId, resource)
    const entry = this.#store.get(key) ?? { serverKnowledge, items: new Map() }
    entry.serverKnowledge = serverKnowledge
    for (const item of incoming) {
      if (item.deleted) entry.items.delete(item.id)
      else entry.items.set(item.id, item)
    }
    this.#store.set(key, entry)
    return [...entry.items.values()] as T[]
  }

  invalidate(planId: string): void {
    const prefix = `${planId} `
    for (const k of [...this.#store.keys()]) if (k.startsWith(prefix)) this.#store.delete(k)
  }
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit** — `git commit -am "feat(core): per-plan delta-request cache"`

---

### Task 6: Undo journal

**Files:**
- Create: `packages/core/src/undo-journal.ts`, `packages/core/test/undo-journal.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
```ts
export type InverseOp =
  | { kind: 'delete_transactions'; planId: string; ids: string[] }
  | { kind: 'restore_transactions'; planId: string; transactions: Record<string, unknown>[] }
  | { kind: 'patch_transactions'; planId: string; updates: Record<string, unknown>[] }
  | { kind: 'patch_category'; planId: string; categoryId: string; patch: Record<string, unknown> }
  | { kind: 'assign_budget'; planId: string; month: string; categoryId: string; budgetedMilli: number }
  | { kind: 'delete_scheduled'; planId: string; id: string }
  | { kind: 'restore_scheduled'; planId: string; scheduled: Record<string, unknown> }
  | { kind: 'patch_scheduled'; planId: string; id: string; patch: Record<string, unknown> }
  | { kind: 'rename_payee'; planId: string; payeeId: string; name: string }
export interface UndoEntry { id: string; at: string; description: string; committed: boolean; inverse: InverseOp[] }
export class UndoJournal {
  constructor(filePath: string)
  begin(description: string, inverse: InverseOp[]): string   // persists entry (committed:false) BEFORE any API call
  commit(id: string): void                                    // marks committed, persists
  popLastCommitted(): UndoEntry | undefined                   // removes + returns newest committed entry
  size(): number
}
```
File format: JSON `{ entries: UndoEntry[] }`, capped at 50 entries (oldest evicted).

- [ ] **Step 1: Write failing tests**

`packages/core/test/undo-journal.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UndoJournal } from '../src/undo-journal.js'

let path: string
beforeEach(() => { path = join(mkdtempSync(join(tmpdir(), 'undo-')), 'undo.json') })

describe('UndoJournal', () => {
  it('journal-first: begin persists before commit', () => {
    const j = new UndoJournal(path)
    const id = j.begin('delete txn t1', [{ kind: 'restore_transactions', planId: 'p', transactions: [{ id: 't1' }] }])
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.entries[0].committed).toBe(false)
    j.commit(id)
    expect(JSON.parse(readFileSync(path, 'utf8')).entries[0].committed).toBe(true)
  })
  it('pops only committed entries, newest first, and persists removal', () => {
    const j = new UndoJournal(path)
    const a = j.begin('a', []); j.commit(a)
    j.begin('b-uncommitted', [])
    const c = j.begin('c', []); j.commit(c)
    expect(j.popLastCommitted()!.description).toBe('c')
    expect(j.popLastCommitted()!.description).toBe('a')
    expect(j.popLastCommitted()).toBeUndefined()
  })
  it('survives reload from disk and caps at 50', () => {
    const j = new UndoJournal(path)
    for (let i = 0; i < 55; i++) { const id = j.begin(`e${i}`, []); j.commit(id) }
    const j2 = new UndoJournal(path)
    expect(j2.size()).toBe(50)
    expect(j2.popLastCommitted()!.description).toBe('e54')
  })
})
```

- [ ] **Step 2: Verify failure, implement**

`packages/core/src/undo-journal.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type InverseOp =
  | { kind: 'delete_transactions'; planId: string; ids: string[] }
  | { kind: 'restore_transactions'; planId: string; transactions: Record<string, unknown>[] }
  | { kind: 'patch_transactions'; planId: string; updates: Record<string, unknown>[] }
  | { kind: 'patch_category'; planId: string; categoryId: string; patch: Record<string, unknown> }
  | { kind: 'assign_budget'; planId: string; month: string; categoryId: string; budgetedMilli: number }
  | { kind: 'delete_scheduled'; planId: string; id: string }
  | { kind: 'restore_scheduled'; planId: string; scheduled: Record<string, unknown> }
  | { kind: 'patch_scheduled'; planId: string; id: string; patch: Record<string, unknown> }
  | { kind: 'rename_payee'; planId: string; payeeId: string; name: string }

export interface UndoEntry { id: string; at: string; description: string; committed: boolean; inverse: InverseOp[] }

const CAP = 50

export class UndoJournal {
  #entries: UndoEntry[] = []
  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try { this.#entries = (JSON.parse(readFileSync(filePath, 'utf8')).entries ?? []) as UndoEntry[] } catch { this.#entries = [] }
    }
  }
  #flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify({ entries: this.#entries }, null, 2))
  }
  begin(description: string, inverse: InverseOp[]): string {
    const entry: UndoEntry = { id: randomUUID(), at: new Date().toISOString(), description, committed: false, inverse }
    this.#entries.push(entry)
    if (this.#entries.length > CAP) this.#entries.splice(0, this.#entries.length - CAP)
    this.#flush()
    return entry.id
  }
  commit(id: string): void {
    const e = this.#entries.find((x) => x.id === id)
    if (e) { e.committed = true; this.#flush() }
  }
  popLastCommitted(): UndoEntry | undefined {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i]!.committed) return (this.#entries.splice(i, 1)[0]!, this.#flush(), undefined as never) || undefined
    }
    return undefined
  }
  size(): number { return this.#entries.length }
}
```
**Correction (write it this way, the comma-trick above is wrong):**
```ts
  popLastCommitted(): UndoEntry | undefined {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i]!.committed) {
        const [entry] = this.#entries.splice(i, 1)
        this.#flush()
        return entry
      }
    }
    return undefined
  }
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit** — `git commit -am "feat(core): journal-first undo journal (cap 50)"`

---

### Task 7: Domain types + read layer (plans, overview, month, categories, payees, scheduled reads)

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/domain.ts`, `packages/core/test/domain-reads.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `YnabClient` (Task 4), `DeltaCache` (Task 5), `milliToDollars` (Task 2).
- Produces `class Ynab` with constructor `new Ynab({ client, cache?, journal?, allowWrites })` and read methods (all amounts in dollars):
```ts
listPlans(): Promise<{ id: string; name: string; currency: string; lastModified: string }[]>
getPlanOverview(planId: string): Promise<{
  plan: { id: string; name: string; currency: string }
  month: { month: string; readyToAssign: number; ageOfMoney: number | null; activity: number; budgeted: number }
  accounts: { id: string; name: string; type: string; onBudget: boolean; balance: number; cleared: number; uncleared: number; lastReconciledAt: string | null }[]
  categoryGroups: { name: string; assigned: number; activity: number; available: number }[]
}>
getMonth(planId: string, month: string): Promise<{ month: string; readyToAssign: number; ageOfMoney: number | null; categories: CategorySnapshot[] }>
listCategories(planId: string): Promise<CategorySnapshot[]>
listPayees(planId: string): Promise<{ id: string; name: string; transferAccountId: string | null }[]>
listScheduled(planId: string): Promise<ScheduledSnapshot[]>
```
with `CategorySnapshot = { id; name; group; hidden; assigned; activity; available; goalType: string | null; goalTarget: number | null; goalUnderFunded: number | null; goalPercentageComplete: number | null }` and `ScheduledSnapshot = { id; dateNext; frequency; amount; payeeName: string | null; categoryName: string | null; memo: string | null }` — declare both in `types.ts` and re-export.
- `'last-used'` is accepted anywhere a `planId` is taken (passed straight through to the API).

- [ ] **Step 1: Write failing tests** (fake client returning fixture payloads; asserts dollars conversion, delta usage)

`packages/core/test/domain-reads.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { Ynab } from '../src/domain.js'
import { DeltaCache } from '../src/delta-cache.js'

function fakeClient(routes: Record<string, (q?: any) => unknown>) {
  return {
    request: vi.fn(async (path: string, opts?: { query?: any }) => {
      const key = Object.keys(routes).find((r) => path === r)
      if (!key) throw new Error(`unmocked path ${path}`)
      return routes[key]!(opts?.query)
    }),
  } as any
}

const monthFixture = {
  month: { month: '2026-07-01', to_be_budgeted: 150250, age_of_money: 32, activity: -2100500, budgeted: 3000000,
    categories: [
      { id: 'c1', category_group_name: 'Bills', name: 'Rent', hidden: false, budgeted: 1500000, activity: -1500000, balance: 0,
        goal_type: 'NEED', goal_target: 1500000, goal_under_funded: 0, goal_percentage_complete: 100, deleted: false },
      { id: 'c2', category_group_name: 'Fun', name: 'Dining', hidden: false, budgeted: 200000, activity: -155500, balance: 44500,
        goal_type: null, goal_target: 0, goal_under_funded: null, goal_percentage_complete: null, deleted: false },
    ] },
}

describe('Ynab reads', () => {
  it('lists plans with currency', async () => {
    const client = fakeClient({ '/plans': () => ({ plans: [{ id: 'p1', name: 'Family', last_modified_on: '2026-07-01T00:00:00Z', currency_format: { iso_code: 'USD' } }] }) })
    const y = new Ynab({ client, allowWrites: false })
    const plans = await y.listPlans()
    expect(plans).toEqual([{ id: 'p1', name: 'Family', currency: 'USD', lastModified: '2026-07-01T00:00:00Z' }])
  })
  it('getMonth converts milliunits to dollars everywhere', async () => {
    const client = fakeClient({ '/plans/p1/months/2026-07-01': () => monthFixture })
    const y = new Ynab({ client, allowWrites: false })
    const m = await y.getMonth('p1', '2026-07-01')
    expect(m.readyToAssign).toBe(150.25)
    expect(m.categories[1]).toMatchObject({ name: 'Dining', assigned: 200, activity: -155.5, available: 44.5, goalTarget: null })
    expect(m.categories[0]!.goalTarget).toBe(1500)
  })
  it('listPayees uses delta cache on second call', async () => {
    const calls: any[] = []
    const client = {
      request: vi.fn(async (_p: string, opts?: any) => {
        calls.push(opts?.query?.last_knowledge_of_server)
        return calls.length === 1
          ? { payees: [{ id: 'a', name: 'Kroger', transfer_account_id: null, deleted: false }], server_knowledge: 10 }
          : { payees: [], server_knowledge: 10 }
      }),
    } as any
    const y = new Ynab({ client, cache: new DeltaCache(), allowWrites: false })
    await y.listPayees('p1')
    const second = await y.listPayees('p1')
    expect(calls).toEqual([undefined, 10])
    expect(second).toEqual([{ id: 'a', name: 'Kroger', transferAccountId: null }])
  })
})
```

- [ ] **Step 2: Verify failure, implement**

`packages/core/src/types.ts`:
```ts
export interface CategorySnapshot {
  id: string; name: string; group: string; hidden: boolean
  assigned: number; activity: number; available: number
  goalType: string | null; goalTarget: number | null
  goalUnderFunded: number | null; goalPercentageComplete: number | null
}
export interface ScheduledSnapshot {
  id: string; dateNext: string; frequency: string; amount: number
  payeeName: string | null; categoryName: string | null; memo: string | null
}
export interface Txn {
  id: string; date: string; amount: number; payeeName: string | null; payeeId: string | null
  categoryName: string | null; categoryId: string | null; accountName: string; accountId: string
  memo: string | null; cleared: 'cleared' | 'uncleared' | 'reconciled'; approved: boolean
  flagColor: string | null; transferAccountId: string | null; importId: string | null
  subtransactions?: { amount: number; categoryName: string | null; memo: string | null }[]
}
```

`packages/core/src/domain.ts` (reads portion; write methods arrive in Tasks 8–9):
```ts
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
    const budgeted = month.categories.reduce((s, c) => s + c.assigned, 0)
    const activity = month.categories.reduce((s, c) => s + c.activity, 0)
    return {
      plan: { id: plan.id, name: plan.name, currency: plan.currency },
      month: { month: month.month, readyToAssign: month.readyToAssign, ageOfMoney: month.ageOfMoney, activity: Math.round(activity * 100) / 100, budgeted: Math.round(budgeted * 100) / 100 },
      accounts,
      categoryGroups: [...groups.entries()].map(([name, v]) => ({ name, assigned: Math.round(v.assigned * 100) / 100, activity: Math.round(v.activity * 100) / 100, available: Math.round(v.available * 100) / 100 })),
    }
  }
}
```
Export `Ynab`, `WriteDisabledError`, `mapTxn`, and types from `index.ts`.

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit** — `git commit -am "feat(core): domain read layer (plans, overview, month, categories, payees, scheduled)"`

---

### Task 8: Transaction filters/aggregation + transaction domain (reads and writes)

**Files:**
- Create: `packages/core/src/filters.ts`, `packages/core/test/filters.test.ts`, `packages/core/test/domain-transactions.test.ts`
- Modify: `packages/core/src/domain.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `mapTxn`, `Txn`, `dollarsToMilli`, `UndoJournal`, `DeltaCache`.
- Produces in `filters.ts`:
```ts
export interface TxnFilters {
  accountId?: string; categoryId?: string; payeeId?: string
  sinceDate?: string; untilDate?: string
  unapprovedOnly?: boolean; unclearedOnly?: boolean
  search?: string          // case-insensitive payee/memo substring
  minAmount?: number; maxAmount?: number   // dollars
  flagColor?: string
}
export function applyFilters(txns: Txn[], f: TxnFilters): Txn[]
export function aggregateTxns(txns: Txn[], by: 'category' | 'payee' | 'month'): { key: string; total: number; count: number }[]  // total in dollars, sorted ascending by total
```
- Produces on `Ynab`:
```ts
listTransactions(planId: string, opts: TxnFilters & { limit?: number; offset?: number; fields?: (keyof Txn)[]; aggregate?: 'category' | 'payee' | 'month' }):
  Promise<{ effectiveWindow: { sinceDate: string; untilDate: string | null; note: string }; total: number
          } & ({ transactions: Partial<Txn>[]; page: { limit: number; offset: number; returned: number } } | { aggregate: { key: string; total: number; count: number }[] })>
getTransaction(planId: string, id: string): Promise<Txn>
createTransactions(planId: string, txns: NewTxn[]): Promise<{ created: number; ids: string[] }>   // NewTxn: { accountId; date; amount; payeeName?; payeeId?; categoryId?; memo?; cleared?; approved?; flagColor?; importId?; subtransactions?: { amount; categoryId?; memo? }[] } — dollars in, milli out
updateTransactions(planId: string, updates: ({ id: string } & Partial<Pick<NewTxn, 'date' | 'amount' | 'payeeId' | 'payeeName' | 'categoryId' | 'memo' | 'cleared' | 'approved' | 'flagColor'>>)[], opts?: { confirm?: boolean; expectedCount?: number }): Promise<{ updated: number }>
deleteTransaction(planId: string, id: string, opts?: { confirm?: boolean }): Promise<{ deleted: string }>
importTransactions(planId: string): Promise<{ importedCount: number }>
```
Rules: default `sinceDate` = 365 days before today (stated in `effectiveWindow.note`); server-side sub-endpoint used when exactly one of account/category/payee filter present; `updateTransactions` with >5 rows requires `confirm` + `expectedCount === updates.length` else throws `ConfirmationRequiredError`; deletes always require `confirm`. Every write: `assertWrites()`, journal-first (`begin` → API → `commit`), then `cache.invalidate(planId)`.
- Also produces `class ConfirmationRequiredError extends Error` in `domain.ts`.

- [ ] **Step 1: Write failing filter tests**

`packages/core/test/filters.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { applyFilters, aggregateTxns } from '../src/filters.js'
import type { Txn } from '../src/types.js'

const t = (o: Partial<Txn>): Txn => ({
  id: 'x', date: '2026-07-01', amount: -10, payeeName: 'P', payeeId: null, categoryName: 'C', categoryId: null,
  accountName: 'A', accountId: 'a1', memo: null, cleared: 'cleared', approved: true, flagColor: null,
  transferAccountId: null, importId: null, ...o,
})

describe('applyFilters', () => {
  it('filters by search across payee and memo, case-insensitive', () => {
    const txns = [t({ payeeName: 'Kroger' }), t({ memo: 'kroger run' }), t({ payeeName: 'Shell' })]
    expect(applyFilters(txns, { search: 'KROG' })).toHaveLength(2)
  })
  it('filters by amount range in dollars and uncleared/unapproved', () => {
    const txns = [t({ amount: -5 }), t({ amount: -50, cleared: 'uncleared' }), t({ amount: -500, approved: false })]
    expect(applyFilters(txns, { minAmount: -100, maxAmount: -20 })).toHaveLength(1)
    expect(applyFilters(txns, { unclearedOnly: true })).toHaveLength(1)
    expect(applyFilters(txns, { unapprovedOnly: true })).toHaveLength(1)
  })
  it('filters by date window', () => {
    const txns = [t({ date: '2026-01-15' }), t({ date: '2026-06-15' })]
    expect(applyFilters(txns, { sinceDate: '2026-06-01' })).toHaveLength(1)
    expect(applyFilters(txns, { untilDate: '2026-02-01' })).toHaveLength(1)
  })
})

describe('aggregateTxns', () => {
  it('groups and sums by category with counts, sorted most-negative first', () => {
    const txns = [t({ categoryName: 'Rent', amount: -1500 }), t({ categoryName: 'Dining', amount: -20 }), t({ categoryName: 'Dining', amount: -30 })]
    expect(aggregateTxns(txns, 'category')).toEqual([
      { key: 'Rent', total: -1500, count: 1 },
      { key: 'Dining', total: -50, count: 2 },
    ])
  })
  it('groups by month', () => {
    const txns = [t({ date: '2026-06-02', amount: -1 }), t({ date: '2026-06-20', amount: -2 }), t({ date: '2026-07-01', amount: -4 })]
    expect(aggregateTxns(txns, 'month')).toEqual([
      { key: '2026-06', total: -3, count: 2 },
      { key: '2026-07', total: -4, count: 1 },
    ])
  })
})
```

- [ ] **Step 2: Implement filters**

`packages/core/src/filters.ts`:
```ts
import type { Txn } from './types.js'

export interface TxnFilters {
  accountId?: string; categoryId?: string; payeeId?: string
  sinceDate?: string; untilDate?: string
  unapprovedOnly?: boolean; unclearedOnly?: boolean
  search?: string
  minAmount?: number; maxAmount?: number
  flagColor?: string
}

export function applyFilters(txns: Txn[], f: TxnFilters): Txn[] {
  const needle = f.search?.toLowerCase()
  return txns.filter((t) => {
    if (f.accountId && t.accountId !== f.accountId) return false
    if (f.categoryId && t.categoryId !== f.categoryId) return false
    if (f.payeeId && t.payeeId !== f.payeeId) return false
    if (f.sinceDate && t.date < f.sinceDate) return false
    if (f.untilDate && t.date > f.untilDate) return false
    if (f.unapprovedOnly && t.approved) return false
    if (f.unclearedOnly && t.cleared !== 'uncleared') return false
    if (f.flagColor && t.flagColor !== f.flagColor) return false
    if (f.minAmount !== undefined && t.amount < f.minAmount) return false
    if (f.maxAmount !== undefined && t.amount > f.maxAmount) return false
    if (needle && !(t.payeeName?.toLowerCase().includes(needle) || t.memo?.toLowerCase().includes(needle))) return false
    return true
  })
}

export function aggregateTxns(txns: Txn[], by: 'category' | 'payee' | 'month'): { key: string; total: number; count: number }[] {
  const groups = new Map<string, { total: number; count: number }>()
  for (const t of txns) {
    const key = by === 'month' ? t.date.slice(0, 7) : (by === 'category' ? t.categoryName : t.payeeName) ?? '(none)'
    const g = groups.get(key) ?? { total: 0, count: 0 }
    g.total = Math.round((g.total + t.amount) * 1000) / 1000
    g.count++
    groups.set(key, g)
  }
  return [...groups.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.total - b.total)
}
```

- [ ] **Step 3: Write failing transaction-domain tests**

`packages/core/test/domain-transactions.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab, ConfirmationRequiredError, WriteDisabledError } from '../src/domain.js'
import { UndoJournal } from '../src/undo-journal.js'

const apiTxn = (o: any = {}) => ({
  id: 't1', date: '2026-07-10', amount: -45500, payee_name: 'Kroger', payee_id: 'pay1', category_name: 'Groceries',
  category_id: 'c1', account_name: 'Checking', account_id: 'a1', memo: null, cleared: 'cleared', approved: true,
  flag_color: null, transfer_account_id: null, import_id: null, deleted: false, subtransactions: [], ...o,
})

let journal: UndoJournal
beforeEach(() => { journal = new UndoJournal(join(mkdtempSync(join(tmpdir(), 'u-')), 'undo.json')) })

describe('listTransactions', () => {
  it('states the effective 1-year window and paginates', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [apiTxn(), apiTxn({ id: 't2', amount: -1000 })], server_knowledge: 5 })) } as any
    const y = new Ynab({ client, allowWrites: false })
    const res: any = await y.listTransactions('p1', { limit: 1, offset: 0 })
    expect(res.effectiveWindow.note).toMatch(/defaults to the last 365 days/)
    expect(res.total).toBe(2)
    expect(res.transactions).toHaveLength(1)
    expect(res.transactions[0].amount).toBe(-45.5)
  })
  it('uses the category sub-endpoint when only categoryId is set', async () => {
    const client = { request: vi.fn(async (path: string) => { expect(path).toBe('/plans/p1/categories/c9/transactions'); return { transactions: [] } }) } as any
    await new Ynab({ client, allowWrites: false }).listTransactions('p1', { categoryId: 'c9' })
  })
  it('aggregate mode returns sums not rows', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [apiTxn(), apiTxn({ id: 't2', category_name: 'Fun', amount: -2000 })] })) } as any
    const res: any = await new Ynab({ client, allowWrites: false }).listTransactions('p1', { aggregate: 'category' })
    expect(res.aggregate).toEqual([
      { key: 'Groceries', total: -45.5, count: 1 },
      { key: 'Fun', total: -2, count: 1 },
    ])
    expect(res.transactions).toBeUndefined()
  })
})

describe('writes', () => {
  it('refuses when allowWrites is false', async () => {
    const y = new Ynab({ client: { request: vi.fn() } as any, allowWrites: false })
    await expect(y.createTransactions('p1', [{ accountId: 'a1', date: '2026-07-01', amount: -5 }])).rejects.toThrow(WriteDisabledError)
  })
  it('creates transactions converting dollars to milliunits, journal-first', async () => {
    const client = { request: vi.fn(async (_p: string, opts: any) => {
      expect(opts.body.transactions[0].amount).toBe(-5250)
      return { transaction_ids: ['n1'], transactions: [apiTxn({ id: 'n1', amount: -5250 })] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res = await y.createTransactions('p1', [{ accountId: 'a1', date: '2026-07-01', amount: -5.25, payeeName: 'Cafe' }])
    expect(res).toEqual({ created: 1, ids: ['n1'] })
    expect(journal.popLastCommitted()!.inverse[0]).toMatchObject({ kind: 'delete_transactions', ids: ['n1'] })
  })
  it('bulk update >5 rows demands confirm + expectedCount', async () => {
    const y = new Ynab({ client: { request: vi.fn() } as any, journal, allowWrites: true })
    const updates = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, approved: true }))
    await expect(y.updateTransactions('p1', updates)).rejects.toThrow(ConfirmationRequiredError)
    await expect(y.updateTransactions('p1', updates, { confirm: true, expectedCount: 5 })).rejects.toThrow(/expected_count/)
  })
  it('bulk update journals prior state for undo', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/transactions/t1') && !opts?.method) return { transaction: apiTxn({ approved: false }) }
      return { transactions: [apiTxn({ approved: true })] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateTransactions('p1', [{ id: 't1', approved: true }])
    const entry = journal.popLastCommitted()!
    expect(entry.inverse[0]).toMatchObject({ kind: 'patch_transactions', updates: [{ id: 't1', approved: false }] })
  })
  it('delete requires confirm and journals the full transaction for restore', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (opts?.method === 'DELETE') return { transaction: apiTxn() }
      return { transaction: apiTxn() }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await expect(y.deleteTransaction('p1', 't1')).rejects.toThrow(ConfirmationRequiredError)
    await y.deleteTransaction('p1', 't1', { confirm: true })
    expect(journal.popLastCommitted()!.inverse[0]!.kind).toBe('restore_transactions')
  })
})
```

- [ ] **Step 4: Implement transaction methods in `domain.ts`** (append to class; add `ConfirmationRequiredError` beside `WriteDisabledError`)

```ts
export class ConfirmationRequiredError extends Error {
  constructor(what: string) {
    super(`${what} requires confirm: true${what.includes('Bulk') ? ' and expected_count matching the number of rows' : ''}. ` +
      `Re-issue the call with confirmation after showing the user what will change.`)
  }
}

const DAY = 86_400_000
function defaultSince(): string { return new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10) }

// inside class Ynab:
  async listTransactions(planId: string, opts: import('./filters.js').TxnFilters & { limit?: number; offset?: number; fields?: (keyof Txn)[]; aggregate?: 'category' | 'payee' | 'month' } = {}) {
    const sinceDate = opts.sinceDate ?? defaultSince()
    const explicit = opts.sinceDate !== undefined
    const sub = [opts.accountId && `accounts/${opts.accountId}`, opts.categoryId && `categories/${opts.categoryId}`, opts.payeeId && `payees/${opts.payeeId}`].filter(Boolean)
    const path = sub.length === 1 ? `/plans/${planId}/${sub[0]}/transactions` : `/plans/${planId}/transactions`
    const data = await this.client.request<any>(path, { query: { since_date: sinceDate, until_date: opts.untilDate, type: opts.unapprovedOnly ? 'unapproved' : opts.unclearedOnly ? 'uncleared' : undefined } })
    const { applyFilters, aggregateTxns } = await import('./filters.js')
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

  async createTransactions(planId: string, txns: any[]) {
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
```
This requires one more `UndoJournal` method, added in this task: `setInverse(id: string, inverse: InverseOp[]): void` — finds the entry by id, replaces its `inverse`, and `#flush()`es (journal-first still holds: `begin` persisted the intent before the API call; `setInverse` fills in ids only known after).

```ts
  async updateTransactions(planId: string, updates: any[], opts: { confirm?: boolean; expectedCount?: number } = {}) {
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
```
Note on `updateTransactions` inverse for restored nulls: prior values that were `undefined` are journaled as `null`, which the API accepts to clear a field. Also add the `setInverse` test to `undo-journal.test.ts`:
```ts
  it('setInverse replaces inverse before commit', () => {
    const j = new UndoJournal(path)
    const id = j.begin('create', [])
    j.setInverse(id, [{ kind: 'delete_transactions', planId: 'p', ids: ['n1'] }])
    j.commit(id)
    expect(j.popLastCommitted()!.inverse).toHaveLength(1)
  })
```

- [ ] **Step 5: Run all core tests** — `pnpm -F @walensis/mcp-for-ynab-core test` → PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat(core): transaction reads with filters/aggregate/pagination + gated writes with undo"`

---

### Task 9: Structure writes (categories/targets, assign, move_money, payees, accounts, scheduled) + undoLast

**Files:**
- Create: `packages/core/test/domain-writes.test.ts`
- Modify: `packages/core/src/domain.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces on `Ynab` (all dollars in/out; every write: `assertWrites()` → journal-first → invalidate):
```ts
createCategory(planId: string, opts: { name: string; groupId?: string; groupName?: string }): Promise<{ id: string; name: string }>   // groupName creates the group first
updateCategory(planId: string, categoryId: string, patch: { name?: string; hidden?: boolean; goalTarget?: number | null; goalTargetDate?: string | null; goalFrequency?: 'monthly' | 'weekly' | 'yearly' | null; goalNeedsWholeAmount?: boolean | null }): Promise<{ updated: string }>
assignBudget(planId: string, month: string, categoryId: string, amount: number): Promise<{ month: string; categoryId: string; assigned: number }>
moveMoney(planId: string, month: string, fromCategoryId: string, toCategoryId: string, amount: number): Promise<{ moved: number; from: { id: string; assigned: number }; to: { id: string; assigned: number } }>  // rollback: if 2nd PATCH fails, restore 1st
renamePayee(planId: string, payeeId: string, name: string): Promise<{ renamed: string }>
createPayee(planId: string, name: string): Promise<{ id: string; name: string }>
createAccount(planId: string, opts: { name: string; type: 'checking' | 'savings' | 'cash' | 'creditCard' | 'otherAsset' | 'otherLiability'; balance: number }): Promise<{ id: string }>
createScheduled(planId: string, txn: { accountId: string; date: string; amount: number; frequency: string; payeeName?: string; payeeId?: string; categoryId?: string; memo?: string }): Promise<{ id: string }>
updateScheduled(planId: string, id: string, patch: Record<string, unknown>): Promise<{ updated: string }>
deleteScheduled(planId: string, id: string, opts?: { confirm?: boolean }): Promise<{ deleted: string }>
undoLast(): Promise<{ undone: string; actions: number } | { undone: null; message: string }>
```
`undoLast` pops the journal and executes each `InverseOp` against the client with writes force-allowed (it is itself a write; still requires `allowWrites`). Executing an inverse does NOT journal (no undo-of-undo, v1).

- [ ] **Step 1: Write failing tests**

`packages/core/test/domain-writes.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab } from '../src/domain.js'
import { UndoJournal } from '../src/undo-journal.js'
import { dollarsToMilli } from '../src/money.js'

let journal: UndoJournal
beforeEach(() => { journal = new UndoJournal(join(mkdtempSync(join(tmpdir(), 'u-')), 'undo.json')) })

describe('targets and assignment', () => {
  it('updateCategory converts goal dollars and journals prior state', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: 'c1', name: 'Rent', hidden: false, goal_target: 1000000, goal_target_date: null, goal_frequency: null, goal_needs_whole_amount: null } }
      expect(opts.body.category.goal_target).toBe(1500000)
      return { category: { id: 'c1' } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateCategory('p1', 'c1', { goalTarget: 1500 })
    expect(journal.popLastCommitted()!.inverse[0]).toMatchObject({ kind: 'patch_category', patch: { goal_target: 1000000 } })
  })
  it('assignBudget journals the previous budgeted amount', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: 'c1', budgeted: 100000 } }
      expect(opts.body.category.budgeted).toBe(dollarsToMilli(250))
      return { category: { id: 'c1', budgeted: 250000 } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res = await y.assignBudget('p1', '2026-07-01', 'c1', 250)
    expect(res.assigned).toBe(250)
    expect(journal.popLastCommitted()!.inverse[0]).toMatchObject({ kind: 'assign_budget', budgetedMilli: 100000 })
  })
  it('moveMoney rolls back the first PATCH if the second fails', async () => {
    const calls: any[] = []
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: path.includes('c-from') ? 'c-from' : 'c-to', budgeted: 500000 } }
      calls.push({ path, body: opts.body })
      if (path.includes('c-to') && calls.length === 2) throw new Error('boom')
      return { category: {} }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await expect(y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 100)).rejects.toThrow(/boom.*rolled back|rolled back.*boom/s)
    // 3rd PATCH restores c-from to 500000
    expect(calls[2]!.path).toContain('c-from')
    expect(calls[2]!.body.category.budgeted).toBe(500000)
  })
})

describe('undoLast', () => {
  it('replays inverse ops and reports, without journaling the undo', async () => {
    const client = { request: vi.fn(async () => ({ transaction_ids: [] })) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const id = journal.begin('create 2 transaction(s)', [{ kind: 'delete_transactions', planId: 'p1', ids: ['a', 'b'] }])
    journal.commit(id)
    const res: any = await y.undoLast()
    expect(res.undone).toBe('create 2 transaction(s)')
    expect(client.request).toHaveBeenCalledWith('/plans/p1/transactions/a', { method: 'DELETE' })
    expect(journal.size()).toBe(0)
  })
  it('reports empty journal gracefully', async () => {
    const y = new Ynab({ client: { request: vi.fn() } as any, journal, allowWrites: true })
    const res: any = await y.undoLast()
    expect(res.undone).toBeNull()
  })
})
```

- [ ] **Step 2: Implement in `domain.ts`**

```ts
  async #getCategoryRaw(planId: string, categoryId: string): Promise<any> {
    return (await this.client.request<any>(`/plans/${planId}/categories/${categoryId}`)).category
  }

  async createCategory(planId: string, opts: { name: string; groupId?: string; groupName?: string }) {
    this.assertWrites()
    let groupId = opts.groupId
    if (!groupId && opts.groupName) {
      const g = await this.client.request<any>(`/plans/${planId}/categories/groups`, { method: 'POST', body: { category_group: { name: opts.groupName } } })
      groupId = g.category_group.id
    }
    const data = await this.client.request<any>(`/plans/${planId}/categories`, { method: 'POST', body: { category: { name: opts.name, category_group_id: groupId } } })
    this.cache?.invalidate(planId)
    return { id: data.category.id, name: data.category.name }
  }

  async updateCategory(planId: string, categoryId: string, patch: { name?: string; hidden?: boolean; goalTarget?: number | null; goalTargetDate?: string | null; goalFrequency?: string | null; goalNeedsWholeAmount?: boolean | null }) {
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
      await this.#patchMonthCategory(planId, month, fromCategoryId, fromPrior) // rollback
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
    this.cache?.invalidate(planId)
    return { id: data.payee.id, name: data.payee.name }
  }

  async createAccount(planId: string, opts: { name: string; type: string; balance: number }) {
    this.assertWrites()
    const data = await this.client.request<any>(`/plans/${planId}/accounts`, { method: 'POST', body: { account: { name: opts.name, type: opts.type, balance: dollarsToMilli(opts.balance) } } })
    this.cache?.invalidate(planId)
    return { id: data.account.id }
  }

  async createScheduled(planId: string, t: { accountId: string; date: string; amount: number; frequency: string; payeeName?: string; payeeId?: string; categoryId?: string; memo?: string }) {
    this.assertWrites()
    const data = await this.client.request<any>(`/plans/${planId}/scheduled_transactions`, { method: 'POST', body: { scheduled_transaction: { account_id: t.accountId, date: t.date, amount: dollarsToMilli(t.amount), frequency: t.frequency, payee_name: t.payeeName, payee_id: t.payeeId, category_id: t.categoryId, memo: t.memo } } })
    const id = data.scheduled_transaction.id
    const jid = this.journal?.begin(`create scheduled transaction`, [{ kind: 'delete_scheduled', planId, id }])
    if (jid) this.journal!.commit(jid)
    this.cache?.invalidate(planId)
    return { id }
  }

  async updateScheduled(planId: string, id: string, patch: Record<string, unknown>) {
    this.assertWrites()
    const prior = (await this.client.request<any>(`/plans/${planId}/scheduled_transactions/${id}`)).scheduled_transaction
    const body: Record<string, unknown> = { ...patch }
    if (typeof body.amount === 'number') body.amount = dollarsToMilli(body.amount as number)
    const inverse: Record<string, unknown> = {}
    for (const k of Object.keys(body)) inverse[k] = prior[k] ?? null
    const jid = this.journal?.begin(`update scheduled ${id}`, [{ kind: 'patch_scheduled', planId, id, patch: inverse }])
    await this.client.request(`/plans/${planId}/scheduled_transactions/${id}`, { method: 'PUT', body: { scheduled_transaction: { ...prior, ...body } } })
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
      payee_id: prior.payee_id, category_id: prior.category_id, memo: prior.memo,
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
    let actions = 0
    for (const op of entry.inverse) {
      switch (op.kind) {
        case 'delete_transactions':
          for (const id of op.ids) { await this.client.request(`/plans/${op.planId}/transactions/${id}`, { method: 'DELETE' }); actions++ }
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
    return { undone: entry.description, actions }
  }
```

- [ ] **Step 3: Run all core tests** — PASS. **Step 4: Commit** — `git commit -am "feat(core): structure writes (targets, assign, move_money, payees, accounts, scheduled) + undoLast"`

---

### Task 10: Analytics

**Files:**
- Create: `packages/core/src/analytics.ts`, `packages/core/test/analytics.test.ts`
- Modify: `packages/core/src/domain.ts` (thin wrappers), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Txn`, `CategorySnapshot`, account shapes from Task 7.
- Produces pure functions (all dollars; deterministic; unit-testable without a client):
```ts
export function spendingSummary(txns: Txn[], opts: { by: 'category' | 'payee'; compareTxns?: Txn[] }): { key: string; total: number; count: number; prevTotal?: number; changePct?: number | null }[]
export function budgetHealth(input: { readyToAssign: number; categories: CategorySnapshot[]; accounts: { name: string; type: string; balance: number }[] }): { readyToAssign: number; overspent: { name: string; available: number }[]; underfunded: { name: string; goalUnderFunded: number }[]; creditCardStatus: { account: string; owed: number; paymentAvailable: number; covered: boolean }[] }
export function detectRecurring(txns: Txn[]): { payee: string; cadence: 'weekly' | 'monthly' | 'yearly'; lastAmount: number; lastDate: string; occurrences: number; amountChanged: boolean }[]
export function incomeVsExpense(txns: Txn[], todayIso: string): { month: string; income: number; expense: number; net: number; partial: boolean }[]
export function netWorthHistory(txns: Txn[]): { month: string; netWorth: number }[]   // cumulative sum of all txn amounts by month (YNAB starting balances are transactions)
```
- `Ynab` gains wrappers that fetch inputs then call these: `getSpendingSummary(planId, { by, sinceDate?, untilDate?, compareToPrevious? })`, `getBudgetHealth(planId)`, `getRecurringCharges(planId)`, `getIncomeVsExpense(planId, { months? })` (default 6), `getNetWorthHistory(planId)` (fetches with `sinceDate: '2000-01-01'` to defeat the 1-year default). `budgetHealth` credit-card matching: for each account `type === 'creditCard'` with `balance < 0`, find category whose name equals the account name (YNAB's CC payment category convention); `covered = paymentAvailable >= -owed`. Transfers (`transferAccountId !== null`) are excluded from spendingSummary/incomeVsExpense inputs by the wrappers.

- [ ] **Step 1: Write failing tests**

`packages/core/test/analytics.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { spendingSummary, budgetHealth, detectRecurring, incomeVsExpense, netWorthHistory } from '../src/analytics.js'
import type { Txn } from '../src/types.js'

const t = (o: Partial<Txn>): Txn => ({
  id: Math.random().toString(36).slice(2), date: '2026-07-01', amount: -10, payeeName: 'P', payeeId: null,
  categoryName: 'C', categoryId: null, accountName: 'A', accountId: 'a1', memo: null, cleared: 'cleared',
  approved: true, flagColor: null, transferAccountId: null, importId: null, ...o,
})

describe('spendingSummary', () => {
  it('compares against a previous period', () => {
    const cur = [t({ categoryName: 'Dining', amount: -100 })]
    const prev = [t({ categoryName: 'Dining', amount: -80 })]
    const [row] = spendingSummary(cur, { by: 'category', compareTxns: prev })
    expect(row).toMatchObject({ key: 'Dining', total: -100, prevTotal: -80, changePct: 25 })
  })
})

describe('budgetHealth', () => {
  it('flags overspent, underfunded, and CC coverage', () => {
    const res = budgetHealth({
      readyToAssign: -50,
      categories: [
        { id: '1', name: 'Dining', group: 'Fun', hidden: false, assigned: 100, activity: -160, available: -60, goalType: null, goalTarget: null, goalUnderFunded: null, goalPercentageComplete: null },
        { id: '2', name: 'Rent', group: 'Bills', hidden: false, assigned: 0, activity: 0, available: 0, goalType: 'NEED', goalTarget: 1500, goalUnderFunded: 1500, goalPercentageComplete: 0 },
        { id: '3', name: 'Visa', group: 'Credit Card Payments', hidden: false, assigned: 0, activity: 0, available: 200, goalType: null, goalTarget: null, goalUnderFunded: null, goalPercentageComplete: null },
      ],
      accounts: [{ name: 'Visa', type: 'creditCard', balance: -350 }],
    })
    expect(res.overspent).toEqual([{ name: 'Dining', available: -60 }])
    expect(res.underfunded).toEqual([{ name: 'Rent', goalUnderFunded: 1500 }])
    expect(res.creditCardStatus).toEqual([{ account: 'Visa', owed: -350, paymentAvailable: 200, covered: false }])
  })
})

describe('detectRecurring', () => {
  it('finds monthly cadence and amount changes', () => {
    const txns = ['2026-01-15', '2026-02-15', '2026-03-14', '2026-04-15'].map((date, i) =>
      t({ payeeName: 'Netflix', date, amount: i === 3 ? -18.99 : -15.99 }))
    const [r] = detectRecurring(txns)
    expect(r).toMatchObject({ payee: 'Netflix', cadence: 'monthly', lastAmount: -18.99, occurrences: 4, amountChanged: true })
  })
  it('ignores payees with fewer than 3 occurrences', () => {
    expect(detectRecurring([t({}), t({})])).toEqual([])
  })
})

describe('incomeVsExpense', () => {
  it('splits by sign, marks the current month partial', () => {
    const txns = [t({ date: '2026-06-01', amount: 3000 }), t({ date: '2026-06-05', amount: -1200 }), t({ date: '2026-07-02', amount: -100 })]
    expect(incomeVsExpense(txns, '2026-07-15')).toEqual([
      { month: '2026-06', income: 3000, expense: -1200, net: 1800, partial: false },
      { month: '2026-07', income: 0, expense: -100, net: -100, partial: true },
    ])
  })
})

describe('netWorthHistory', () => {
  it('cumulates month over month', () => {
    const txns = [t({ date: '2026-05-01', amount: 1000 }), t({ date: '2026-06-10', amount: -250 }), t({ date: '2026-06-11', amount: -250 })]
    expect(netWorthHistory(txns)).toEqual([
      { month: '2026-05', netWorth: 1000 },
      { month: '2026-06', netWorth: 500 },
    ])
  })
})
```

- [ ] **Step 2: Implement**

`packages/core/src/analytics.ts`:
```ts
import type { Txn, CategorySnapshot } from './types.js'
import { aggregateTxns } from './filters.js'

const r2 = (n: number) => Math.round(n * 100) / 100

export function spendingSummary(txns: Txn[], opts: { by: 'category' | 'payee'; compareTxns?: Txn[] }) {
  const cur = aggregateTxns(txns, opts.by)
  if (!opts.compareTxns) return cur
  const prev = new Map(aggregateTxns(opts.compareTxns, opts.by).map((x) => [x.key, x.total]))
  return cur.map((row) => {
    const prevTotal = prev.get(row.key)
    return {
      ...row, prevTotal,
      changePct: prevTotal === undefined || prevTotal === 0 ? null : r2(((row.total - prevTotal) / Math.abs(prevTotal)) * 100),
    }
  })
}

export function budgetHealth(input: { readyToAssign: number; categories: CategorySnapshot[]; accounts: { name: string; type: string; balance: number }[] }) {
  const visible = input.categories.filter((c) => !c.hidden)
  return {
    readyToAssign: input.readyToAssign,
    overspent: visible.filter((c) => c.available < 0).map((c) => ({ name: c.name, available: c.available })),
    underfunded: visible.filter((c) => (c.goalUnderFunded ?? 0) > 0).map((c) => ({ name: c.name, goalUnderFunded: c.goalUnderFunded! })),
    creditCardStatus: input.accounts
      .filter((a) => a.type === 'creditCard' && a.balance < 0)
      .map((a) => {
        const pay = visible.find((c) => c.name === a.name)
        const paymentAvailable = pay?.available ?? 0
        return { account: a.name, owed: a.balance, paymentAvailable, covered: paymentAvailable >= -a.balance }
      }),
  }
}

const DAY = 86_400_000
function cadenceOf(gaps: number[]): 'weekly' | 'monthly' | 'yearly' | null {
  const med = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!
  if (med >= 5 && med <= 9) return 'weekly'
  if (med >= 26 && med <= 35) return 'monthly'
  if (med >= 350 && med <= 380) return 'yearly'
  return null
}

export function detectRecurring(txns: Txn[]) {
  const byPayee = new Map<string, Txn[]>()
  for (const t of txns) {
    if (!t.payeeName || t.amount >= 0 || t.transferAccountId) continue
    byPayee.set(t.payeeName, [...(byPayee.get(t.payeeName) ?? []), t])
  }
  const out: { payee: string; cadence: 'weekly' | 'monthly' | 'yearly'; lastAmount: number; lastDate: string; occurrences: number; amountChanged: boolean }[] = []
  for (const [payee, list] of byPayee) {
    if (list.length < 3) continue
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date))
    const gaps = sorted.slice(1).map((t, i) => (Date.parse(t.date) - Date.parse(sorted[i]!.date)) / DAY)
    const cadence = cadenceOf(gaps)
    if (!cadence) continue
    const last = sorted[sorted.length - 1]!
    out.push({ payee, cadence, lastAmount: last.amount, lastDate: last.date, occurrences: sorted.length, amountChanged: Math.abs(last.amount - sorted[0]!.amount) > 0.005 })
  }
  return out.sort((a, b) => a.lastAmount - b.lastAmount)
}

export function incomeVsExpense(txns: Txn[], todayIso: string) {
  const months = new Map<string, { income: number; expense: number }>()
  for (const t of txns) {
    const m = t.date.slice(0, 7)
    const g = months.get(m) ?? { income: 0, expense: 0 }
    if (t.amount >= 0) g.income = r2(g.income + t.amount)
    else g.expense = r2(g.expense + t.amount)
    months.set(m, g)
  }
  const currentMonth = todayIso.slice(0, 7)
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, income: v.income, expense: v.expense, net: r2(v.income + v.expense), partial: month === currentMonth }))
}

export function netWorthHistory(txns: Txn[]) {
  const monthly = new Map<string, number>()
  for (const t of txns) {
    const m = t.date.slice(0, 7)
    monthly.set(m, r2((monthly.get(m) ?? 0) + t.amount))
  }
  let acc = 0
  return [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, delta]) => {
    acc = r2(acc + delta)
    return { month, netWorth: acc }
  })
}
```

Wrappers in `domain.ts` (append to class):
```ts
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
    const { spendingSummary } = await import('./analytics.js')
    return { window: { since, until }, rows: spendingSummary(cur.filter((t) => t.amount < 0), { by: opts.by ?? 'category', compareTxns: compareTxns?.filter((t) => t.amount < 0) }) }
  }

  async getBudgetHealth(planId: string) {
    const [month, accountsData] = await Promise.all([this.getMonth(planId, 'current'), this.client.request<any>(`/plans/${planId}/accounts`)])
    const accounts = accountsData.accounts.filter((a: any) => !a.deleted && !a.closed).map((a: any) => ({ name: a.name, type: a.type, balance: milliToDollars(a.balance) }))
    const { budgetHealth } = await import('./analytics.js')
    return budgetHealth({ readyToAssign: month.readyToAssign, categories: month.categories, accounts })
  }

  async getRecurringCharges(planId: string) {
    const { detectRecurring } = await import('./analytics.js')
    return detectRecurring(await this.#allTxns(planId, new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10)))
  }

  async getIncomeVsExpense(planId: string, opts: { months?: number } = {}) {
    const n = opts.months ?? 6
    const since = new Date(Date.now() - n * 31 * 86_400_000).toISOString().slice(0, 10)
    const { incomeVsExpense } = await import('./analytics.js')
    return incomeVsExpense(this.#nonTransfer(await this.#allTxns(planId, since)), new Date().toISOString().slice(0, 10))
  }

  async getNetWorthHistory(planId: string) {
    const { netWorthHistory } = await import('./analytics.js')
    return netWorthHistory(await this.#allTxns(planId, '2000-01-01'))
  }
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit** — `git commit -am "feat(core): analytics (spending summary, health, recurring, income/expense, net worth)"`

---

### Task 11: MCP server app (28-tool table, gating, stdio entry)

**Files:**
- Create: `apps/mcp/src/tools.ts`, `apps/mcp/src/server.ts`, `apps/mcp/src/env.ts`, `apps/mcp/test/server.test.ts`
- Modify: `apps/mcp/src/main.ts`

**Interfaces:**
- Consumes: everything exported from `@walensis/mcp-for-ynab-core` (`Ynab`, `YnabClient`, `DeltaCache`, `UndoJournal`, `RateLimiter`, `WriteDisabledError`).
- Produces: `buildServer(ynab: Ynab, limiter: RateLimiter): McpServer` registering exactly 28 tools; `resolveEnv(env: NodeJS.ProcessEnv, readFile?: (p: string) => string): { token: string; allowWrites: boolean }` (throws with setup instructions when no token).

- [ ] **Step 1: Write failing tests**

`apps/mcp/test/server.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Ynab, RateLimiter } from '@walensis/mcp-for-ynab-core'
import { buildServer } from '../src/server.js'
import { resolveEnv } from '../src/env.js'

async function connect(ynab: Ynab) {
  const server = buildServer(ynab, new RateLimiter())
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

describe('server', () => {
  it('registers exactly 28 tools', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false }))
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(28)
    expect(tools.map((t) => t.name)).toContain('list_transactions')
  })
  it('read tool returns JSON content', async () => {
    const fake = { request: vi.fn(async () => ({ plans: [{ id: 'p1', name: 'Fam', last_modified_on: 'x', currency_format: { iso_code: 'USD' } }] })) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'list_plans', arguments: {} })
    expect(JSON.parse(res.content[0].text)[0].id).toBe('p1')
  })
  it('write tool refuses politely without YNAB_ALLOW_WRITES', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false }))
    const res: any = await client.callTool({ name: 'create_transactions', arguments: { plan_id: 'p1', transactions: [{ account_id: 'a', date: '2026-07-01', amount: -1 }] } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/YNAB_ALLOW_WRITES=1/)
  })
})

describe('resolveEnv', () => {
  it('reads token from env, file, and flags writes', () => {
    expect(resolveEnv({ YNAB_ACCESS_TOKEN: 'abc' })).toEqual({ token: 'abc', allowWrites: false })
    expect(resolveEnv({ YNAB_ACCESS_TOKEN_FILE: '/x', YNAB_ALLOW_WRITES: '1' }, () => ' filetok\n')).toEqual({ token: 'filetok', allowWrites: true })
    expect(() => resolveEnv({})).toThrow(/YNAB_ACCESS_TOKEN/)
  })
})
```

- [ ] **Step 2: Implement `env.ts`**

```ts
import { readFileSync } from 'node:fs'

export function resolveEnv(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): { token: string; allowWrites: boolean } {
  const raw = env.YNAB_ACCESS_TOKEN ?? (env.YNAB_ACCESS_TOKEN_FILE ? readFile(env.YNAB_ACCESS_TOKEN_FILE) : undefined)
  const token = raw?.trim()
  if (!token) throw new Error(
    'No YNAB token found. Set YNAB_ACCESS_TOKEN (or YNAB_ACCESS_TOKEN_FILE) in this MCP server\'s env. ' +
    'Create a token at app.ynab.com → Account Settings → Developer Settings → New Token.')
  return { token, allowWrites: env.YNAB_ALLOW_WRITES === '1' }
}
```

- [ ] **Step 3: Implement `tools.ts`** — the full 28-entry table. Shape:

```ts
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
      fields: z.array(z.string()).optional().describe('project only these fields'),
      aggregate: z.enum(['category', 'payee', 'month']).optional(),
    }, handler: (y, a) => y.listTransactions(a.plan_id, { accountId: a.account_id, categoryId: a.category_id, payeeId: a.payee_id, sinceDate: a.since_date, untilDate: a.until_date, unapprovedOnly: a.unapproved_only, unclearedOnly: a.uncleared_only, search: a.search, minAmount: a.min_amount, maxAmount: a.max_amount, flagColor: a.flag_color, limit: a.limit, offset: a.offset, fields: a.fields, aggregate: a.aggregate }) },
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
  { name: 'assign_budget', description: "Set a category's assigned amount for a month. Undoable.", write: true, schema: { plan_id: planId, month, category_id: z.string(), amount: dollars('New assigned amount') }, handler: (y, a) => y.assignBudget(a.plan_id, a.month, a.category_id, a.amount) },
  { name: 'move_money', description: 'Move assigned money between two categories in a month (atomic: rolls back if the second half fails). Undoable.', write: true, schema: { plan_id: planId, month, from_category_id: z.string(), to_category_id: z.string(), amount: dollars('Amount to move (positive)') }, handler: (y, a) => y.moveMoney(a.plan_id, a.month, a.from_category_id, a.to_category_id, a.amount) },
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
  // ---- system
  { name: 'undo_last', description: 'Undo the most recent write made through this server (create/update/delete/assign/rename). One level at a time, up to 50 entries back.', write: true, schema: {}, handler: (y) => y.undoLast() },
]
```
Count check: 3 + 6 + 4 + 5 + 4 + 5 + 1 = 28.

- [ ] **Step 4: Implement `server.ts` and `main.ts`**

`apps/mcp/src/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Ynab, RateLimiter, WriteDisabledError } from '@walensis/mcp-for-ynab-core'
import { tools } from './tools.js'

export function buildServer(ynab: Ynab, limiter: RateLimiter): McpServer {
  const server = new McpServer({ name: 'mcp-for-ynab', version: '0.1.0' })
  for (const def of tools) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.schema }, async (args: Record<string, unknown>) => {
      try {
        const result = await def.handler(ynab, args)
        const warning = limiter.warning()
        const payload = warning ? { result, warning } : result
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { isError: true, content: [{ type: 'text' as const, text: msg }] }
      }
    })
  }
  return server
}
```

`apps/mcp/src/main.ts`:
```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Ynab, YnabClient, DeltaCache, UndoJournal, RateLimiter } from '@walensis/mcp-for-ynab-core'
import { resolveEnv } from './env.js'
import { buildServer } from './server.js'

const { token, allowWrites } = resolveEnv(process.env)
const limiter = new RateLimiter()
const ynab = new Ynab({
  client: new YnabClient({ token, limiter }),
  cache: new DeltaCache(),
  journal: new UndoJournal(join(homedir(), '.mcp-for-ynab', 'undo.json')),
  allowWrites,
})
const server = buildServer(ynab, limiter)
await server.connect(new StdioServerTransport())
console.error(`mcp-for-ynab ready (writes ${allowWrites ? 'ENABLED' : 'disabled — set YNAB_ALLOW_WRITES=1 to enable'})`)
```

- [ ] **Step 5: Run app tests** — `pnpm -F @walensis/mcp-for-ynab test` → PASS (28 tools; refusal path exercises `WriteDisabledError` message through `isError`).
- [ ] **Step 6: Full build + typecheck** — `pnpm build && pnpm typecheck` → clean.
- [ ] **Step 7: Commit** — `git commit -am "feat(mcp): 28-tool MCP server, read-only default, stdio entry"`

---### Task 12: README, privacy note, live smoke script, .mcpb manifest, server.json

**Files:**
- Create: `README.md`, `PRIVACY.md`, `scripts/smoke.ts`, `apps/mcp/manifest.json` (mcpb), `apps/mcp/server.json` (MCP registry), root `package.json` script `smoke`

**Interfaces:**
- Consumes: `Ynab`, `YnabClient`, `RateLimiter`, `resolveEnv` behavior (env names) from earlier tasks.
- Produces: user-facing install docs; `pnpm smoke` (needs real `YNAB_ACCESS_TOKEN`).

- [ ] **Step 1: Write `scripts/smoke.ts`** (read-only; prints, never writes)

```ts
import { Ynab, YnabClient, DeltaCache, RateLimiter } from '@walensis/mcp-for-ynab-core'

const token = process.env.YNAB_ACCESS_TOKEN?.trim()
if (!token) { console.error('Set YNAB_ACCESS_TOKEN to run the smoke test.'); process.exit(1) }
const y = new Ynab({ client: new YnabClient({ token, limiter: new RateLimiter() }), cache: new DeltaCache(), allowWrites: false })

const plans = await y.listPlans()
console.log(`plans: ${plans.map((p) => `${p.name} (${p.currency})`).join(', ')}`)
const planId = plans[0]!.id
const overview = await y.getPlanOverview(planId)
console.log(`RTA: ${overview.month.readyToAssign} | accounts: ${overview.accounts.length} | age of money: ${overview.month.ageOfMoney}`)
const txns: any = await y.listTransactions(planId, { limit: 5 })
console.log(`recent txns (${txns.total} in window): ${txns.transactions.map((t: any) => `${t.date} ${t.payeeName} ${t.amount}`).join(' | ')}`)
const agg: any = await y.listTransactions(planId, { aggregate: 'category' })
console.log(`top category outflow: ${agg.aggregate[0]?.key} ${agg.aggregate[0]?.total}`)
console.log('smoke: OK (read-only)')
```
Root package.json: add `"smoke": "pnpm -F @walensis/mcp-for-ynab-core build && node --experimental-strip-types scripts/smoke.ts"` (or use `tsx` as a devDependency: `"smoke": "tsx scripts/smoke.ts"` — pick tsx, add it).

- [ ] **Step 2: Write `README.md`** — must include: one-line pitch ("A fast, safe MCP server for YNAB — full budget access for Claude and other AI assistants, read-only by default"); quickstart for Claude Code (`claude mcp add ynab -e YNAB_ACCESS_TOKEN=xxx -- npx -y @walensis/mcp-for-ynab`), Claude Desktop JSON block, `.mcpb` mention; token creation walkthrough; **write-enable section** explaining `YNAB_ALLOW_WRITES=1`, confirmation gates, and undo; tool table (28 rows: name + one-liner); rate-limit note (200/hr shared with other apps on the same token); the YNAB-required disclaimer verbatim: "We are not affiliated, associated, or in any way officially connected with YNAB, or any of its subsidiaries or its affiliates."; MIT + walensis-labs footer. No "YNAB X" phrasing anywhere — always "… for YNAB".

- [ ] **Step 3: Write `PRIVACY.md`** — states: all data flows directly between your machine and api.ynab.com; no telemetry, no third-party services, token stays in your environment; undo journal stored locally at `~/.mcp-for-ynab/undo.json`; delete it any time.

- [ ] **Step 4: Write `apps/mcp/manifest.json`** (mcpb spec):
```json
{
  "manifest_version": "0.2",
  "name": "mcp-for-ynab",
  "display_name": "MCP for YNAB",
  "version": "0.1.0",
  "description": "Full YNAB budget access for AI assistants — read-only by default, with safe gated writes and undo.",
  "author": { "name": "walensis-labs", "url": "https://github.com/walensis-labs" },
  "repository": { "type": "git", "url": "https://github.com/walensis-labs/mcp-for-ynab" },
  "license": "MIT",
  "server": { "type": "node", "entry_point": "dist/main.js", "mcp_config": { "command": "node", "args": ["${__dirname}/dist/main.js"], "env": { "YNAB_ACCESS_TOKEN": "${user_config.ynab_access_token}", "YNAB_ALLOW_WRITES": "${user_config.allow_writes}" } } },
  "user_config": {
    "ynab_access_token": { "type": "string", "title": "YNAB Personal Access Token", "description": "Create at app.ynab.com → Account Settings → Developer Settings", "sensitive": true, "required": true },
    "allow_writes": { "type": "string", "title": "Allow writes (set to 1 to enable)", "default": "", "required": false }
  }
}
```

- [ ] **Step 5: Write `apps/mcp/server.json`** (registry; version synced from package.json at publish time by the workflow):
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
  "name": "io.github.walensis-labs/mcp-for-ynab",
  "description": "Full YNAB budget access for AI assistants — read-only by default, safe gated writes, undo, token-efficient analytics.",
  "repository": { "url": "https://github.com/walensis-labs/mcp-for-ynab", "source": "github" },
  "version": "0.1.0",
  "packages": [{
    "registry_type": "npm", "identifier": "@walensis/mcp-for-ynab", "version": "0.1.0",
    "transport": { "type": "stdio" },
    "environment_variables": [
      { "name": "YNAB_ACCESS_TOKEN", "description": "YNAB Personal Access Token (app.ynab.com → Developer Settings)", "is_required": true, "is_secret": true },
      { "name": "YNAB_ALLOW_WRITES", "description": "Set to 1 to enable write tools (off = read-only)", "is_required": false, "is_secret": false }
    ]
  }]
}
```

- [ ] **Step 6: Run smoke against real budget** — `YNAB_ACCESS_TOKEN=<AJ's token> pnpm smoke` → prints plan/RTA/transactions, "smoke: OK". (AJ provides the token; skip in CI.)
- [ ] **Step 7: Commit** — `git commit -am "docs: README, privacy, smoke script, mcpb manifest, registry server.json"`

---

### Task 13: CI + release pipeline

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/registry-publish.yml`, `.changeset/config.json`, `scripts/verify-published.mjs`, `scripts/build-mcpb.sh`

**Interfaces:**
- Consumes: package layout from Task 1, `server.json`/`manifest.json` from Task 12.
- Produces: green CI on PRs; changesets-driven versioning; OIDC npm publish; manual registry publish; `.mcpb` artifact on release.

- [ ] **Step 1: Changesets**

Run `pnpm add -Dw @changesets/cli && pnpm changeset init`. Edit `.changeset/config.json`: `"access": "public"`, `"baseBranch": "main"`.

- [ ] **Step 2: `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck && pnpm test && pnpm build
  spec-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Diff vendored OpenAPI spec against upstream
        run: |
          curl -fsSL https://api.ynab.com/papi/open_api_spec.yaml -o /tmp/upstream.yaml
          if ! diff -q packages/core/openapi/ynab-v1.yaml /tmp/upstream.yaml >/dev/null; then
            echo "::warning::YNAB OpenAPI spec has drifted upstream — review and re-vendor (pnpm -F @walensis/mcp-for-ynab-core gen:api)"
          fi
```

- [ ] **Step 3: `.github/workflows/release.yml`** (changesets + OIDC trusted publishing)

```yaml
name: Release
on:
  push: { branches: [main] }
concurrency: release-${{ github.ref }}
permissions: { contents: write, pull-requests: write, id-token: write }
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm, registry-url: 'https://registry.npmjs.org' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Create release PR or publish
        uses: changesets/action@v1
        with:
          publish: pnpm changeset publish
          commit: 'chore: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Verify publish landed
        if: steps.changesets.outputs.published == 'true'
        run: node scripts/verify-published.mjs
```
`scripts/verify-published.mjs` (guards changesets' broken already-published grace path — same issue hit in fitness-tools):
```js
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
for (const dir of ['packages/core', 'apps/mcp']) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  const remote = execSync(`npm view ${pkg.name}@${pkg.version} version`, { encoding: 'utf8' }).trim()
  if (remote !== pkg.version) { console.error(`NOT PUBLISHED: ${pkg.name}@${pkg.version}`); process.exit(1) }
  console.log(`ok: ${pkg.name}@${pkg.version}`)
}
```

- [ ] **Step 4: `.github/workflows/registry-publish.yml`** (manual dispatch; server.json version synced from package.json first — order is load-bearing, see fitness-tools 0.3.3 burn)

```yaml
name: MCP Registry Publish
on: workflow_dispatch
permissions: { id-token: write, contents: read }
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync server.json version from package.json
        run: |
          VERSION=$(node -p "require('./apps/mcp/package.json').version")
          node -e "const f='apps/mcp/server.json';const s=require('./'+f);s.version='$VERSION';s.packages[0].version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(s,null,2))"
      - name: Install mcp-publisher
        run: curl -fsSL https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz | tar xz
      - name: Login (GitHub OIDC) and publish
        run: ./mcp-publisher login github-oidc && ./mcp-publisher publish
        working-directory: .
        env: { MCP_SERVER_JSON: apps/mcp/server.json }
```

- [ ] **Step 5: `scripts/build-mcpb.sh`** (run on release tag; attach artifact to GH release)

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm -F @walensis/mcp-for-ynab-core build
pnpm -F @walensis/mcp-for-ynab build
cd apps/mcp
npx -y @anthropic-ai/mcpb pack . ../../mcp-for-ynab.mcpb
echo "built mcp-for-ynab.mcpb"
```

- [ ] **Step 6: Push repo to GitHub and verify CI**

```bash
gh repo create walensis-labs/mcp-for-ynab --public --source . --push
```
Expected: CI runs green on main. (npm trusted-publisher config for `@walensis/*` → done once in npmjs.com UI against this repo+workflow; AJ action.)

- [ ] **Step 7: Commit** — `git add -A && git commit -m "ci: test workflow, changesets release, registry publish, mcpb build" && git push`

---

## Verification (end of plan)

1. `pnpm typecheck && pnpm test && pnpm build` — all green, both packages.
2. `YNAB_ACCESS_TOKEN=... pnpm smoke` against AJ's real budget — OK, read-only.
3. Manual: add to Claude Code (`claude mcp add ynab -e YNAB_ACCESS_TOKEN=... -- node apps/mcp/dist/main.js`), run the spec's success-criteria session: overview → spending question (aggregate) → categorization pass (blocked read-only → enable writes → works with confirm) → target edit → `undo_last`. No milliunits visible; no tool response over ~2k tokens on real data.
4. First release: `pnpm changeset` (minor: initial release 0.1.0) → merge Version PR → verify npm + run registry workflow → attach `.mcpb`.
