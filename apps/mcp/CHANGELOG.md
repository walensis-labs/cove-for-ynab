# @walensis/mcp-for-ynab

## 0.6.0

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

### Patch Changes

- Updated dependencies [d4b0936]
  - @walensis/cove-core@0.5.0

## 0.5.0

### Minor Changes

- c01cc49: `buildServer` takes an optional write-tool allowlist:

  ```ts
  buildServer(ynab, limiter, { writeTools: "none" }); // read tools only
  buildServer(ynab, limiter, { writeTools: ["move_money"] }); // exactly these
  ```

  Default is `'all'` — existing callers are unaffected.

  A tool that cannot be used should be **absent** from the tool list, not present and erroring.
  When a write tool is listed but refuses, a model will call it, read the refusal, and try to route
  around it — in one real case by confidently instructing the user to set an environment variable
  that gated nothing on their deployment. An absent tool produces a clean "I can't do that."

  Write-ness comes from the existing `write` marker on each tool definition, so there is no second
  list to drift. Ledger tools are never filtered: they write only local storage, never YNAB. An
  unrecognized name in the allowlist throws at construction rather than silently registering
  nothing.

  Note this release also carries `@walensis/cove-core`'s breaking write changes — `move_money` and
  `assign_budget` now require confirmation.

### Patch Changes

- Updated dependencies [c01cc49]
  - @walensis/cove-core@0.4.0

## 0.4.1

### Patch Changes

- a2067db: `apps/worker` is now endpoint-only: a single-tenant remote MCP endpoint, nothing autonomous. Always-on credit-card float monitoring (hourly checks, digests, alerts) has moved to the hosted product. Self-hosters who want to build their own monitoring on the same open attribution engine, see [docs/build-your-own-monitoring.md](../docs/build-your-own-monitoring.md).

## 0.4.0

### Minor Changes

- 3a41ac2: Rename local state to `~/.cove/` (was `~/.mcp-for-ynab/`) and identify the server as `cove-for-ynab`, matching the product name. If you have an existing undo journal or ledger, move the directory: `mv ~/.mcp-for-ynab ~/.cove`.

## 0.3.0

### Minor Changes

- 9aaa8e8: Rename the npm packages to match the product: `@walensis/mcp-for-ynab-core` → `@walensis/cove-core`, and `@walensis/mcp-for-ynab` → `@walensis/cove-mcp`. The old package names are deprecated in favor of these — update any install commands, imports, or `workspace:*` references. The MCP registry entry (`io.github.walensis-labs/mcp-for-ynab`) keeps its existing descriptive name for discoverability; only its published package identifier changes to `@walensis/cove-mcp`.

### Patch Changes

- 16bdfc4: Retire the `.mcpb` Claude Desktop extension — one fewer artifact to build, version, and publish. There are now exactly two install paths: local (`npx -y @walensis/cove-mcp`, via `claude mcp add` or the Claude Desktop JSON config) or remote (one URL + token, self-hosted today via `apps/worker`, hosted later). See the README for the full install/tier breakdown.
- Updated dependencies [0c0b8ab]
- Updated dependencies [9aaa8e8]
  - @walensis/cove-core@0.3.0

## 0.2.0

### Minor Changes

- 7029301: Library entrypoint: export the 35-tool table, buildServer, and the month-close playbook for embedding (worker/self-host reuse). CLI behavior unchanged.

### Patch Changes

- Updated dependencies [7029301]
  - @walensis/mcp-for-ynab-core@0.2.0

## 0.1.0

### Minor Changes

- 3e92eb0: Initial public release: 35 tools for YNAB over MCP — full budget read/write coverage (read-only by default, gated writes with confirmation and undo), month-close sessions with blocker-aware gaps, credit-card float history with deterministic cause attribution, balance-forward ledger with historical backfill, and token-efficient analytics. Ships as npx stdio server and Claude Desktop extension.

### Patch Changes

- Updated dependencies [3e92eb0]
  - @walensis/mcp-for-ynab-core@0.1.0
