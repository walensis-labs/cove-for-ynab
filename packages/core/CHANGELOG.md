# @walensis/mcp-for-ynab-core

## 0.4.0

### Minor Changes

- c01cc49: **Breaking.** Two changes to write behavior. Under 0.x, this ships as a minor bump so `^0.3.0`
  consumers do not pick it up automatically — upgrade deliberately.

  **`WriteDisabledError` no longer names an environment variable.** Its message was hardcoded to
  `"…set the environment variable YNAB_ALLOW_WRITES=1…"`, which gates only the stdio server —
  `WORKER_ALLOW_WRITES` gates the self-hosted worker, and a hosted multi-tenant deployment has no
  flag at all. A library cannot know its deployment shape, and in practice this told a hosted user
  to reconfigure a server they do not operate. The default message is now
  `"Writes are disabled on this server."` and hosts inject their own remediation text via a new
  `writeDisabledHint` option on `Ynab`:

  ```ts
  new Ynab({
    client,
    allowWrites: false,
    writeDisabledHint: "Set FOO=1 and restart.",
  });
  ```

  **`moveMoney` and `assignBudget` now require `confirm: true`.** Reallocating budgeted money was
  the only mutating operation with no confirmation gate, while deletes and bulk updates already had
  one. Both now throw `ConfirmationRequiredError` without it, matching the existing pattern.

  Also in this release: every write returns an `inverse` string describing how to reverse itself
  (additive), and bulk `updateTransactions` now reads prior values in **one** request instead of one
  per row — a 40-row update dropped from 41 API calls to 2, which matters against YNAB's 200/hour
  limit.

## 0.3.0

### Minor Changes

- 9aaa8e8: Rename the npm packages to match the product: `@walensis/mcp-for-ynab-core` → `@walensis/cove-core`, and `@walensis/mcp-for-ynab` → `@walensis/cove-mcp`. The old package names are deprecated in favor of these — update any install commands, imports, or `workspace:*` references. The MCP registry entry (`io.github.walensis-labs/mcp-for-ynab`) keeps its existing descriptive name for discoverability; only its published package identifier changes to `@walensis/cove-mcp`.

### Patch Changes

- 0c0b8ab: Bind the global fetch in YnabClient. Stored as a property and invoked as a method, an unbound global `fetch` throws "Illegal invocation" under workerd — the client worked on Node but failed in any Cloudflare Worker deploy.

## 0.2.0

### Minor Changes

- 7029301: LedgerLike interface: Ynab accepts any sync-or-async ledger implementation (file LedgerStore unchanged; enables D1-backed ledgers in workers).

## 0.1.0

### Minor Changes

- 3e92eb0: Initial public release: 35 tools for YNAB over MCP — full budget read/write coverage (read-only by default, gated writes with confirmation and undo), month-close sessions with blocker-aware gaps, credit-card float history with deterministic cause attribution, balance-forward ledger with historical backfill, and token-efficient analytics. Ships as npx stdio server and Claude Desktop extension.
