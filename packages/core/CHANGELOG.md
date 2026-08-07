# @walensis/mcp-for-ynab-core

## 0.5.0

### Minor Changes

- d4b0936: **Every monetary value now carries a formatted companion**, and tools stop claiming capabilities
  their deployment doesn't have.

  An assistant reading a real budget reported a −$1,000.00 transaction as −$10.00, then −$1.00, then
  finally −$1,000.00. The conversion was never wrong — `mapTxn` had correctly turned YNAB's
  `-1000000` milliunits into `-1000` decimal dollars. The model simply had no way to know what unit
  it was looking at: no read tool stated one, and `importId` sat beside the amount carrying the raw
  milliunits (`YNAB:-1000000:…`), which invited it to convert a number that was already converted.

  That is a 1000× error on a server that can now move money, and confirmation prompts don't catch it
  — the model confirms using the same misreading.

  - Every emitted amount gains a `<field>Text` companion rendered by `formatDollars`:
    `{ amount: -1000, amountText: "-$1,000.00" }`. `amount` remains decimal dollars; this is purely
    additive. A `money` marker on each tool definition drives both the unit statements and the test
    that enforces them, so a new money-touching tool can't silently ship unlabeled.
  - Money-touching tool descriptions state their unit, read tools included. `record_month_close`'s
    numeric inputs now use the `dollars()` schema helper.
  - `importId` is no longer in `list_transactions`' default output. It answers no user question and
    its embedded raw milliunits triggered the confusion. Still available via explicit `fields`.
  - **"Undoable." is now conditional on an undo journal actually existing.** Five tools advertised
    undo, and `moveMoney`'s half-applied error told callers to run `undo_last`, on deployments that
    keep no journal and don't register that tool. Same failure as the removed `YNAB_ALLOW_WRITES`
    advice: a library asserting facts about a deployment it can't see.
  - `moveMoney`'s half-applied error, without a journal, now names the amount to **restore to**
    rather than the amount moved — `assign_budget` sets an absolute value, so the previous wording
    would have caused a second wrong write.

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
