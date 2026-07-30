---
name: month-close
description: Guided YNAB month-close session (Balance → Plan) over the MCP for YNAB tools — blocker-aware gaps, float attribution, donor-first coverage, balance-forward ledger. Use when the user wants to close out a month, do their monthly YNAB catch-up, check credit-card coverage, or asks for /month-close.
---

Run the month-close session exactly as specified in the playbook below. Before starting:
confirm the cutoff date (default: last day of the month being closed) and that the "MCP for
YNAB" server is connected (34 tools). Writes require YNAB_ALLOW_WRITES=1 — if writes are
disabled, run the Balance steps read-only, present the moves you WOULD make, and tell the
user how to enable writes for the apply step.

# The Month-Close Session (Balance → Plan)

You are guiding a monthly catch-up session against YNAB via the "MCP for YNAB" tools.
Anchor everything to the user's cutoff date (ask if not given — normally the last day of
the month being closed). Principles, non-negotiable: numbers are PROVISIONAL until blockers
are empty; donor moves before Ready-to-Assign; never auto-approve; every applied move gets
a `reason`; pair every surfaced problem with its one-tap fix; keep healthy findings to one line.

## BALANCE

**1. Hygiene.** Run `month_close` with the cutoff. If `gapStatus` is "provisional", present the
blocker counts and work through them: show `blockers.uncategorized` and `blockers.unapproved`
rows, propose categories (from payee history via `list_transactions` if helpful), and apply
ONLY what the user approves via `update_transactions` (categorize + approve together; never
approve without the user seeing the categorization). Uncleared-before-cutoff rows are for the
reconciliation step — note them, don't force them.

**2. Trusted gap.** Re-run `month_close` until `gapStatus` is "final". Present per-card:
working/cleared as-of balances, available at month end, and the gap (0 = covered; negative =
short). Heed any `warnings` (unmatched or ambiguous cards are NOT covered by the report).

**3. Attribution.** For each card with a non-zero gap, run `credit_card_float_history` from the
last recorded close (check `get_month_close_ledger`) or 24 months on first run. Walk the
`changed:true` points using `direction` ("grew" = float increased). For each change the user
cares about, look for: that month's payment-category assignment (deliberate cover or drain),
reversal pairs in the card's transactions (`list_transactions` on the account around that month,
fields: date, amount, payee_name, transfer_account_id), or a prior-month overpayment absorbed at
rollover. Label honestly — "unattributed" is an acceptable answer; never force-fit a cause.

**4. Cover.** Run `propose_coverage` for the cutoff month. Present the moves (donors first; RTA
draws are tagged and drawn last). Apply ONLY user-approved moves via `move_money` — and for RTA
draws via `assign_budget`, remember it sets the ABSOLUTE assigned amount (read current assigned
from `get_month`, pass current + amount). Give every applied move a `reason` like
`[month-close 2026-07] cover float: payment reversal $3,322.55`.

**5. Balance-forward line.** Write the record with `record_month_close`: per-card gaps, blocker
counts (should be zeros now), the causes you attributed, and the moves you applied with reasons.
This is next month's baseline.

## PLAN

**6. True starting number.** If the user runs a month-ahead buffer (a "Next Month" holding
category), derive the real usable Ready-to-Assign: `get_month` for the new month's RTA, plus the
buffer category's balance via `get_category_history`, minus any rollover absorptions found in
step 3. State it plainly: "Your true new-month starting number is $X."

**7. Fund the month.** Walk underfunded targets (`month_close` reds / `get_month`
goal_under_funded) and assign with the user's approval (`assign_budget`, with reasons). Per-card
safe-to-pay = that card's payment category available — state it for each card.

**8. Done line.** One sentence: "<Month> balanced. <Next month> funded. All cards covered.
Buffer: $X." (Adjust honestly if cards aren't covered — say which and by how much, and what
remains to fix.)
