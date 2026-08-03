# Hosted Writes — Design

**Status:** approved, not yet implemented
**Date:** 2026-08-03
**Affects:** `@walensis/cove-core`, `@walensis/cove-mcp` (public), `cove-cloud` (private hosted tier)

## Why

The hosted tier shipped read-only. That was the right call for a first launch, but it leaves the
product's flagship loop broken: `month_close` finds a coverage gap, `propose_coverage` computes
exactly which categories to move money from — and then the user retypes those numbers into YNAB
by hand. The same applies to routine work like approving an imported transaction.

The original argument for read-only leaned on "a write bug moves a stranger's money." That
framing does not survive contact with the actual operations. `moveMoney` and `assignBudget`
reallocate *budgeted intent inside YNAB*; no bank balance changes and the inverse is a
symmetric operation. `updateTransactions` marking a transaction approved is not a financial
event. The genuinely dangerous operations — creating and deleting records — are the ones the
product does not need.

So: enable writes, but scope them by blast radius rather than by the read/write bit.

## Decisions

### 1. The user chooses their access level at connect time

The consent page offers two options rather than one button:

- **Read-only** — view budgets, categories, transactions. Cannot change anything, ever.
- **Read and edit** (default) — additionally approve transactions and move budgeted money.
  Cannot create or delete records.

This preserves read-only as a real, selectable guarantee. It is the posture the established
hosted YNAB integrations lead with (Calendar for YNAB: *"It is technically impossible for this
app to make any changes to your budget"*), and users who want it should not have to self-host
to get it.

The selected scope is signed into the OAuth state, not passed as a bare form field, so it
cannot be altered between the consent page and the callback.

### 2. Write allowlist

Permitted on the hosted tier:

| Method | Why it is safe |
|---|---|
| `updateTransactions` | Approve, categorize, memo. Reversible; no money moves. |
| `moveMoney` | Reallocates budgeted dollars. Symmetric inverse; no bank balance changes. |
| `assignBudget` | Same. |
| `createCategory` / `updateCategory` | Structural, reversible. |
| `renamePayee` / `createPayee` | Labels. |

Denied on the hosted tier, self-host only:

`createTransactions`, `importTransactions`, `deleteTransaction`, `createAccount`,
`createScheduled`, `updateScheduled`, `deleteScheduled`.

Rationale: these create or destroy records rather than relabel them. Splits are immutable once
created, so some are not cleanly reversible even by hand — and this service does not retain a
copy of the user's budget to restore from.

The allowlist is a **hardcoded literal set**, not env-driven, matching the existing discipline
around `allowWrites`. No configuration mistake may widen it.

### 3. No undo journal — confirmation plus a self-describing inverse

YNAB's API has no undo: no revert endpoint, no history endpoint, no soft-delete flag. Delta
requests return current state, not prior values. The undo affordance in YNAB's own app is
client-side session state and is not exposed to API consumers.

The local server solves this with a file-backed `UndoJournal` storing inverse operations. The
hosted tier will **not** persist one, because:

- The inverses that matter are self-evident. Un-approve reverses approve; `moveMoney(B→A, $X)`
  reverses `moveMoney(A→B, $X)`.
- A journal would mean persisting a running record of every financial change per tenant. The
  privacy policy commits to storing as little as possible, and not storing it is both safer
  and more honest.

Instead:

- **Every permitted write returns its own inverse** in the tool response, in plain language:
  *"Moved $340.00 from Dining Out to Credit Card Payment. To reverse: move $340.00 back."*
  The conversation becomes the journal, and "undo that" works naturally within a session.
- **`updateTransactions` reads prior values before writing** so the response can name them.
  Costs one extra API call against YNAB's 200/hr limit.
- **Reallocation requires explicit confirmation.** `moveMoney` and `assignBudget` currently
  have *no* confirmation gate — only bulk updates (>5 rows), `deleteTransaction`, and
  `deleteScheduled` do. They gain one: `confirm: true`, with the tool description instructing
  the model to state source, destination, and amount before asking.

Accepted tradeoff: no cross-session undo. Undo is a same-session affordance, and YNAB's own UI
always shows the change for manual correction. If real usage disproves this, a D1-backed
journal is additive — `D1Ledger` is the established pattern.

**`undo_last` is removed from the hosted tool list.** It currently has no journal attached and
silently does nothing there. Shipping a safety net that is not tied to anything is the same
failure mode as the write-refusal message below.

### 4. Tool lists are built per grant

`buildServer` gains an option controlling which write tools are registered. The hosted handler
derives it from the stored scope:

- read-only grant → zero write tools registered
- read-and-edit grant → the seven allowlisted tools

A tool that is not registered cannot be called; the client sees an unknown-tool error rather
than a refusal it might try to route around. This is the root-cause fix for the incident that
prompted this work (see below).

Note: MCP clients cache tool lists, so a user who changes scope must reconnect the connector.

### 5. The write-refusal message must not prescribe deployment specifics

`WriteDisabledError` in core currently reads:

> "Writes are disabled. This server runs read-only by default to protect your budget. To enable
> writes, set the environment variable `YNAB_ALLOW_WRITES=1` in your MCP server config and restart."

This was deliberate — the core spec says *"the refusal text teaches the flag"* — and it is
correct for the local stdio server. It is wrong for the two other deployment shapes:
`WORKER_ALLOW_WRITES` gates the self-hosted worker, and the hosted tier has no flag at all
because `allowWrites: false` is hardcoded.

In production this message told a hosted user to reconfigure a server they do not operate. An
AI client relayed it faithfully and confidently, and the user nearly acted on it.

Fix: the remediation text becomes injectable.

```ts
new Ynab({ allowWrites: false, writeDisabledHint: '…' })
```

Default is generic and names no variable. The stdio server keeps its current text. The hosted
tier says the service is read-only by the user's own choice and points at reconnecting with
edit access.

## Data model

```sql
ALTER TABLE ynab_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'read-only';
```

Scope belongs on `ynab_tokens` rather than `users`: it is a property of the grant, and
re-authorizing replaces that row.

## Security invariants

Everything already true must remain true. Additionally:

1. **The stored scope is a UX and tool-list concern; YNAB's token scope is the real
   enforcement.** If the two ever disagree, the request fails at YNAB. This is defense in
   depth and it fails closed in both directions.
2. **The selected scope travels inside the signed state.** It is never read from an unsigned
   form field, query parameter, or cookie at the callback.
3. **The allowlist is a literal in source.** No env var, no config, no options object may
   widen it.
4. **Writes remain scoped to `ctx.props.userId`.** A grant may only ever touch its own budget.
5. **A read-only grant registers no write tools at all** — not disabled tools, absent ones.

## Privacy policy changes

The live policy states Cove "cannot create, edit, approve, delete, or move anything in your
YNAB budget." That becomes false for read-and-edit grants and must be rewritten before the
capability ships. The new text must describe both levels distinctly, keep the strong guarantee
for read-only users, and state plainly what an edit grant can and cannot do.

## Migration

One tenant exists (the author). Existing grants are read-only and stay valid — the tool list
simply contains no write tools. Picking edit access means reconnecting the connector.

## YNAB submission

The app currently under review requests `read-only`. It will be amended and resubmitted with
the intended scope before review completes, rather than being approved for one thing and
immediately asking for another. The user-facing choice is worth describing in the submission:
it is a stronger privacy posture than requesting full scope for everyone.

## Out of scope

- Cross-session undo
- Any write on the free tier being metered or gated behind Cove Watch. Writes are table stakes;
  local competitors provide them free. Cove Watch differentiates on vigilance — scheduled
  checks, alerts, retained history — not on permission level.
- Self-serve data deletion (`/disconnect`). Tracked separately; it is a prerequisite for the
  directory listing, not for writes.

## Open questions

1. Does YNAB's token response return the granted scope? If so, store *that* rather than what
   was requested. Verify during implementation; if absent, store the request and rely on
   invariant 1.
2. Does YNAB's review treat a user-selectable scope differently from a fixed one? Worth
   describing explicitly in the submission notes.
