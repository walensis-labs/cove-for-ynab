# Phase 1b: Always-On Worker — design spec

Status: Approved (brainstormed with AJ 2026-07-31; parent: balancing-suite brief §7 Phase 1/§9.7/§10)

## Decisions (settled with AJ)

1. **Scope: monitoring + remote MCP.** Single-tenant Cloudflare Worker in the PUBLIC repo (`apps/worker`, not npm-published) — it is §10 mode-2's self-host recipe. Phase 2's multi-tenant OAuth build is what goes private.
2. **Remote MCP:** Streamable HTTP at `/mcp`, bearer auth (constant-time SHA-256 compare), stateless per-request server — the proven hevy-mcp worker pattern (Hono + `@hono/mcp` StreamableHTTPTransport). Serves the SAME 35-tool table, exported from `@walensis/mcp-for-ynab`.
3. **Email: Cloudflare Email Service** via the `send_email` Workers binding (`env.EMAIL.send({to, from: {email, name}, subject, text, html?})`). Sender domain = config; PREREQUISITE (AJ): domain on Cloudflare + `npx wrangler email sending enable <domain>`.
4. **Cadence:** hourly float scan per card; weekly one-liner digest Sunday morning; monthly close report on the 1st. Alert threshold: gap moved > $250 (config) or any payment-category red. Alerts dedupe per EVENT (signature stored), never per scan. §9.7 quiet-when-healthy governs all copy.
5. **Persistence: D1.** Core refactor: `LedgerLike` interface (methods may return sync or Promise; `Ynab` awaits) — file `LedgerStore` keeps stdio behavior; the worker ships `D1Ledger`. Tables: `ledger_records` (MonthCloseRecord, indexed planId/cutoff/kind/account) + `monitor_state` (card key → lastGapMilli, lastAlertSignature, updatedAt). Schema committed as SQL (OSS per §10).
6. **Tool-table export:** `@walensis/mcp-for-ynab` gains a library entrypoint exporting `tools`, `buildServer`, `MONTH_CLOSE_PLAYBOOK` (bin behavior unchanged). Core + mcp republish as 0.2.0 via the OIDC train.

## Worker surface

- `POST /mcp` (bearer) — full toolset; per-request `Ynab` with: client (PAT secret + limiter), `D1Ledger`, NO undo journal (documented v1 limitation: undo_last reports nothing-to-undo; D1 journal is a follow-up), writes gated by `WORKER_ALLOW_WRITES` var.
- `GET /health` — unauthenticated ok probe.
- `scheduled()` branching on `event.cron`:
  - hourly `0 * * * *`: per card pair → gap now (month-category + account = 2 calls); vs `monitor_state`; on |Δ| > threshold OR red → attribute current month (1 txns fetch) → alert email (cause + "run /month-close; propose_coverage drafts the moves") → store signature.
  - Sunday `0 13 * * SUN`: weekly digest — healthy = one line ("All cards covered. Buffer: $X."); else per-card gap summary.
  - monthly `0 13 1 * *`: close report — last month's gap change + causes + session nudge.
- Secrets: `YNAB_ACCESS_TOKEN`, `MCP_AUTH_TOKEN`. Vars: `CARD_PAIRS` (JSON [{name, paymentCategoryId, cardAccountId}]), `PLAN_ID` ('last-used'), `DIGEST_TO`, `DIGEST_FROM`, `ALERT_THRESHOLD_DOLLARS` (250).

## Out of scope (Phase 2+)

OAuth/multi-tenant, paid gating, LLM narrative emails, D1-backed undo journal, per-category residual attribution, webhooks (none exist).

## Ship checklist

Core 0.2.0 + mcp 0.2.0 on npm (train) → worker deployed to AJ's account → domain email enabled → secrets set → live: /health, /mcp from claude.ai custom connector, forced test digest, one real hourly cycle observed.
