---
"@walensis/cove-core": minor
---

**Non-USD budgets no longer get a false "$" in their `*Text` companions.**

The `*Text` companion added to every monetary value (so a model quotes rather than re-converts a
number) defaulted to `formatDollars`'s "$" symbol at every call site except `getPlanOverview`. On a
EUR (or any non-USD) budget, that meant every read except the overview showed a confident, wrong
`"$100.00"` for what was actually a €100.00 value — worse than the bare number it replaced, because
a wrong symbol reads as authoritative.

- Every `*Text`-emitting method now resolves the plan's real currency symbol (verified from YNAB's
  `currency_format.currency_symbol`, never defaulted) before formatting. A EUR budget now sees
  `"€100.00"`; a USD budget is unchanged (`"$1,000.00"` stays `"$1,000.00"`).
- The symbol is resolved via a single `/plans` fetch, cached per `Ynab` instance, so this doesn't add
  a request per call site. Note: `Ynab` instances are constructed per-request in the Workers
  deployments, so the cache doesn't carry across requests — this adds at most one extra `/plans`
  request to a request that emits any money `*Text`, not one per tool call within it.
  `getPlanOverview`, which already fetches the plan list, adds no extra request at all.
  `list_plans`/`listPlans()`'s own `currencySymbol` field is unaffected (unrelated, pre-existing
  contract).
  **A follow-up worth considering:** a Durable-Object- or KV-backed symbol cache keyed by planId,
  shared across requests, would collapse this to zero extra `/plans` calls after the first request
  per plan — out of scope here since it needs a storage decision at the Workers deployment layer, not
  just `@walensis/cove-core`.
  - If the symbol can't be verified (plan not found, offline, malformed `currency_format`), output
  renders **currency-neutral** — the bare number with no symbol — rather than falling back to "$".
  An unlabeled number is honest; a wrong symbol is not.
- `amount` and every other numeric field are unchanged in meaning and type; only `*Text` rendering
  changed.
