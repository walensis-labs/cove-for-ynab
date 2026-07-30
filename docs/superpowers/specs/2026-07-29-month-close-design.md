# month_close + propose_coverage — design spec

Status: Approved (authored by AJ after the v0.1.0 play phase — first wedge-shaped feature)
Repo adaptation notes are at the bottom; the spec body is AJ's, verbatim.

---
# `month_close` — spec for MCP for YNAB

Add two read-only tools to the existing YNAB MCP server, plus reuse of the
`assign_budget` / `move_money` tools already present.

**Goal:** close out a month after it has already rolled over, without touching
the following month's transactions, and verify that each credit card's payment
category available matches that card's balance as of the cutoff date.

**Hard constraint:** neither new tool moves money. They return proposals only.
The user reviews, then approves specific moves, which are applied with the
existing write tools.

---

## Background: why two as-of balances

A credit card payment category's available changes when a transaction is
*entered*, not when it clears. So:

- Comparing available to the **cleared** balance shows a false gap for every
  uncleared charge.
- Comparing available to the **working** balance (all entered transactions,
  cleared or not) is the correct check.

Both numbers are needed, for different jobs:

| Number | Compare against | Answers |
|---|---|---|
| `clearedAsOf` | bank statement | "can I reconcile?" |
| `workingAsOf` | payment category available | "is the card actually covered?" |

The category side needs no new work: YNAB's month endpoint already returns a
historical snapshot of each category's available at that month's end, and it
does not drift as the current month progresses.

---

## Tool 1: `month_close`

```
month_close(cutoff: string, lookback_days?: number = 120)
```

`cutoff` is an ISO date, normally the last day of the closing month
(`2026-07-31`). `lookback_days` bounds how far back to scan for stragglers.

### Returns

```jsonc
{
  "cutoff": "2026-07-31",
  "perCard": [
    {
      "account": "Citi Card",
      "workingAsOf": -3291.76,
      "clearedAsOf": -3291.76,
      "availableAtMonthEnd": 2662.65,
      "gap": -629.11,          // workingAsOf + availableAtMonthEnd
      "paymentCategoryId": "..."
    }
  ],
  "blockers": {
    "unapproved": [ { "id": "...", "date": "...", "payee": "...", "account": "...", "amount": -42.10 } ],
    "uncategorized": [ /* same shape */ ],
    "unclearedBeforeCutoff": [ /* same shape */ ]
  },
  "redCategories": [
    { "id": "...", "name": "Kid Things", "available": -348.17, "group": "Just for Fun" }
  ],
  "donors": [
    { "id": "...", "name": "...", "group": "...", "available": 412.00, "excess": 412.00, "hasTarget": false }
  ]
}
```

`gap` of `0` means the card is covered. Negative means the payment category is
short by that amount. Positive means over-assigned.

Note the sign convention: card balances are negative when money is owed, and
available is positive, so `gap = workingAsOf + availableAtMonthEnd`.

### Data fetches

Three calls, one round of `Promise.all`:

1. `GET /budgets/last-used/accounts`
2. `GET /budgets/last-used/transactions?since_date=<cutoff − lookback_days>`
3. `GET /budgets/last-used/months/<first day of cutoff's month>`

A single transactions fetch covers both needs: everything after the cutoff (to
back out of current balances) and the pre-cutoff window (to find blockers).
Do **not** pass `until_date` here — post-cutoff rows are required.

### As-of math

Work backward from the balances YNAB already computes. Do not sum from account
inception.

```js
workingAsOf = account.balance         - sum(all txns where date > cutoff)
clearedAsOf = account.cleared_balance - sum(cleared txns where date > cutoff)
```

### Donor ranking

A donor is a non-hidden, non-deleted category outside the Credit Card Payments
group with positive available:

- No target → `excess = available`
- Has a target → `excess = available - goal_target`, only if positive

Sort by `excess` descending. Exclude any category appearing in
`redCategories`. Exclude internal categories (the API marks these with an
`internal` flag on the category resource).

---

## Tool 2: `propose_coverage`

```
propose_coverage(cutoff: string, strategy?: "donors_first" | "rta_only" = "donors_first")
```

Runs `month_close`, then returns an ordered list of suggested moves to bring
every red category to zero. Returns proposals; applies nothing.

```jsonc
{
  "moves": [
    { "from": "Dining Out", "fromId": "...", "to": "Kid Things", "toId": "...", "amount": 348.17, "source": "category" },
    { "from": "Ready to Assign", "fromId": null, "to": "Medical", "toId": "...", "amount": 172.40, "source": "rta" }
  ],
  "unfundable": [],
  "rtaUsed": 172.40,
  "rtaRemaining": 7005.65
}
```

Under `donors_first`, exhaust the ranked donor list before drawing on Ready to
Assign. Every move that falls back to RTA must be tagged `"source": "rta"` so
it is visibly distinguishable in review.

Do not split a single red category across more than three donors — beyond that
it is easier to review as one RTA draw. Surface anything that cannot be covered
in `unfundable` rather than partially funding it silently.

---

## Implementation notes

These are the things that will bite.

**Milliunits.** All API amounts are thousandths of a currency unit; 1000 = one
dollar. Divide by 1000 only at the output boundary, and do all accumulation in
integers. Never introduce floats before the final division.

**`since_date` defaults to one year ago.** If omitted, older transactions are
silently excluded, including the starting-balance transaction. This is why the
as-of math works backward from current balances instead of summing history —
but it also means `lookback_days` must never be allowed to exceed one year
without an explicit `since_date`.

**Split transactions.** The list endpoint returns parent rows with nested
`subtransactions`. Sum parent `amount` only, or every split double-counts. For
categorization checks, walk the subtransactions — a parent can look fine while
one leg is uncategorized.

**Transfers have no category by design.** Card payments are transfers with a
null `category_id` and a non-null `transfer_account_id`. Filter these out
before counting uncategorized, or every payment becomes a false positive.

**Account → payment category mapping is the weak point.** The API does not
expose a direct link from a credit card account to its payment category. Match
on name within the Credit Card Payments group, normalizing case and
whitespace. Emit a warning in the response for any credit card account that
fails to match rather than silently dropping it — a missing card looks
identical to a covered one otherwise.

**"Available" is called `balance` on the month category resource.** Not
`available`. Easy to mis-wire and get plausible-looking wrong numbers.

**Unapproved has no accounting effect.** Approval is a review flag only; an
unapproved transaction already counts toward balances and has already moved
money to the payment category if it carries a category. Report it because
import-guessed categories are often wrong, not because it changes any math.

---

## Validation

Before trusting output:

1. Pick a card and set `cutoff` to today. `workingAsOf` must equal the
   account's current `balance`, and `clearedAsOf` its `cleared_balance`.
2. Set `cutoff` to the last day of the current month with no future-dated
   transactions present. Same equality should hold.
3. Cross-check one card's `availableAtMonthEnd` against the YNAB web UI with
   the closing month selected.
4. Confirm a known card payment does not appear in `blockers.uncategorized`.

---

## Workflow this supports

Order matters; each step changes the next step's inputs.

1. Import and enter everything dated on or before the cutoff. Nothing after.
2. Approve and categorize those transactions. Scrutinize import-assigned
   categories — a wrong guess pulls money from a category never touched.
3. `month_close` — blockers should now be empty.
4. `propose_coverage` — review, approve, apply via `move_money`.
5. `month_close` again. Any remaining `gap` is historical, not this month's
   overspending.
6. Assign the residual directly to short payment categories via
   `assign_budget`.
7. Reconcile each card against `clearedAsOf` and the statement.
8. Leave the following month alone.

Steps 4 and 6 are the only ones that move money, and both are user-approved.

---

## Repo adaptation addendum (verified against packages/core/openapi/ynab-v1.yaml v1.86 and the current code, 2026-07-29)

- Paths: this codebase uses `/plans/...` (current API naming), not `/budgets/...`. Same endpoints. `last-used` passes through as plan_id.
- VERIFIED: `internal: boolean` exists on both Category and CategoryGroup schemas — donor exclusion uses it directly (belt: also exclude the "Credit Card Payments" group by name for the payment categories themselves).
- VERIFIED: `cleared_balance` on Account; month category `balance` = available; `transfer_account_id` on transactions; subtransactions carry `category_id`, `transfer_account_id`, `deleted`.
- Implementation layer: new domain methods work from RAW client responses (integer milliunits end-to-end, per the milliunits note) — they do NOT reuse `mapTxn`, whose subtransaction mapping drops `category_id`, and whose amounts are already dollars. Dollars only at the output boundary via `milliToDollars`.
- `lookback_days` is clamped to ≤ 365 (the API's silent one-year default would otherwise truncate the window).
- `rtaRemaining`/RTA draw source: the cutoff month's `to_be_budgeted` from the same month fetch (proposals target the closing month; applying them via assign_budget/move_money uses that month).
- Tool count moves 28 → 30; both new tools are read-only (no write gate).
- The two existing write tools referenced (`assign_budget`, `move_money`) already exist with per-month parameters — no changes needed.
