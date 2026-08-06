# Truthful Tool Output — Design

**Status:** approved, not yet implemented
**Date:** 2026-08-06
**Affects:** `@walensis/cove-core`, `@walensis/cove-mcp` (public)

## Why

Two defects with one root cause: **the tools tell the model things that are ambiguous or untrue for
the deployment it's running in.** Both were found in production, both after the hosted tier gained
write access, and both are more dangerous now than they would have been a week ago.

### 1. Amounts have no stated unit

A real exchange: asked for the most recent transaction needing approval, the assistant reported
**−$10.00**, then corrected to **−$1.00**, then to **−$1,000.00**. Only the last was right.

The tool output was never wrong. `mapTxn` calls `milliToDollars` — raw `-1000000` becomes
`-1000`, meaning −$1,000.00. The model had no way to know that:

- `list_transactions`' description says nothing about units, and neither does the `Txn` shape.
  Only 10 of 35 tools mention dollars at all, and the ones that do are mostly *write* tools,
  where `dollars()` adds "(decimal dollars; negative = outflow)" to the schema.
- `Txn.importId` passes YNAB's raw milliunits straight through — `YNAB:-1000000:2026-08-06:1`.
  So the model sees a bare `-1000` beside a `-1000000` with nothing saying which is which, and
  reasonably concludes it should convert.

We set that trap. The model fell in it three times in one conversation.

**Why it matters now:** `move_money` takes dollars. A model confused about read units is
plausibly confused about write units, and `move_money(amount: 1000)` meaning "$1" moves
**$1,000**. Confirmation gates don't help — the model states the amount using the same
misreading it is asking you to confirm. That is a 1000× error on real money on a tier that can
now move it.

### 2. Tools claim to be undoable where nothing can undo them

Five permitted tools carry "Undoable." in their descriptions, and `moveMoney`'s half-applied
error tells the caller to "run `undo_last` to restore both categories". On the hosted tier there
is no journal (`buildYnab` passes none) and `undo_last` is deliberately not registered.

Same failure class as the `YNAB_ALLOW_WRITES` incident: a static string in a library asserting
something only true for one of three deployment shapes. A model that believes a mistake is
reversible will take bolder actions than one that knows it isn't.

## Decisions

### Amounts carry a formatted string beside the number

Every monetary value in tool output gains a rendered companion:

```json
{ "amount": -1000, "amountText": "-$1,000.00" }
```

The model quotes `amountText` instead of computing. This removes the ambiguity rather than
documenting around it — the failure above was a *reasoning* error on an unlabeled number, and no
amount of description text reliably prevents that.

`amount` **stays decimal dollars.** Changing it to milliunits would break every existing caller
and every stored ledger record for no gain.

Applies to transactions, subtransactions, category balances, account balances, aggregate sums,
and any other emitted money field. Uses the existing `formatDollars`.

### Every money-touching tool states its unit

Read tools included — they are currently silent, which is where the failure originated. The
`dollars()` schema helper already does this for write inputs; the equivalent belongs in each
description covering output.

### `importId` leaves the default field set

It is YNAB import plumbing that answers no user question, and its embedded raw milliunit value is
what triggered the recompute spiral. Still reachable via explicit `fields` selection for anyone
who needs it.

### "Undoable." becomes conditional on an undo journal actually existing

`buildServer` knows the `Ynab` instance, and `Ynab` knows whether it has a journal. Descriptions
are adjusted at registration time: a deployment with no journal must not advertise undo. Likewise
`moveMoney`'s half-applied error names `undo_last` only when that path exists; otherwise it states
plainly that the move is half-applied and gives the manual correction.

This is the same shape as the `writeDisabledHint` fix — the library stops asserting deployment
facts it cannot know.

## Out of scope

- Changing `amount` to milliunits, or any other change to the numeric field's meaning.
- Per-currency or locale formatting. YNAB budgets carry a currency setting; `formatDollars` is
  USD-shaped. Worth revisiting if a non-USD user appears, but inventing a formatting layer now
  would be speculative.
- Anything in the hosted worker. This is entirely a library change; `cove-cloud` picks it up on
  the next dependency bump.

## Verification

1. A transaction whose raw YNAB amount is `-1000000` renders `amountText: "-$1,000.00"`, and no
   emitted field could be mistaken for a different unit.
2. `importId` absent from default output, present when explicitly requested.
3. With no journal: no tool description contains "Undoable", and `moveMoney`'s half-applied error
   does not mention `undo_last`.
4. With a journal: both behave exactly as they do today (regression).
5. Every money-touching tool description states its unit.

## Tasks

**1. Core — formatted amounts.** `mapTxn` and every other emitter gain `*Text` companions via
`formatDollars`. Additive; no existing field changes meaning. Tests assert the −$1,000 case that
started this, plus a sub-dollar case (`-1` → `-$1.00` vs `-0.01`) so the boundary the model got
wrong is pinned.

**2. Core — journal-conditional messaging.** `moveMoney`'s half-applied error branches on
`this.journal`. Test both branches.

**3. MCP — descriptions.** Units stated on every money-touching tool; `importId` out of the
default field set; "Undoable." stripped at registration when the `Ynab` has no journal. Test that
a journal-less `buildServer` produces no description containing "Undoable", and that a
journal-bearing one is unchanged.

**4. Release.** Both packages, minor under 0.x (additive output fields and description changes,
but behavior visibly changes for consumers). Then bump `cove-cloud` and redeploy.
