# Product Design Brief: YNAB Balancing & Planning Suite

Status: Approved product direction (AJ-authored, 2026-07-30). Phase 0 adaptation addendum at bottom.
NOTE (ground-truth correction): the brief's "handoff target: Cloudflare Worker repo" is inaccurate —
the current server is a STDIO MCP server (npx + .mcpb). The hosted Worker is Phase 2. Phase 0 lands here.

---

## 1. Thesis

YNAB assumes daily engagement. A large class of users — pay-in-full, everything-on-card-for-points, month-ahead budgeters — actually work in **monthly catch-up sessions**, usually the first week after rollover. YNAB punishes this workflow: warnings expire at rollover, credit overspending converts to invisible debt, prior month-end balances become unviewable, and every native "all good" signal (green categories, clean reconciliation, self-resolving red) can be true while the budget silently stops covering the cards.

The product legitimizes the catch-up workflow instead of fighting it. Mental model: **balancing a checkbook** — always retrospective, always respectable — followed by its natural next step, **planning the new month**. Product shape: a guided monthly **Balance → Plan session**, with always-on monitoring between sessions.

One-line pitch: *YNAB tells you when your budget is balanced. This tells you when it's actually covered.*

## 2. Target user

- Pays credit cards in full monthly (sometimes twice a month)
- Routes most spending through cards for points/bonuses
- Budgets this month's income for next month (month-ahead buffer)
- Falls behind on categorizing/approving/covering, catches up in week 1 after rollover
- Has been surprised by credit-card float before and couldn't reconstruct why

## 3. Problem taxonomy (validated)

**Float creators** (gap = payment-category available − card owed):
1. **Category overage (yellow)** — uncovered credit spending; visible only in the live month, then converts to silent card debt at rollover.
2. **Uncategorized owed-side debt** — payment reversals/bounces, card→checking transfers (cash advances), card-pays-card. No category → no yellow, no Uncategorized entry, no alert, ever. *Proven in the wild: a reversed+re-made payment (see fixtures) created $3,322.55 of float with zero visible signals.*
3. **Manual payment-category drain** — pulling money out of a healthy payment category because it looks like idle cash. No warning.
4. **Legacy/standing float** — inherited gap of unknown origin (fixture: −$865.75 carried 7+ months).

**False-security signals** (all can be true while float persists):
- Red overpayment self-resolving at rollover (RTA absorbs it; feels like resolution; gap barely moves)
- Green categories (an entire month can look immaculate — fixture April 2026)
- Clean reconciliation (validates register vs bank; orthogonal to coverage — user reconciled cleanly through 23 straight months of float)
- RTA at $0

**The meta-problem:** after rollover, YNAB shows no historical account balance, so the gap can't even be computed for a past month in-app. This is why creators compound: damage is invisible exactly when this user does their budgeting.

**Related non-float risk:** overpayment red absorbed from RTA silently drains the month-ahead buffer (a real cost, and a false "covered" feeling — the red's size is unrelated to the float's size).

## 4. Competitive landscape & positioning

- **YNAB support docs** document the float and the manual two-number check (current month only).
- **Toolkit for YNAB** ("Paid in Full Credit Card Assist"): highlights payment category + account icon when available ≠ balance; "Rectify Difference" button blind-assigns the gap. Web-only, instant-only, no history, no cause, no notifications, no blocker awareness — and during catch-up week it cries wolf (see §6 step 2).
- **OSS auto-categorizers** (ynab-autocategorizer, YNAB_GPT, n8n template): payee-map-first + LLM fallback, flag-everything patterns. Mature; do not rebuild from scratch — port patterns.
- **Other YNAB MCP servers** (dgalarza, calebl, etc.): commodity CRUD tools. Confirms primitives are not defensible IP.

**Positioning:** detection-in-the-moment is contested; ship it anyway as substrate (ours is blocker-aware — different semantics, same pixel). Uncontested and lead-worthy: **trust during catch-up, attribution (why it moved), history (balance-forward line), reach (email/push), judgment in the fix (donor moves, not RTA dumps)**. The suite's real competitor is the spreadsheet-and-discipline system users build and abandon.

## 5. Suite architecture (two beats)

**BALANCE** (anchored to a user-supplied cutoff; works in-month or post-rollover):
hygiene → trusted gap → attribution → covering moves → balance-forward line written.

**PLAN** (same sitting): true starting number (Next-Month derivation, buffer honesty) → fund the month → done line.

## 6. The session spine (v0 flow)

| # | Step | Existing tool | To build |
|---|------|--------------|----------|
| 1 | Surface blockers before cutoff (unapproved / uncategorized / unreconciled) | `month_close` blocker scan; `update_transactions` bulk categorize+approve | later: auto-categorization pre-fill (Phase 4) |
| 2 | Per-card gap at cutoff — **only presented as trustworthy after step 1** (uncategorized credit spend inflates apparent gap and self-heals as categorized; instantaneous checks are provisional during catch-up) | `month_close` | provisional-vs-final gap state |
| 3 | Attribute every gap change since last close | `credit_card_float_history` (change-points) | **attribution engine (§8)** |
| 4 | Cover: donor-move proposals (RTA last), approve, apply; memo-stamp every applied move | `propose_coverage`, `move_money`, `assign_budget` | memo convention (§9) |
| 5 | Write the balance-forward line (persist EOM balances, gap, causes, moves) | — | **persistence layer (§10)** |
| 6 | Derive true usable RTA (automate the manual "Next Month" category math: income assigned forward last month, subtracted this month), show buffer incl. rollover absorptions | — | **next-month derivation** |
| 7 | Fund the month; per-card safe-to-pay number (= payment category available) | `assign_budget`, `move_money` | guidance layer |
| 8 | Done line: "July balanced. August funded. All cards covered. Buffer: $X." | — | summary formatter |

## 7. Phasing

- **Phase 0 (now):** a `/month-close` **skill** that orchestrates existing MCP tools through the spine above. Zero new product surface; dogfood the session for 1–2 closes; rough edges become the spec.
- **Phase 1:** attribution engine + persistence in the worker; **email digest** (weekly one-liner when healthy; immediate event alert on reversal-class debt; monthly close report). First-run **ledger backfill** (24 months) — the discovery moment ("you've been carrying $X since <date>") is the acquisition hook.
- **Phase 2:** hosted multi-tenant (YNAB OAuth, managed persistence, cron monitoring). This is the paid gate.
- **Phase 3:** browser extension — the in-app surface of the same backend. Three jobs: (a) moment-of-action guards — safe-to-pay on payment entry, drain warning on payment-category withdrawal; these intercept the two *user-caused* float creators, which no cron/email surface can reach in time; (b) blocker-aware coverage badge on payment-category rows, with click-through to the inline ledger (balance-forward + attributed causes); (c) later, the guided session as a sidebar walkthrough deep-linking each step to real rows — how the session escapes the Claude skill for the mass audience. Architecture: **thin client over an open API contract, with a configurable backend** — three modes: (1) no backend: local DOM compute, ≈ Toolkit parity, free; (2) self-hosted OSS server (custom endpoint URL): full deterministic features (ledger, attribution, blocker-aware state), DIY ops — PATs, own cron, own email; (3) hosted account (paid): same features plus OAuth, managed persistence, monitoring, deliverable email, and the metered LLM services — which gate on the hosted account in every mode (a self-hosted server may call them via API key). Monetization principle: **charge for ops relief and metered intelligence, not feature ransom** (Bitwarden/Home Assistant pattern; self-hosters are the evangelist pipeline). Doubles as the acquisition funnel via the first-connect discovery moment ("you've been carrying $X since <date>"). Constraints: DOM injection against YNAB's SPA is a permanent maintenance tax (see Toolkit's breakage history — a reason this waits for Phase 3, after backend value stands alone), and it must coexist cleanly with Toolkit installed.
- **Phase 4:** auto-categorization module (payee-map first, LLM for novel payees only, flag everything, **never auto-approve** — approval is the human checkpoint and becomes cheap once pre-categorized). Plan module features (Next-Month automation as premium wedge).

## 8. Attribution engine spec (the core IP; every rule below validated by hand)

Definitions (all per card, dollars; owed positive):
```
gap(t)        = pmt_available(t) − owed(t)          // 0 = covered
Δgap(month)   = assigned_pmt(month) − uncovered_owed_activity(month)
```
Invariants:
- **Payments and refunds are gap-invariant** (both sides move equally). An overpayment is too — its float effect arrives only via next-month RTA absorption of the red.
- Gap is cumulative; it does not reset at rollover. A static gap is carried history; only changes need attribution.

Classifier, in priority order, for each month where |Δgap| > $0.01:
1. **Assignment / drain:** read `assigned` on the payment category for that month. Positive → "deliberate cover" (Δgap contribution +assigned). Negative → "payment-category drain."
2. **Reversal-pair scan:** in the card account's transactions for the month (±30d window), find offsetting sets (±X, possibly a trio +X/−X/+X) where X ≈ |unexplained Δgap|. Label "payment reversal — $X re-added as uncovered debt." Also scan for categoryless owed-increasing transfers (card→checking, card-pays-card): same class, "uncategorized debt."
3. **Overpayment absorption:** if prior month's pmt_available < 0 and Δgap ≈ +|prior red| → "overpaid last month; RTA absorbed $X at rollover (buffer cost $X)."
4. **Residual → uncovered spending:** remaining negative Δgap = credit overspending. Category-level detail requires a txn-level pass (card txns grouped by category vs that category's available); ship the total first, per-category detail second.
5. **Unattributed:** label honestly (fixture: a $7.32 change in May 2025 remains unattributed; never force-fit).

Output per change-point: `{month, Δgap, cause, evidence: [txn ids | assigned delta | prior red], narrative}`. Narrative generation (plain-English "your Apr 10 payment bounced Apr 15…") is an LLM-layer feature — hosted, not in the deterministic lib.

## 9. Product principles (non-negotiable)

1. **No surfaced problem without its attached fix.** Every alert/report row ends in a one-tap "assign/move $X to Y." (Float remediation needs consent, never judgment — that's why this automates safely where categorization doesn't.)
2. **Blocker-aware numbers.** Never present a gap as final while uncategorized/unapproved txns predate the cutoff; show "provisional" and the blocker count.
3. **Donor moves before RTA.** Coverage proposals pull from overfunded categories first; RTA is last resort (matches `propose_coverage` behavior).
4. **Never auto-approve.** Bots categorize and flag; humans approve.
5. **Self-documenting audit trail.** Every automated/applied action memo-stamps its reason (`[suite] cover Jul float: payment reversal $3,322.55`). Forensics runs both directions: explain the data's past AND the tool's own actions.
6. **Cutoff-anchored, not calendar-forced.** The session runs whenever the user shows up.
7. **Quiet when healthy.** Weekly digest is one line when covered; alert thresholds default high (>$250 or red) — nag noise kills the product.

## 10. Backend architecture & open/closed split

Current state [CORRECTED]: single-tenant STDIO MCP server (PAT auth; npx + .mcpb; hosted Worker is Phase 2), 32 tools incl. `get_plan_overview`, `get_month`, `list_transactions`, `list_categories`, `budget_health`, `month_close`, `propose_coverage`, `get_category_history`, `credit_card_float_history`, `move_money`, `assign_budget`, `update_transactions`, `undo_last`.

**Client compatibility (requirement): the server is client-agnostic MCP — Claude Desktop/Code, ChatGPT connectors, IDE clients (Cursor/Cline/Zed), and local LLM tooling (stdio-only clients via `mcp-remote` bridge; document it).** Rules: (1) Streamable HTTP transport; auth = URL-secret/bearer for self-host, MCP OAuth 2.1 on hosted (this maps to the free/paid split). (2) The session ships in three portable wrappers: Claude skill, **MCP prompt** (the standard-protocol equivalent — required so non-Claude clients get the guided flow), and a plain-markdown playbook. (3) Workflow sequencing lives in tool descriptions ("start here", "pair with X") — assume zero client-side orchestration. (4) Design for the smallest model in the room: compact responses, `fields`/`hidden` filters, server-side aggregation (a 10k-token `get_month` payload sinks a local 7B); keep JSON schemas simple — OpenAI function-calling is stricter than Anthropic's. (5) The deterministic core never depends on MCP sampling (client-LLM completion); LLM features run server-side only. Test matrix: Claude Desktop/Code, ChatGPT connector, one IDE client, one local client via bridge.

**Principle: open-source what builds trust and adoption; gate what runs while you sleep.**

| Layer | Disposition | Rationale |
|---|---|---|
| MCP server core (all read/compute/write primitives, month_close, float_history, propose_coverage) | **OSS, MIT** | Trust for financial data; community is OSS-native; primitives are commodity (3+ competing MCP servers exist) — closing protects nothing |
| Deterministic attribution lib (§8) | **OSS** (deliberate choice) | Derivable arithmetic anyway; makes the OSS server excellent = the trust/adoption engine; moat is architectural, not code |
| `/month-close` skill + session playbook docs | **OSS** | Marketing + onboarding |
| Persistence **schema** (ledger tables) | OSS (self-hosters bring their own D1/KV) | Interop, credibility |
| Hosted platform: YNAB OAuth multi-tenant, managed ledger, cron monitoring, email/push delivery | **Closed / paid** | Infrastructure by nature; the always-on layer is the product's service value |
| LLM services: narrative forensics, auto-categorization inference | **Closed, hosted, metered** | Per-call cost; quality corpus is maintained IP |
| Browser extension | Closed or source-available; premium features require hosted account | UI polish + ties to hosted history |
| Plan module (Next-Month automation, buffer analytics) | Hosted premium wedge | Niche differentiator |

Licensing: MIT for the open repo. Do **not** reach for AGPL/BUSL to prevent rehosting — the gate is that hosted-service code never ships in the repo at all. Compliance checklist for Phase 2: YNAB OAuth app registration + API ToS / works-with-YNAB review; email deliverability infra; token storage & encryption; rate limits (200 req/hr/token — a 24-month single-card backfill ≈ 26 calls; budget multi-card backfills and use delta requests / `last_knowledge_of_server`).

## 11. Known bugs & tech debt (fix in Phase 0)

1. **`get_category_history` hangs** (~4 min timeout) while sibling tools respond — suspect unbounded month loop, missing return, or concurrency fetch bug. `credit_card_float_history` (which fetches the same per-month category endpoint internally) works, so compare implementations.
2. **`list_transactions` drops requested fields:** `payee_name`, `category_name`, `transfer_account_id` requested via `fields` but absent from response rows (possibly null-stripping). Attribution's reversal scan needs transfer linkage — fix or document.
3. `credit_card_float_history` `changed:true` doesn't distinguish float growing vs shrinking — add sign/direction, and (Phase 1) inline cause via §8.
4. Consider `hidden=false` / `fields` filtering on `get_month` — full-budget payloads (~140 categories) are ~10k tokens each.

## 12. Validated test fixtures (real data; use as regression tests)

Chase card account `1213c7f4-7499-4d72-8727-a968902d8755`; payment category `b20cf9b7-0c98-4eaf-9256-59abc598cb11`; plan `last-used`.

Gap series (available − owed at calendar EOM):
- 2024-08 → 2025-02: **−865.75 flat** (legacy float; static-gap detection)
- 2025-03: −862.09 (Δ +3.66 = absorption of Feb red −3.66 → rule §8.3)
- 2025-05: −854.77 (Δ +7.32, **unattributed** → rule §8.5 honesty case)
- 2025-12: −665.28 (Δ +189.49 = absorption of Nov red −189.49 → §8.3)
- 2026-04: **−3,987.83** (Δ −3,322.55 = reversal trio: +3,322.55 on 04-10, −3,322.55 on 04-15, +3,322.55 on 04-17; assigned=0 that month; all real April charges — $1,095.35 — fully covered; no negative category availables → §8.2)
- 2026-06: −2,471.28 (Δ +1,516.55; assignment-driven — inferred, verify)
- 2026-07: **0.00** (Δ +2,471.28; July assigned = 2,501.05 → §8.1 deliberate cover)

Reconciliation identity check (April 2026): pmt activity −5,549.75 + payments 6,645.10 = covered 1,095.35 = total real charges. Attribution engine must reproduce this month exactly.

## 13. Phase 0 deliverables & success criteria

1. Fix §11 bugs 1–2.
2. Write the `/month-close` skill implementing §6 (steps 1–5 minimum, 6–8 as prompts), honoring every §9 principle.
3. Add direction/sign to float-history change-points; add memo-stamping to `move_money`/`assign_budget` (optional `reason` param → memo).
4. Success: the August 2026 close runs end-to-end as a guided session in ≤20 minutes, produces a persisted balance-forward record, and every applied move carries a reason memo. Attribution correctly labels all fixture months in §12.

---

## Phase 0 adaptation addendum (agreed 2026-07-30)

1. **No Worker exists** — Phase 0 lands in the stdio server (see header note). Streamable HTTP/OAuth is Phase 2.
2. **Memo-stamping API constraint:** YNAB has NO memo/note surface on assignments (month-category PATCH carries only `budgeted`; money-movement notes are read-only). §13.3 adaptation: optional `reason` param on `move_money`/`assign_budget` → recorded in the undo-journal entry description, echoed in the tool response, and captured in the balance-forward record. Transaction writes keep true memo-stamping.
3. **Phase 0 persistence = local ledger tools (AJ decision):** `record_month_close` (appends the balance-forward record to `~/.mcp-for-ynab/ledger.json`) + `get_month_close_ledger` (reads it). Local-file only — NOT YNAB writes, so not behind `YNAB_ALLOW_WRITES`. Record schema doubles as the Phase 1 D1 schema draft. Tool count 32 → 34.
4. **Bug §11.2 root cause (found by inspection):** snake/camel mismatch — `fields` are matched against camelCase `Txn` keys while every tool param is snake_case; undefined values then vanish in JSON.stringify. Fix: accept snake_case (normalize) and document.
5. **Bug §11.1 does not reproduce by inspection** (shared helper with the working float tool). Phase 0 adds a client-level request timeout (converts any hang into a clear error) + a diagnostic script; root-cause fix follows evidence.
6. **§13.4 attribution success criterion is Phase 1** (the engine is §7-Phase 1). Phase 0 ships a live fixture-validation script asserting the §12 GAP SERIES numbers via `credit_card_float_history`; attribution labeling lands with the engine, with §12 as its regression suite.
7. **MCP prompt wrapper included in Phase 0** (per §10 rule 2): `month-close-session` prompt registered on the server so non-Claude clients get the guided flow; plus the markdown playbook.
