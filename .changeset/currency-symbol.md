---
"@walensis/cove-core": minor
"@walensis/mcp-for-ynab": patch
---

**Non-USD budgets no longer get a false "$" in their `*Text` companions — and the alias every tool
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
  cache, so `getPlanOverview` now costs one more request than it used to (`/plans` for plan
  metadata, `/plans/{id}/settings` for the format) — still one settings fetch, not one per field.
  **A follow-up worth considering:** a Durable-Object- or KV-backed format cache keyed by planId,
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
- `@walensis/mcp-for-ynab`: money-touching tool descriptions no longer assert "decimal dollars" —
  they name "decimal major units of the budget's own currency", since a non-USD budget's
  symbol-less `*Text` sitting next to prose that says "dollars" was itself misleading enough to
  invite a model to render `"−1,000.00"` as `"−$1,000.00"`.
