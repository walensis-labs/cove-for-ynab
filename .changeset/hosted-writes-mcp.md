---
"@walensis/cove-mcp": minor
---

`buildServer` takes an optional write-tool allowlist:

```ts
buildServer(ynab, limiter, { writeTools: 'none' })          // read tools only
buildServer(ynab, limiter, { writeTools: ['move_money'] })  // exactly these
```

Default is `'all'` — existing callers are unaffected.

A tool that cannot be used should be **absent** from the tool list, not present and erroring.
When a write tool is listed but refuses, a model will call it, read the refusal, and try to route
around it — in one real case by confidently instructing the user to set an environment variable
that gated nothing on their deployment. An absent tool produces a clean "I can't do that."

Write-ness comes from the existing `write` marker on each tool definition, so there is no second
list to drift. Ledger tools are never filtered: they write only local storage, never YNAB. An
unrecognized name in the allowlist throws at construction rather than silently registering
nothing.

Note this release also carries `@walensis/cove-core`'s breaking write changes — `move_money` and
`assign_budget` now require confirmation.
