# get_category_history + credit_card_float_history — design spec

Status: Approved (AJ-authored reference implementation, 2026-07-30; both tools confirmed in scope)
The reference code below is AJ's, verbatim; repo adaptation addendum at the bottom.

---

```typescript
// ---------------------------------------------------------------------------
// get_category_history — one cheap call for a single category's monthly series
//
// Why this exists: get_month returns the ENTIRE budget (~140 categories) per
// month, so pulling a 2-year series for ONE category means ~24 huge payloads.
// The YNAB API has a per-category-per-month endpoint that returns just that one
// category. This tool loops the range server-side and returns a compact series,
// so the whole "did EOM balance match the payment category?" analysis becomes a
// single tool call with a tiny response.
//
// YNAB field mapping (all amounts are milliunits -> divide by 1000):
//   category.budgeted -> "Assigned"
//   category.activity -> "Activity"
//   category.balance  -> "Available"   (this is the number the app shows)
//
// Endpoint: GET /budgets/{budget_id}/months/{YYYY-MM-01}/categories/{category_id}
// Docs: https://api.ynab.com/v1#/Categories/getMonthCategoryById
// ---------------------------------------------------------------------------

const YNAB_BASE = "https://api.ynab.com/v1";

interface MonthPoint {
  month: string;      // "2026-06"
  assigned: number;   // dollars
  activity: number;   // dollars
  available: number;  // dollars  (YNAB "balance")
}

const mu = (n: number) => Math.round(n) / 1000; // milliunits -> dollars

/** Inclusive list of first-of-month ISO dates between two YYYY-MM strings. */
function monthRange(sinceMonth: string, untilMonth: string): string[] {
  const out: string[] = [];
  const [sy, sm] = sinceMonth.split("-").map(Number);
  const [uy, um] = untilMonth.split("-").map(Number);
  let y = sy, m = sm;
  while (y < uy || (y === uy && m <= um)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Fetch one category's assigned/activity/available for each month in the range.
 * budgetId defaults to "last-used" (YNAB accepts that literal).
 * Concurrency is capped so we stay well under YNAB's 200-req/hour limit.
 */
export async function getCategoryHistory(args: {
  token: string;
  categoryId: string;
  sinceMonth: string;            // "2024-08"
  untilMonth: string;            // "2026-07"
  budgetId?: string;             // default "last-used"
}): Promise<MonthPoint[]> {
  const { token, categoryId, sinceMonth, untilMonth } = args;
  const budgetId = args.budgetId ?? "last-used";
  const months = monthRange(sinceMonth, untilMonth);

  const results: MonthPoint[] = [];
  const CONCURRENCY = 6;

  for (let i = 0; i < months.length; i += CONCURRENCY) {
    const batch = months.slice(i, i + CONCURRENCY);
    const points = await Promise.all(
      batch.map(async (monthIso) => {
        const url =
          `${YNAB_BASE}/budgets/${budgetId}/months/${monthIso}/categories/${categoryId}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          // A month before the budget's first_month returns 404 — skip it.
          if (res.status === 404) return null;
          throw new Error(`YNAB ${res.status} for ${monthIso}: ${await res.text()}`);
        }
        const { data } = (await res.json()) as {
          data: { category: { budgeted: number; activity: number; balance: number } };
        };
        const c = data.category;
        return {
          month: monthIso.slice(0, 7),
          assigned: mu(c.budgeted),
          activity: mu(c.activity),
          available: mu(c.balance),
        } as MonthPoint;
      })
    );
    for (const p of points) if (p) results.push(p);
  }

  results.sort((a, b) => a.month.localeCompare(b.month));
  return results;
}

// [MCP tool registration sketch + creditCardFloatHistory reference omitted here for brevity
//  in the spec body — the full pasted reference lives in the conversation record; the
//  addendum below captures every binding behavior of both tools.]

// creditCardFloatHistory(args: { token, paymentCategoryId, cardAccountId, sinceMonth,
//   untilMonth, budgetId? }): per month -> { month, owed, available, gap, changed }
//   - available series: getCategoryHistory on the payment category
//   - owed at EOM: anchor on the account's CURRENT balance, back out transactions
//     dated after month-end (monthEnd = `${month}-31`, ISO string compare)
//     owedAt(m) = -(currentBalance - sum(txns where date > monthEnd(m)))  [positive dollars]
//   - gap = available - owed; changed = |gap - prevGap| > 0.005 (first month: changed=false)
//   - single transactions fetch (account sub-endpoint, since_date = sinceMonth-01), single
//     account fetch for the current balance
```

---

## Repo adaptation addendum (binding for implementation, 2026-07-30)

- **Client:** use the existing `YnabClient` (auth, rate limiter, error hints, redaction) — no raw `fetch`, no token parameter. Paths use `/plans/...`; `last-used` passes through. Endpoints used: `GET /plans/{p}/months/{m}/categories/{c}` (already contract-tested pattern), `GET /plans/{p}/accounts/{a}`, `GET /plans/{p}/accounts/{a}/transactions?since_date=...`.
- **Owed anchor:** the reference's comment says "cleared balance" but its code anchors on `.balance` (working). The CODE is correct — available responds to entry not clearing (per the month-close spec), so owed anchors on the account's working `balance`. Comment discarded.
- **Milliunits:** all accumulation in integer milli (house rule); `milliToDollars` at the output boundary only. `changed` threshold: `|gapMilli − prevGapMilli| > 5` (= the reference's 0.005 dollars). First point: `changed: false`.
- **Range cap:** month range limited to **60 months**; a longer range throws with a clear message (each month costs one API call against the shared 200/hr limit). Batched `Promise.all` of 6 (reference's CONCURRENCY) — batching bounds burst, the limiter counts each call.
- **404 skip:** a month before the plan's `first_month` → the client throws `YnabApiError` with `status === 404`; catch exactly that per month and skip; any other error propagates.
- **monthEnd trick kept:** `${month}-31` ISO string compare safely means "after this month" for all real dates.
- **Tool names:** `get_category_history` (params: `plan_id`, `category_id`, `since_month` "YYYY-MM", `until_month` inclusive) and `credit_card_float_history` (params: `plan_id`, `payment_category_id`, `card_account_id`, `since_month`, `until_month`). Both READ-ONLY. Tool count 30 → 32.
- **Composition:** `credit_card_float_history` reuses the category-history fetch internally (N month calls + 1 account + 1 transactions fetch). Description should note the cost (~N+2 API calls) and point at `month_close` for the single-cutoff version.
- **Month validation:** `since_month`/`until_month` must match `^\d{4}-\d{2}$` and `since_month <= until_month`, else a clear error before any fetch.
