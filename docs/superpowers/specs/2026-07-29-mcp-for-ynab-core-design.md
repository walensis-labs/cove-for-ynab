# mcp-for-ynab — Core MCP Server Design

**Date:** 2026-07-29
**Status:** Approved (pending spec review)
**Scope:** v1 core MCP server only. Wedge workflows, prompts/resources, OAuth, and the hosted tier are explicitly deferred (see Deferred).

## Goal

Build the best YNAB MCP server: full-coverage, token-efficient, safe-by-default, distributed through every free channel (npm, `.mcpb`, official MCP registry). Free and MIT-licensed as the open core of a future paid hosted tier. The product wedge (which workflow it's *famous* for) is deliberately undecided — v1 exists so we can play against a real budget and let the wedge emerge.

## Market context (condensed from 2026-07-28/29 research)

- ~118 "ynab mcp" repos exist; ~7 serious. Current best (oliverames/ynab-mcp-server) has ~10★ / ~500 npm dl/wk. Stars anti-correlate with quality. Distribution, not features, is the unclaimed prize.
- No official YNAB AI anything; no one holds a "Works with YNAB" listing (requires OAuth + 2–4 wk review; also lifts the 25-user OAuth cap). Paid YNAB add-ons are established (Sync for YNAB £3.99/mo); ecosystem price ceiling ≈ $2–4/mo.
- The documented failure mode is token blowup: a naive server returned ~746k tokens for a year of transactions; server-side aggregation cut equivalent queries to ~262 tokens. Read-only-by-default is a trust requirement in this market.
- YNAB API v1.86 (2026) is newly AI-friendly: `/plans/...` paths, writable goals/targets, category/payee/account creation, money movements, `_formatted`/`_currency` companion fields, delta requests. Official `ynab` JS SDK lags these endpoints.
- Hard API constraints: 200 req/hr/token; no webhooks; transaction GETs default to a 1-year `since_date`; subtransactions of existing splits are immutable (delete/recreate); no payee delete/merge; no plan create/delete.

## Decisions (settled with AJ)

| Decision | Choice |
|---|---|
| v1 scope | Full API coverage incl. writes; read-only by default; gated writes |
| Tool architecture | Curated + composite (~28 tools); server-side aggregation; no raw passthrough |
| Naming | YNAB-branding-compliant from day one ("X for YNAB" pattern) |
| Brand/org | **walensis** (new GitHub org + npm scope) — finance-side house brand, separate from almostjacked (fitness) |
| Dogfood | AJ's real budget via PAT (read-only default protects it) |
| Wedge | Deferred until after play phase |

## Identity

- GitHub: `walensis/mcp-for-ynab` (public, MIT)
- npm: `@walensis/mcp-for-ynab` (stdio server), `@walensis/mcp-for-ynab-core` (pure logic)
- MCP registry: `io.github.walensis/mcp-for-ynab`
- Working dir: `~/develop/mcp-for-ynab`
- One-time setup owed: create `walensis` GitHub org (web-only) and npm org; configure trusted publishing/OIDC for the new scope. Known suite gotchas apply (server.json synced from package.json immediately before registry publish; never pre-publish a dangling version).

## Architecture

Monorepo (pnpm workspaces), mirroring hevy-mcp:

```
packages/core   @walensis/mcp-for-ynab-core — API client, domain logic, aggregation,
                milliunit/dollar conversion, undo journal, rate limiter. No MCP dependency.
apps/mcp        @walensis/mcp-for-ynab — stdio MCP server over core. Ships .mcpb.
```

The core/apps seam is the future hosted seam: a Cloudflare Worker (private cloud repo under walensis) imports core, adds OAuth + scheduling. No worker ships in v1.

**API client is generated from YNAB's pinned OpenAPI spec** (`openapi-typescript` + typed fetch wrapper), not the official `ynab` SDK — the SDK lags 2026 endpoints (money movements, goal writes) and still uses legacy `/budgets` naming. We target `/plans/...` paths. The spec file is vendored + pinned; a CI job diffs against upstream to flag API changes.

### Units and conventions

- **Decimal dollars everywhere** (strings formatted per plan currency where useful). Core converts milliunits both directions; models never see milliunits.
- **Delta requests** (`last_knowledge_of_server`) + per-session in-memory cache on all list endpoints that support them. Cache keyed by plan; invalidated on our own writes.
- The API's silent **1-year transaction lookback** is surfaced: `list_transactions` takes explicit `since_date`/`until_date` and its output states the effective window.
- All list outputs are **compact by default** (lean field set) with `fields` selection and pagination (`limit`/`offset`); aggregate modes return computed numbers, not rows.

## Tool surface (28 tools)

**Overview**
1. `list_plans` — id, name, currency, last modified.
2. `get_plan_overview` — composite: accounts w/ balances + current month (RTA, age of money, activity) + category-group totals. The "orient yourself" call.
3. `get_month` — one month's full detail: RTA, `goal_under_funded`, per-category assigned/activity/balance.

**Transactions**
4. `list_transactions` — unified filters (account/category/payee/date range/flag/unapproved/uncleared/search text/amount range), pagination, field selection, and `aggregate` mode (sum/count grouped by category|payee|month). Delta-backed.
5. `get_transaction` — full detail incl. subtransactions.
6. `create_transactions` — bulk; splits via `subtransactions`; `import_id` for dedup.
7. `update_transactions` — bulk edit/categorize/approve; requires `confirm` + `expected_count` when touching >5 rows.
8. `delete_transaction` — requires `confirm: true`.
9. `import_transactions` — triggers linked-account import.

**Scheduled transactions**
10. `list_scheduled_transactions`
11. `create_scheduled_transaction`
12. `update_scheduled_transaction`
13. `delete_scheduled_transaction` — `confirm: true`.

**Plan structure**
14. `list_categories` — compact, balances + target status (`goal_target`, `goal_under_funded`, `goal_percentage_complete`).
15. `create_category` — optional new-group creation via `group_name`.
16. `update_category` — rename, hide, and **targets**: `goal_target`, `goal_target_date`, `goal_frequency`, `goal_needs_whole_amount`.
17. `assign_budget` — set a category's `budgeted` for a month (`current` supported).
18. `move_money` — composite: decrease source category, increase destination, same month, atomic-with-rollback (second PATCH failure reverts the first).

**Payees**
19. `list_payees` — with transaction counts (from cache) to expose cruft.
20. `rename_payee`
21. `create_payee`

**Accounts**
22. `create_account` — the 6 creatable types.

**Analytics (server-side math, small outputs)**
23. `spending_summary` — by category/payee over a period, optional prior-period or year-over-year comparison.
24. `budget_health` — RTA state, overspent categories, underfunded targets, credit-card payment alignment (float detection primitive).
25. `detect_recurring_charges` — subscription/bill detection from history with cadence + last-amount-change.
26. `income_vs_expense` — monthly series over N months, partial-month flagged.
27. `net_worth_history` — account-balance time series from transaction history.

**System**
28. `undo_last` — reverts the most recent journaled write batch.

Excluded from v1: payee locations, money-movement read tools (fold into a later month-end composite), user endpoint (internal only).

## Safety model

- **Read-only by default.** Write tools are registered but return a refusal with setup instructions unless `YNAB_ALLOW_WRITES=1`. (Registered-but-gated keeps the surface discoverable; the refusal text teaches the flag.)
- **Confirmation gates:** deletes and bulk updates (>5 rows) require `confirm: true`; bulk updates also require `expected_count`, aborting on mismatch.
- **Undo journal** at `~/.mcp-for-ynab/undo.json`: every write batch records its inverse (previous values / created ids) before the API call, marked committed after. `undo_last` replays the inverse. Caveat documented: split creations undo via delete; split *edits* aren't possible upstream.
- **Rate limiter:** client-side token bucket at 190/hr; tool responses append a warning when <50 remain; hard-stop with clear message at 0 rather than eating 429s.
- Token never logged; redacted from error output.

## Auth & distribution (v1)

- Auth: `YNAB_ACCESS_TOKEN` env (PAT). `YNAB_ACCESS_TOKEN_FILE` also supported (secret-manager friendly).
- Channels at launch: npm (npx runnable), `.mcpb` desktop-extension bundle attached to GitHub releases, official MCP registry listing (with `environmentVariables` metadata from day one), README badges + Cursor/VS Code deep links.
- Release pipeline: changesets → Version Packages PR → OIDC npm trusted publishing → registry publish workflow (server.json synced from package.json at publish time) → `.mcpb` on release. Same guards as fitness-tools (`verify-published` check).
- Privacy: no telemetry, no data leaves the machine except to `api.ynab.com`. Stated in README + `.mcpb` manifest privacy field.

## Error handling

- 429 → plain-language message with the rolling-window explanation and retry guidance.
- YNAB 403.x (subscription lapsed / trial expired / scope / data limit) → mapped to human-readable causes.
- Write failures never leave the journal inconsistent (journal-first, commit-mark after).
- Generated-client errors carry the YNAB error `detail` through to the model.

## Testing

- Vitest unit tests in core: milliunit conversion (round-trip, negative, rounding), filter/aggregation logic, undo inverse construction, rate-limiter behavior.
- Contract tests: generated client vs pinned OpenAPI spec; fixture-based response parsing (recorded, sanitized).
- Live smoke script (`scripts/smoke.ts`): read-only pass against AJ's real plan via PAT — list plans, overview, transactions page, one aggregate — run manually pre-release.
- CI: typecheck, lint, tests, spec-drift check.

## Deferred (explicitly not v1)

- MCP prompts + methodology resources (wedge-shaped; write after play).
- Workflow composites (`diagnose_reconciliation`, month-end copilot, Amazon splits, partner digest) — the analytics primitives above are their seams.
- OAuth, hosted Worker, cloud repo, paid tier ($2–4/mo band per research; hosted = scheduling/digests/zero-setup).
- Works-with-YNAB listing (requires OAuth; doubles as 25-user-cap review).
- SQLite persistent cache (in-memory is enough for stdio sessions).

## Success criteria

1. AJ can connect Claude (Desktop via `.mcpb`, Code via npx) to his real budget and do a full "play" session — orientation, spending questions, a categorization pass, a target edit, an undo — without a 429, a milliunit ever surfacing, or any single tool response exceeding ~2k tokens on his data.
2. Listed in the official MCP registry at launch.
3. Zero-warning `npx @walensis/mcp-for-ynab` cold start with only `YNAB_ACCESS_TOKEN` set.
