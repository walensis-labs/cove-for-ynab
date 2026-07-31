# Cove — product model

*How the pieces fit, what's free, and what you're buying. This is the canonical
answer; specs and plans defer to it.*

## The two names

| | What it is | Cost |
|---|---|---|
| **Cove** | The tools. Ask your budget anything, see whether your cards are covered. | Free |
| **Cove Watch** | The always-on layer. It runs whether you show up or not. | Paid — or free if you run it yourself |

Nothing else is a brand. "Cloud", "worker", "multi-tenant" are internal words a
user should never meet.

## Surfaces vs. capabilities

**Surfaces** — how you reach Cove. Always descriptive, never branded:

- **Cove in Claude** — the MCP server (`npx @walensis/cove-mcp`, or a hosted URL)
- **Cove for Chrome** — the extension (store listing: *Cove for YNAB*)
- **Cove by email** — digests and alerts

**Capabilities** — what you're paying for. The only place brand names live:
Cove (free) and Cove Watch (paid).

A surface exposes whichever capabilities you have. The extension is a window,
not a product: free shows the coverage badge, Cove Watch adds the guards.

## What you get, framed by what you want to do

| "I want to…" | What you get | Cost |
|---|---|---|
| **Ask** my budget questions in Claude | The tools, local or hosted | Free |
| **See** coverage inside YNAB | Extension, coverage badge | Free |
| **Be told** when float appears, and why | Hourly checks, explained alerts, retained history | Cove Watch |
| **Be stopped** before I create float | Safe-to-pay and drain guards, in-app | Cove Watch |
| **Run the whole thing myself** | Everything above, self-hosted | Free forever — see [build-your-own-monitoring.md](./build-your-own-monitoring.md) |

## The rule underneath

Two categories, and one test that decides between them:

> **Does it do work when nobody asked?**

- **No → Tool.** Stateless: ask, answer, forget. Open source, free. Runs locally
  or hosted (hosted is free because stateless costs us nothing).
- **Yes → Product.** Autonomous or metered: crons, digests, LLM calls. Private,
  paid when we run it.

And the promise that keeps it honest:

> **Code is always free. Hosting is free only when hosting is free for us.**

The attribution engine — the hard part — is MIT and always will be. A DIYer can
build their own monitor on it in under a hundred lines. Cove Watch sells not
having to.

## Tenancy

- **Open source** is single-tenant: your token, your infrastructure, no accounts.
- **Cove Watch** is multi-tenant: YNAB OAuth, managed persistence, deliverable
  email, billing. That line mirrors YNAB's own — personal access tokens for one
  person, OAuth apps for many.

## Pricing

$5/month or $50/year. YNAB add-ons cluster at $2–4; AI money tools at $6–15.
Cove Watch is more than a utility and less than a budgeting app.
