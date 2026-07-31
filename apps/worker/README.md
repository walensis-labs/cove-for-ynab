# mcp-for-ynab worker — always-on monitoring (self-host)

A single-tenant Cloudflare Worker that gives you two things stdio can't:

- **A remote MCP endpoint** — the same 35-tool server (`@walensis/mcp-for-ynab`'s library entrypoint,
  `buildServer`), reachable over Streamable HTTP with a token-authenticated route for every kind of
  client — a bearer-header route and a token-in-path route (for claude.ai's URL-only custom
  connectors) — so claude.ai and any other Streamable-HTTP MCP client can connect to your budget
  without a local process. See "Connecting a client" below.
- **Always-on float monitoring** — an hourly check of each credit card's payment-category coverage,
  a quiet Sunday digest, and a monthly close report, all delivered by email via Cloudflare Email
  Service, backed by a D1 ledger.

This package is private (never published to npm) and lives in this OSS repo as the self-host
recipe: run it yourself, on your own Cloudflare account, with your own YNAB token. There is no
hosted/managed version of this worker — you deploy and own the whole thing.

## Prerequisites

- A Cloudflare account, with `wrangler` installed and logged in (`wrangler login`).
- A domain added to Cloudflare, for [Email Sending](https://developers.cloudflare.com/email-routing/email-sending-addresses/) — the worker sends its digests/alerts through that domain.
- A YNAB personal access token (see the [root README](../../README.md#getting-a-token) for how to get one).

## One-time setup

Run from `apps/worker/`:

```bash
# one-time
wrangler d1 create mcp-for-ynab            # paste database_id into wrangler.jsonc
wrangler d1 execute mcp-for-ynab --file=./schema.sql --remote
wrangler email sending enable <your-domain>   # domain must be on Cloudflare
wrangler secret put YNAB_ACCESS_TOKEN
wrangler secret put MCP_AUTH_TOKEN            # any long random string; used as the auth token
# config: edit wrangler.jsonc vars — CARD_PAIRS, DIGEST_TO, DIGEST_FROM, PLAN_ID, ALERT_THRESHOLD_DOLLARS
wrangler deploy
# verify
curl https://<worker-url>/health
# connect a client — see "Connecting a client" below
```

`wrangler email sending enable` provisions SPF/DKIM DNS records on your domain; they typically take
**~5–15 minutes to propagate**. If your first alert/digest email doesn't arrive right away, that's
usually just DNS catching up, not a broken deploy — check again after a few minutes before digging
into `wrangler tail`.

## Connecting a client

The worker exposes the same 35-tool MCP server at two routes, differing only in how the auth token
is supplied — pick whichever your client supports:

- **claude.ai (web/mobile)** — its custom-connector dialog only accepts a URL (optionally + OAuth);
  configuring a static request header is currently beta-gated there, so the bearer route below isn't
  reachable from its UI. Instead, add a custom connector with the token embedded in the URL:

  ```
  https://<worker-url>/mcp/<MCP_AUTH_TOKEN>
  ```

  No header needed. **Treat this full URL as a secret** — anyone who has it can read (and, if
  `WORKER_ALLOW_WRITES` is on, write) your budget through it. If it ever leaks, rotate it with
  `wrangler secret put MCP_AUTH_TOKEN` and update the connector with the new URL.

- **Header-capable clients** (Claude Code, Cursor, and most other MCP clients) — use the bearer
  route and an `Authorization` header instead, e.g. for Claude Code:

  ```bash
  claude mcp add --transport http ynab https://<worker-url>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
  ```

Both routes run the identical server and enforce the same token via the same constant-time
comparison — `/mcp/:token` exists solely to work around claude.ai's URL-only connector UI, not as a
weaker auth path.

Notes on the `vars` block in `wrangler.jsonc`:

- **`CARD_PAIRS`** — a JSON array of `{ "name": "...", "paymentCategoryId": "...", "cardAccountId": "..." }`,
  one entry per credit card you want monitored. Both ids come from YNAB (category id and account
  id); an easy way to find them is `list_categories` (for the payment category) and
  `get_plan_overview` (for the account) through the stdio server against the same budget. Defaults
  to `[]` (nothing monitored, crons are no-ops) if left unset.
- **`PLAN_ID`** — the YNAB budget id, or `"last-used"`.
- **`DIGEST_TO`** / **`DIGEST_FROM`** / **`DIGEST_FROM_NAME`** — who gets the emails and who they
  appear to come from. `DIGEST_FROM`'s domain must be the one you ran `wrangler email sending
  enable` on.
- **`ALERT_THRESHOLD_DOLLARS`** — dollar move that triggers an hourly alert (default `250`).
- **`WORKER_ALLOW_WRITES`** — see the caveat below. Leave it `"0"` unless you specifically need it.

## What each cron does

Three schedules, declared once in `wrangler.jsonc`'s `triggers.crons` and branched on in
`src/index.ts`'s `scheduled()`:

- **Hourly (`0 * * * *`)** — for each card in `CARD_PAIRS`, checks the payment-category-available
  vs. card-owed gap. Alerts only when the gap moves more than `ALERT_THRESHOLD_DOLLARS` since the
  last check, or the card goes red (gap < 0) after being covered — never on the first-ever
  observation for a card, which only establishes a baseline. `monitor_state` is upserted on every
  run, alert or not.
- **Weekly (`0 13 * * SUN`, Sunday ~13:00 UTC)** — the digest: one line when every card is covered,
  a per-card gap breakdown otherwise.
- **Monthly (`0 13 1 * *`, 1st of month ~13:00 UTC)** — a close report for the month that just
  ended: one section per card, causes sourced live from `credit_card_float_history` for that card
  (never from the ledger — a recorded close can bundle multiple cards behind one causes list, so
  per-card attribution always comes from the live float history), plus a nudge if no `/month-close`
  session was recorded for that card that month.

## Quiet-when-healthy (§9.7)

This worker is deliberately quiet when there's nothing to say:

- The Sunday digest is **exactly one line** ("All cards covered.") when every card's gap is ~0 —
  no per-card breakdown, no "fix" nudge, because there's nothing to fix.
- Hourly checks only email you on a >$250 move (configurable via `ALERT_THRESHOLD_DOLLARS`) or a
  new red (previously-covered card going negative) — not on every run, and not on sub-threshold
  drift.
- The monthly close report always sends on the 1st, but each card's section is honest about "no
  data" vs. "no gap change" vs. actual causes — it never fabricates a number to fill space.

If you're not getting emails, that's very likely the system working as intended, not a broken
deploy — check `wrangler tail` for the hourly cron actually running before assuming something's
wrong.

## Schema updates

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`, which means re-running

```bash
wrangler d1 execute mcp-for-ynab --file=./schema.sql --remote
```

against a database that already has these tables is a **no-op** — it will NOT add new columns to
an existing table. When you pull a worker update that changes `schema.sql` (e.g. a new column),
compare the repo's `schema.sql` against what you last applied and apply the difference by hand:

- For `ledger_records`: write and run the appropriate `ALTER TABLE ledger_records ADD COLUMN ...`
  statements yourself. **Never drop `ledger_records`** — it's your durable balance-forward history;
  there is no way to reconstruct it from YNAB after the fact.
- For `monitor_state`: it's safe to just drop and re-create it (`DROP TABLE monitor_state;` then
  re-run the schema file) instead of writing `ALTER TABLE` statements. It's derived state — every
  row rebuilds itself from scratch within one hourly cycle. The only cost is that the next check
  after the drop treats each card as a first-ever observation again (baseline only, no alert even
  if the gap is bad), and the assignment-delta math needs one more cycle to have a `lastMonth`/
  `lastBudgetedMilli` to diff against — never a loss of real ledger data.

## `WORKER_ALLOW_WRITES`

Off (`"0"`) by default, and that's the recommended setting. If you turn it on, be aware:

- **Remote writes on this worker have no undo journal.** The stdio server's `undo_last` is backed
  by a local file (`~/.mcp-for-ynab/undo.json`); the worker has no equivalent yet — `D1Ledger` only
  persists month-close/backfill records, not a write-undo journal. On the worker, `undo_last` will
  simply report nothing to undo, even right after a write that changed something.
- Leave writes off on the worker unless you have a specific need for a remote client (e.g. claude.ai)
  to make changes directly. The stdio server (`npx -y @walensis/mcp-for-ynab` with
  `YNAB_ALLOW_WRITES=1`) remains the writing surface with undo protection — use it for anything that
  edits or deletes existing data.

## Disclaimer

We are not affiliated, associated, or in any way officially connected with YNAB, or any of its
subsidiaries or its affiliates.
