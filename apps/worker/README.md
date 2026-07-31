# Cove for YNAB — the remote endpoint (self-host)

> **Naming note for forks:** YNAB's branding guidelines require the "X for YNAB" form — a product
> name (or DNS label) must never *lead* with "YNAB". `cove-tools.yourname.workers.dev` is fine;
> `ynabcove.yourname.workers.dev` is not. This matters if you ever pursue a Works-with-YNAB listing.

A single-tenant Cloudflare Worker that gives you the same 35-tool MCP server as the stdio package
(`npx -y @walensis/cove-mcp`), but reachable as a **remote MCP endpoint** — one URL and a token,
working identically from Claude Desktop, Claude Code, claude.ai, and any other Streamable-HTTP MCP
client, including mobile, without a local process to keep running.

This is the whole worker: a stateless request handler built on `@walensis/cove-mcp`'s library
entrypoint (`buildServer`), a token-authenticated route for every kind of client — a bearer-header
route and a token-in-path route (for claude.ai's URL-only custom connectors) — and a D1-backed
ledger for the `month-close`/`backfill_ledger`/`get_month_close_ledger` tools. Nothing else runs
here: no schedules, no email, no autonomous behavior. It answers when asked, same as the stdio
server — just reachable from anywhere.

This package is private (never published to npm) and lives in this OSS repo as the self-host
recipe: run it yourself, on your own Cloudflare account, with your own YNAB token. There is no
hosted/managed version of this worker — you deploy and own the whole thing.

Want always-on monitoring (hourly float checks, digests, alerts) without running your own cron?
That's the hosted product — see the [root README](../../README.md#install-remote). Want to
build that monitoring yourself on top of this same open engine? See
[docs/build-your-own-monitoring.md](../../docs/build-your-own-monitoring.md).

## Prerequisites

- A Cloudflare account, with `wrangler` installed and logged in (`wrangler login`).
- A YNAB personal access token (see the [root README](../../README.md#getting-a-token) for how to get one).

## Your deploy config vs. the committed template

`wrangler.jsonc` in this repo is a **template** — `database_id` is a `REPLACE_ME` placeholder on
purpose. Keep your real values out of version control:

```bash
cp wrangler.jsonc wrangler.local.jsonc   # gitignored
# edit wrangler.local.jsonc with your D1 id
npx wrangler deploy --config wrangler.local.jsonc
```

Every `wrangler` command below takes `--config wrangler.local.jsonc` the same way. (Secrets never
go in either file — they're set with `wrangler secret put`.)

## One-time setup

Run from `apps/worker/`:

```bash
# one-time
wrangler d1 create cove-tools      # paste database_id into wrangler.jsonc
wrangler d1 execute cove-tools --file=./schema.sql --remote
wrangler secret put YNAB_ACCESS_TOKEN
wrangler secret put MCP_AUTH_TOKEN            # `openssl rand -hex 32` — hex only, no `/`; see note below
# config: edit wrangler.jsonc vars — PLAN_ID (defaults to "last-used")
wrangler deploy
# verify
curl https://<worker-url>/health
# connect a client — see "Connecting a client" below
```

## Connecting a client

The worker exposes the same 35-tool MCP server at two routes, differing only in how the auth token
is supplied — pick whichever your client supports:

- **claude.ai (web/mobile)** — its custom-connector dialog only accepts a URL (optionally + OAuth);
  configuring a static request header is currently beta-gated there, so the bearer route below isn't
  reachable from its UI. Instead, add a custom connector with the token embedded in the URL:

  ```
  https://<worker-url>/mcp/<MCP_AUTH_TOKEN>
  ```

  No header needed. **Generate `MCP_AUTH_TOKEN` with `openssl rand -hex 32`** (or any generator
  restricted to a URL-safe charset) rather than a generic random string — a token containing `/`
  breaks path segmentation on `/mcp/:token` and **silently 404s** (looks like a broken deploy, not
  a bad token) instead of failing loudly.

  **Treat this full URL as a secret** — anyone who has it can read (and, if `WORKER_ALLOW_WRITES`
  is on, write) your budget through it. Know where it WILL be recorded, not just where it might
  leak — this is a guaranteed-logging problem, not a hypothetical-leak one: (1) this project's
  `wrangler.jsonc` enables Workers Logs observability, which records the full request URL —
  **including the token** — on every call; anyone with dashboard access to your Cloudflare account
  can read it there (mitigate with `"observability": { "enabled": true, "head_sampling_rate": 0
  }`, or prefer the bearer route when log access is a concern); (2) **`wrangler tail`** streams
  those same request logs — including the token-bearing path — to WHOEVER is running it, live, in
  their terminal; anyone with deploy/tail access to this Worker sees every URL as requests come in,
  same exposure as the dashboard, just a different vector and audience; (3) the URL lands in your
  browser's history/autofill when you paste it into claude.ai. If it leaks, rotate with `wrangler
  secret put MCP_AUTH_TOKEN` and update the connector with the new URL.

- **Header-capable clients** (Claude Code, Cursor, and most other MCP clients) — use the bearer
  route and an `Authorization` header instead, e.g. for Claude Code:

  ```bash
  claude mcp add --transport http ynab https://<worker-url>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
  ```

Both routes run the identical server and enforce the same token via the same constant-time
comparison — `/mcp/:token` exists solely to work around claude.ai's URL-only connector UI, not as a
weaker auth path.

Notes on the `vars` block in `wrangler.jsonc`:

- **`PLAN_ID`** — the YNAB budget id, or `"last-used"`.
- **`WORKER_ALLOW_WRITES`** — see the caveat below. Leave it `"0"` unless you specifically need it.

## Schema updates

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`, which means re-running

```bash
wrangler d1 execute cove-tools --file=./schema.sql --remote
```

against a database that already has the table is a **no-op** — it will NOT add new columns to an
existing table. When you pull a worker update that changes `schema.sql` (e.g. a new column),
compare the repo's `schema.sql` against what you last applied and write the appropriate `ALTER
TABLE ledger_records ADD COLUMN ...` statements yourself. **Never drop `ledger_records`** — it's
your durable balance-forward history; there is no way to reconstruct it from YNAB after the fact.

## `WORKER_ALLOW_WRITES`

Off (`"0"`) by default, and that's the recommended setting. If you turn it on, be aware:

- **Remote writes on this worker have no undo journal.** The stdio server's `undo_last` is backed
  by a local file (`~/.cove/undo.json`); the worker has no equivalent yet — `D1Ledger` only
  persists month-close/backfill records, not a write-undo journal. On the worker, `undo_last` will
  simply report nothing to undo, even right after a write that changed something.
- Leave writes off on the worker unless you have a specific need for a remote client (e.g. claude.ai)
  to make changes directly. The stdio server (`npx -y @walensis/cove-mcp` with
  `YNAB_ALLOW_WRITES=1`) remains the writing surface with undo protection — use it for anything that
  edits or deletes existing data.

## Disclaimer

We are not affiliated, associated, or in any way officially connected with YNAB, or any of its
subsidiaries or its affiliates.
