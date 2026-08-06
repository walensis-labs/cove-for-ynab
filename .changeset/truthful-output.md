---
"@walensis/cove-core": minor
"@walensis/cove-mcp": minor
---

**Every monetary value now carries a formatted companion**, and tools stop claiming capabilities
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
