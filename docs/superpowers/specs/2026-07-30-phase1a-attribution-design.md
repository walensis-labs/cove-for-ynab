# Phase 1a: Attribution Engine + Backfill — design spec

Status: Approved (brainstormed with AJ 2026-07-30; parent: docs/superpowers/specs/2026-07-30-balancing-suite-brief.md §7 Phase 1, §8, §12)
Phase split (AJ decision): 1a = deterministic lib + tools in the stdio server (this spec); 1b = single-tenant Cloudflare Worker (cron polling + email digest) — separate spec later.

## Decisions (settled)

1. **Attribution is INLINE in `credit_card_float_history`** — every `changed:true` point gains `cause` + `evidence`, computed by a pure OSS lib from data the tool already fetches. No new tool for attribution; zero extra API calls. Narratives remain the client model's job (§8: the deterministic lib emits structured causes only).
2. **`backfill_ledger` tool** (34 → 35): runs the attributed history for a card pair, writes one balance-forward record per month (`kind: 'backfill'`; real closes are `kind: 'close'`), re-runs REPLACE prior backfill records for the same plan+account (no duplicates), and returns the discovery summary — current gap, "nonzero since <month>" (with "since at least <window start>" honesty when the float predates the window), and the attributed change-points.
3. **Uncleared semantics (closes the issue-#3 parked decision):** YNAB `uncleared` is register state, NOT "pending at the bank". `gapStatus` gating stays strict, and the session copy changes from "bank-pending, can't be forced" to an INVESTIGATION flow: each uncleared-before-cutoff row either settled (mark cleared via `update_transactions`) or is stale (delete with user approval) — a stale entry corrupts `workingAsOf`, so cleaning the register is how "final" is honestly reached.
4. **Fixture correction:** brief §12 labels 2025-05 (Δ +7.32) "unattributed"; live data shows the payment category was assigned exactly $7.32 that month → the classifier labels it `deliberate_cover` (§8.1). The §8.5 honesty case moves to a synthetic fixture. 2026-07 is a compound month: assigned 2,501.05 vs Δ +2,471.28 → deliberate_cover + uncovered_spending residual of −29.77.

## Classifier (per §8, priority order)

For each float point with `|gapChangeMilli| > 10` (i.e. > $0.01), build an ordered component list explaining the change; `remaining` starts at `gapChangeMilli`:

1. **Assignment / drain** — that month's payment-category `assignedMilli`: positive → `deliberate_cover` (+assigned), negative → `payment_category_drain`. Subtract from remaining.
2. **Reversal-pair scan** — in the card's transactions within `[month-01 − 30d, REAL month end + 30d]` (exact month end via `Date.UTC(y, m, 0)` — the 28+33d approximation bled February into April): group by |amount| X (no distance pre-filter — the leftover gate below is the guard); `k = round(−remaining/X)` must be ±1; a reversal event requires BOTH signs (k=1: ≥2 positives and ≥1 negative; k=−1 mirror) — match via a deterministic SUBSET (2 earliest same-sign txns + the opposite-sign txn dated between them, else earliest), so a coincidental same-|amount| bystander neither suppresses the match nor pollutes evidence; whole-group net is NOT used. Lone payments and pure ±X pairs can never match. Also categoryless owed-increasing transfers (amount < 0, category_id null, transfer_account_id non-null) summing to ≈ remaining → `uncategorized_debt`. A LEFTOVER GATE bounds false positives: a k=±1 match is accepted only when the post-reversal leftover is ≈0 (within EPS) or ≈ the prior-month red that the absorption stage will claim — otherwise the group is rejected and the change falls through honestly. (Semantics corrected 2026-07-30 across three review rounds: window bleed, bystander suppression, and the false-positive band closed by the leftover gate.)
3. **Overpayment absorption** — prior month's payment-category `availableMilli < 0` and remaining ≈ +|prior red| → `overpayment_absorption`, evidence = prior red.
4. **Residual** — remaining < −10 → `uncovered_spending` (total only; per-category detail is a later phase). Remaining > +10 with nothing matched → `unattributed` (never force-fit).

Tolerances: match epsilon 1000 milli ($1); component floor 10 milli. All arithmetic integer milli; dollars at the output boundary (house rule).

## Regression fixtures (from live-verified §12 + diagnose-run data)

| Month | Δgap | assigned | prior avail | Expected label |
|---|---|---|---|---|
| 2024-08→2025-02 | 0 (flat) | 0 | — | no change-point |
| 2025-03 | +3.66 | 0 | −3.66 | overpayment_absorption |
| 2025-05 | +7.32 | 7.32 | +766.27 | deliberate_cover (brief corrected) |
| 2025-12 | +189.49 | 0 | −189.49 | overpayment_absorption |
| 2026-04 | −3,322.55 | 0 | ≥0 | payment_reversal (trio 04-10/04-15/04-17, ±3,322.55) |
| 2026-06 | +1,516.55 | 1,516.55 | — | deliberate_cover |
| 2026-07 | +2,471.28 | 2,501.05 | — | deliberate_cover + uncovered_spending −29.77 (compound) |
| synthetic | +7.32 | 0 | ≥0, no txn match | unattributed |

## Out of scope (1a)

Per-category residual detail (§8.4 second pass); worker/cron/email (1b); LLM narratives (hosted, later); multi-card orchestration in one backfill call (skill loops per card).

## Backfill record notes

Historical `clearedAsOf` cannot be reconstructed from the API → backfill records carry `clearedAsOf` equal to `workingAsOf` with `note: 'backfill: cleared state not reconstructable historically'` (schema unchanged; honesty over precision). Record `cutoff` = the real last day of each month.
