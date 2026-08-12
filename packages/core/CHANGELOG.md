# @walensis/mcp-for-ynab-core

## 0.7.0

### Minor Changes

- 9edb521: The YNAB API client layer now lives in @walensis/ynab-client; cove-core depends on it and re-exports the full surface, so existing imports keep working.

### Patch Changes

- Updated dependencies [9edb521]
  - @walensis/ynab-client@0.1.0

## 0.6.0

### Minor Changes

- d2a3bdf: **Non-USD budgets no longer get a false "$" in their `*Text` companions — and the alias every tool
  schema documents ('last-used') now actually resolves a symbol.**

  The `*Text` companion added to every monetary value (so a model quotes rather than re-converts a
  number) defaulted to `formatDollars`'s "$" symbol at every call site except `getPlanOverview`. On a
  EUR (or any non-USD) budget, that meant every read except the overview showed a confident, wrong
  `"$100.00"` for what was actually a €100.00 value — worse than the bare number it replaced, because
  a wrong symbol reads as authoritative. A first pass fixed the default but resolved the symbol by
  `find`-ing a plan by id in `GET /plans`'s list — which cannot match `plan_id: 'last-used'` or
  `'default'`, YNAB's own path-param aliases (documented on `getPlanSettingsById`, and on this
  package's own `plan_id` schema). Every alias call silently rendered symbol-less, including for USD
  budgets: a straight regression from `"$1,500.00"` to `"1,500.00"`.

  - Symbol (and full currency format) resolution now goes through `GET /plans/{plan_id}/settings`,
    which accepts the alias directly in the URL — no list, no `find`, same one-call cost. A EUR budget
    sees `"€100.00"`; a USD budget, an alias call, or a call using the real plan id are all unchanged
    or fixed to `"$1,000.00"`-style output as appropriate.
  - The full `CurrencyFormat` (decimals, group/decimal separators, symbol position, `display_symbol`)
    is now honored, not just the symbol — a SEK budget renders `"1 000,00 kr"` instead of
    `"kr1,000.00"`; JPY renders `"¥1,000"` (no cents) instead of `"¥1,000.00"`;
    `display_symbol: false` now actually omits the symbol. USD output is byte-identical.
  - If the format can't be verified (plan not found, offline, malformed response), output renders
    **currency-neutral** — the bare number with no symbol — rather than falling back to "$". An
    unlabeled number is honest; a wrong symbol is not.
  - The format is resolved **at most once per plan per `Ynab` instance**, not once per call site.
    `Ynab` instances are constructed per request in the Workers deployments, so this cache doesn't
    carry across requests — and in a streamable-HTTP MCP deployment a request **is** a tool call, so
    "not one per tool call within it" (this changeset's prior wording) overstated the savings: expect
    at most one extra `/settings` request per tool call that emits money `*Text`, same as before.
    `list_plans`/`listPlans()` is a separate, un-memoized call (see below) and no longer shares this
    cache. `getPlanOverview` now costs one more request than it used to, for both a real and an alias
    `plan_id` (`/plans` for plan metadata, `/plans/{id}/settings` for the format) — an earlier draft of
    this fix seeded the format cache from the `/plans` payload for a real plan id to avoid that extra
    request, but `/plans`' `currency_format` is optional and can be `null` even for a real plan whose
    `/settings` would resolve it; seeding from it unconditionally could permanently cache a
    fully-degraded symbol-less format for an otherwise-resolvable plan. Removed for correctness — the
    format is always resolved live, and all four of `getPlanOverview`'s requests
    (`/plans`, `/plans/{id}/accounts`, `/plans/{id}/months/current`, `/plans/{id}/settings`) fire
    concurrently. **A follow-up worth considering:** a Durable-Object- or KV-backed format cache keyed by planId,
    shared across requests, would collapse this to zero extra `/settings` calls after the first
    request per plan. `Ynab`'s constructor now accepts an injectable `currencySymbol` seam
    (`string | (planId) => Promise<string | undefined>`) for exactly this — a host can wire in its own
    cross-request cache without core needing a persistence primitive.
  - **`listPlans()` is no longer memoized.** It used to share a cache with the symbol lookup (both hit
    `/plans`); in the stdio deployment (one `Ynab` per process) that froze `list_plans`' output at
    first call for the process's whole lifetime — `lastModified` never updated, and a budget created
    after startup never appeared. Decoupling symbol resolution onto its own endpoint removed the
    reason for the shared cache; `listPlans()` now fetches fresh every call, like every other read.
  - **`record_month_close` is network-free again.** Its description says "Writes a LOCAL file only —
    never touches YNAB"; the first pass had it await the symbol lookup before every local-only ledger
    append, contradicting that and spending a rate-limiter slot on a tool documented as offline-safe.
    It no longer resolves a symbol at all — its `*Text` companions render currency-neutral.
  - Seven previously-exported functions (`mapTxn`, `aggregateTxns`, `spendingSummary`, `budgetHealth`,
    `detectRecurring`, `incomeVsExpense`, `netWorthHistory`) still defaulted their `symbol` parameter to
    `"$"` for callers with no currency context — the same unverified-default bug, just on the public
    surface instead of the internal one. `symbol` is now `string | undefined` with no default; an
    explicit `undefined` renders symbol-less. `amount` and every other numeric field are unchanged in
    meaning and type; only `*Text` rendering changed.
  - `@walensis/cove-mcp`: money-touching tool descriptions no longer assert "decimal dollars" —
    they name "decimal major units of the budget's own currency", since a non-USD budget's
    symbol-less `*Text` sitting next to prose that says "dollars" was itself misleading enough to
    invite a model to render `"−1,000.00"` as `"−$1,000.00"`.
  - **A concurrent cache hit on a failed currency lookup no longer throws.** Two calls resolving the
    same plan's currency in one tick (e.g. `getPlanOverview`, `getBudgetHealth`, or any method pairing
    a direct resolve with `getMonth`/`#allTxns` inside one `Promise.all`) used to hand the _second_
    caller the raw, still-rejecting fetch promise if `/settings` failed — one call degraded gracefully
    to symbol-less output as documented, the other threw and the whole operation failed. Both now
    degrade the same way; a transient failure still isn't cached, so the next call retries.
  - **`get_plan_overview` no longer fabricates `"USD"` for the alias `plan_id`s (`'last-used'`,
    `'default'`).** `plan.currency` now comes from the same verified `currency_format` every `*Text`
    companion uses, falling back to `null` — never a guessed code — if it can't be resolved at all.
    This is the same defect CRITICAL 1 fixed for the symbol, closed for the ISO code: previously an
    alias call's `plan.currency` was always `"USD"` regardless of the budget's real currency.
  - `get_plan_overview` makes 4 requests regardless of whether `plan_id` is real or an alias
    (`/plans`, `/plans/{id}/accounts`, `/plans/{id}/months/current`, `/plans/{id}/settings`) — one more
    than the pre-regression baseline of 3, in exchange for the format always being resolved live and
    correctly rather than possibly seeded from a `/plans` payload that can legitimately omit it. All
    four requests fire concurrently, so this costs one extra round-trip of data, not of latency.
  - The injectable `currencySymbol` constructor seam now accepts a full `CurrencyFormatOpts`
    (decimals/separators/symbol position/`display_symbol`), not just a bare string — a string is still
    accepted and still means "just the symbol, US-style formatting otherwise" (unchanged for existing
    callers). A string-only seam couldn't express a SEK plan's format, so a host caching just the
    symbol reintroduced the `"kr1,500.00"` misformatting IMPORTANT 6 fixed for the live path.

  `listPlans()` (the `list_plans` tool) now reports `currency` and `currencySymbol` as **`null`**
  when the plan carries no currency format, instead of defaulting to `"USD"` / `"$"`. The model reads
  that tool's output directly, so a fabricated `"USD"` for a SEK budget was a false statement at the
  source — the same defect the `*Text` work exists to close. Both fields are now `string | null`.

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
