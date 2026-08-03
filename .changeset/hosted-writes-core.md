---
"@walensis/cove-core": minor
---

**Breaking.** Two changes to write behavior. Under 0.x, this ships as a minor bump so `^0.3.0`
consumers do not pick it up automatically — upgrade deliberately.

**`WriteDisabledError` no longer names an environment variable.** Its message was hardcoded to
`"…set the environment variable YNAB_ALLOW_WRITES=1…"`, which gates only the stdio server —
`WORKER_ALLOW_WRITES` gates the self-hosted worker, and a hosted multi-tenant deployment has no
flag at all. A library cannot know its deployment shape, and in practice this told a hosted user
to reconfigure a server they do not operate. The default message is now
`"Writes are disabled on this server."` and hosts inject their own remediation text via a new
`writeDisabledHint` option on `Ynab`:

```ts
new Ynab({ client, allowWrites: false, writeDisabledHint: 'Set FOO=1 and restart.' })
```

**`moveMoney` and `assignBudget` now require `confirm: true`.** Reallocating budgeted money was
the only mutating operation with no confirmation gate, while deletes and bulk updates already had
one. Both now throw `ConfirmationRequiredError` without it, matching the existing pattern.

Also in this release: every write returns an `inverse` string describing how to reverse itself
(additive), and bulk `updateTransactions` now reads prior values in **one** request instead of one
per row — a 40-row update dropped from 41 API calls to 2, which matters against YNAB's 200/hour
limit.
