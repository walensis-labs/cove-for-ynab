# Build your own monitoring

The remote worker (`apps/worker`) is deliberately a **Tool**, not a **Product**: it answers when
asked and does nothing on its own. Always-on credit-card float monitoring — hourly checks, a
digest, alerts — is a **Product** feature and lives in the hosted version of Cove (see the
[root README](../README.md#install-remote)).

If you'd rather not pay for that and would prefer to run your own cron, this doc is a genuine
offer, not a consolation prize: the hard part — figuring out *why* a credit card's payment
category stopped covering what's owed — is `attributeChanges`, and it's fully open in
`@walensis/cove-core`. Everything below it (an hourly `setInterval`/cron, a place to store last
month's numbers, sending yourself a notification) is glue you can write in well under 100 lines.

## What's exported

`@walensis/cove-core` exports everything the hosted product's monitor is built on:

- `YnabClient` — a thin, rate-limited fetch wrapper around the YNAB API (`client.request<T>(path, opts)`).
- `Ynab` — the higher-level domain class, if you'd rather call `getCreditCardFloatHistory` than
  hand-roll the fetches below.
- `attributeChanges(points, cardTxns)` — the attribution engine: given a month's gap change, its
  assignment delta, and the card's transactions, returns which of `deliberate_cover`,
  `payment_category_drain`, `payment_reversal`, `uncategorized_debt`, `overpayment_absorption`,
  `uncovered_spending`, or `unattributed` explain it, with dollar amounts and evidence.
- `floatSeries` / `monthRange` — build a multi-month gap series from category-balance + transaction
  history, if you want a backfill instead of (or in addition to) an hourly point.
- `LedgerLike` — the interface `D1Ledger` (used by `apps/worker`) and the stdio server's local
  `LedgerStore` both implement, if you want your own monitor to read/write the same ledger records.
- `milliToDollars` — YNAB's API is all-milliunits; use this when formatting a message for a human.

## The gap identity

A credit card is "covered" when its payment category has enough assigned to pay it off. In raw
YNAB milliunits, for one card:

```
gapMilli = paymentCategory.balance + cardAccount.balance
```

`cardAccount.balance` is **negative** when you owe money on the card (YNAB's convention for
liability accounts), so this sum is `available - owed`: zero or positive means covered, negative
means the payment category is short. Both numbers come straight off the API — no derivation needed:

```
GET /plans/{plan_id}/months/current/categories/{payment_category_id}   →  category.balance, category.budgeted
GET /plans/{plan_id}/accounts/{card_account_id}                        →  account.balance
```

## A worked sketch: hourly check

```ts
import { YnabClient, RateLimiter, attributeChanges, milliToDollars } from '@walensis/cove-core'

interface StoredState { gapMilli: number; budgetedMilli: number; month: string }

// however you persist this — KV, D1, a JSON file, a database row. One entry per card.
declare function readState(cardKey: string): Promise<StoredState | undefined>
declare function writeState(cardKey: string, state: StoredState): Promise<void>
declare function notify(message: string): Promise<void> // ntfy, a webhook, email, whatever

async function checkCard(client: YnabClient, planId: string, pair: {
  name: string; paymentCategoryId: string; cardAccountId: string
}): Promise<void> {
  const month = new Date().toISOString().slice(0, 7) // YYYY-MM — see the gotcha below

  const [catData, acctData] = await Promise.all([
    client.request<{ category: { balance: number; budgeted: number } }>(
      `/plans/${planId}/months/current/categories/${pair.paymentCategoryId}`,
    ),
    client.request<{ account: { balance: number } }>(
      `/plans/${planId}/accounts/${pair.cardAccountId}`,
    ),
  ])
  const availableMilli = catData.category.balance
  const gapMilli = availableMilli + acctData.account.balance
  const budgetedMilli = catData.category.budgeted

  const prev = await readState(pair.cardAccountId)
  await writeState(pair.cardAccountId, { gapMilli, budgetedMilli, month })
  if (!prev) return // first-ever observation: baseline only, nothing to compare against yet

  const gapChangeMilli = gapMilli - prev.gapMilli
  if (Math.abs(gapChangeMilli) < 10) return // below the noise floor attributeChanges itself uses

  // Month rollover gotcha (below) — a same-month diff is fine; a cross-month diff is not.
  const assignedMilli = month === prev.month ? budgetedMilli - prev.budgetedMilli : budgetedMilli

  const txnsData = await client.request<{ transactions: any[] }>(
    `/plans/${planId}/accounts/${pair.cardAccountId}/transactions`,
    { query: { since_date: `${month}-01` } },
  )
  const [attributed] = attributeChanges(
    [{ month, gapChangeMilli, availableMilli, assignedMilli }],
    txnsData.transactions,
  )
  const causes = (attributed?.components ?? [])
    .map((c) => `${c.cause}: ${milliToDollars(c.amountMilli)}`)
    .join(', ')

  await notify(`${pair.name}: gap moved ${milliToDollars(gapChangeMilli)} → ${causes || 'unattributed'}`)
}

// wherever your scheduler lives (Cloudflare cron trigger, node-cron, a systemd timer...):
async function hourlySweep(cards: { name: string; paymentCategoryId: string; cardAccountId: string }[]) {
  const client = new YnabClient({ token: process.env.YNAB_ACCESS_TOKEN!, limiter: new RateLimiter() })
  for (const pair of cards) {
    await checkCard(client, process.env.PLAN_ID ?? 'last-used', pair)
  }
}
```

That's the whole shape: fetch two numbers, diff against what you stored last time, hand the delta
(plus the assignment delta) to `attributeChanges`, notify if it's above your threshold. `Ynab`'s
own `hourlySweep`/`decideAlert` equivalents in the hosted product add alert-signature dedup,
red-card detection, and delivery — but the attribution call is identical to what's above.

## The month-boundary gotcha

`category.budgeted` is **this month's** assigned amount — it resets to whatever you assign fresh
each month, it does not accumulate across months. If your stored state is a raw `budgeted`
number with no month tag, the first check after a month rolls over will diff *this* month's fresh
(possibly small or zero) `budgeted` against *last* month's accumulated total and read it as a huge
phantom drain, when nothing actually happened except the calendar turning over.

The fix is the `month` field in `StoredState` above: only compute `budgetedMilli - prev.budgetedMilli`
when `month === prev.month`. On a rollover, treat the fresh `budgetedMilli` as the assignment delta
outright (whatever's been assigned so far this month, from a start of zero) rather than diffing
across the boundary. This is exactly what `assignedDeltaMilli` does internally in the hosted
product's monitor — the logic is small enough to inline, which is why it isn't its own export.

## If you'd rather not run this yourself

The hosted product (see the [root README](../README.md#install-remote)) runs this same
attribution pipeline hourly, adds a quiet Sunday digest and a monthly close report, and delivers by
email — no cron infrastructure, no state store, no scheduler to babysit. But if you're the kind of
person who'd rather own the loop, everything above it is yours for free.
