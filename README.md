# MCP for YNAB

A fast, safe MCP server for YNAB — full budget access for Claude and other AI assistants, read-only by default.

34 tools covering budgets, transactions, categories, payees, accounts, scheduled transactions, and server-computed analytics (spending summaries, budget health, recurring charges, income vs. expense, net worth, month-close coverage, category and credit-card float history). Writes are off unless you explicitly turn them on, risky writes require confirmation, and writes that edit or delete existing data can be undone.

## Quickstart

### Claude Code

```
claude mcp add ynab -e YNAB_ACCESS_TOKEN=xxx -- npx -y @walensis/mcp-for-ynab
```

Replace `xxx` with your personal access token (see [Getting a token](#getting-a-token) below).

### Claude Desktop

Add this to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ynab": {
      "command": "npx",
      "args": ["-y", "@walensis/mcp-for-ynab"],
      "env": {
        "YNAB_ACCESS_TOKEN": "xxx"
      }
    }
  }
}
```

Alternatively, install the `.mcpb` bundle from a [release](https://github.com/walensis-labs/mcp-for-ynab/releases) for a one-click, no-JSON install — Claude Desktop will prompt you for your token and whether to enable writes.

### Other MCP clients

Any client that speaks MCP over stdio can run the server the same way:

```
npx -y @walensis/mcp-for-ynab
```

with `YNAB_ACCESS_TOKEN` set in its environment.

## Getting a token

1. Go to [app.ynab.com](https://app.ynab.com) and sign in.
2. Open **Account Settings** → **Developer Settings**.
3. Under **Personal Access Tokens**, click **New Token**, confirm your password, and copy the token.
4. Use that value as `YNAB_ACCESS_TOKEN`. Treat it like a password — anyone with it has full access to your budget for as long as it's valid.

If you'd rather not put the token directly in your MCP client config, set `YNAB_ACCESS_TOKEN_FILE` to the path of a file containing just the token instead.

## Read-only by default, writes are opt-in

By default this server only exposes read tools — nothing it does can change your budget. To enable the write tools (creating/editing/deleting transactions, assigning money, etc.), set:

```
YNAB_ALLOW_WRITES=1
```

in the server's environment and restart it. With writes enabled:

- **Confirmation gates**: destructive or bulk operations (deleting a transaction, deleting a scheduled transaction, bulk-updating more than 5 transactions) require an explicit `confirm: true` — and bulk updates also require `expected_count` to match the number of rows — so the assistant has to show you what it's about to do before it does it.
- **Undo**: writes that change existing data — transaction edits/deletes, category edits, budget assignments/moves, scheduled transaction edits/deletes, payee renames — are journaled locally, and the `undo_last` tool reverses the most recent one (up to 50 writes of history, stored in `~/.mcp-for-ynab/undo.json`). Writes that *create* something (`create_category`, `create_payee`, `create_account`) and `import_transactions` are **not** reversible — YNAB's API has no delete for categories, payees, or accounts, and no way to undo an import. Those are still journaled (so undo history stays in order), but `undo_last` will tell you a given entry can't be undone and move on to the write before it. See [PRIVACY.md](./PRIVACY.md) for details on that file.

## Rate limits

The underlying API allows 200 requests/hour per token, shared across every app using that same token (this server, the mobile and web apps for YNAB, other integrations, etc.). This server tracks its own usage client-side and stops itself at 190 requests/hour to leave headroom for the rest of your apps, and prefers small, server-computed responses (aggregates, summaries) over dumping raw rows where it can.

## Tools

| Tool | Type | Description |
| --- | --- | --- |
| `list_plans` | read | List all budgets (plans): id, name, currency, last modified. |
| `get_plan_overview` | read | Orient in one call: accounts, current-month Ready to Assign, age of money, category totals. |
| `get_month` | read | Full detail for one month: Ready to Assign, age of money, every category's status. |
| `list_transactions` | read | List or aggregate transactions with filters, pagination, and field selection. |
| `get_transaction` | read | Full detail for one transaction, including split subtransactions. |
| `create_transactions` | write | Create one or more transactions in bulk, with splits and import dedup. |
| `update_transactions` | write | Bulk edit transactions: categorize, approve, set cleared, edit fields. |
| `delete_transaction` | write | Delete one transaction. Requires confirmation. |
| `import_transactions` | write | Trigger import of linked-account transactions. |
| `list_scheduled_transactions` | read | All scheduled (upcoming/recurring) transactions. |
| `create_scheduled_transaction` | write | Create a scheduled transaction (upcoming bill or recurring income). |
| `update_scheduled_transaction` | write | Update a scheduled transaction. |
| `delete_scheduled_transaction` | write | Delete a scheduled transaction. Requires confirmation. |
| `list_categories` | read | All visible categories with balances and target status. |
| `create_category` | write | Create a category (and its group, if needed). |
| `update_category` | write | Rename or hide a category, or set its target. |
| `assign_budget` | write | Set a category's assigned amount for a month. |
| `move_money` | write | Move assigned money between two categories in a month, atomically. |
| `list_payees` | read | All payees (id, name, transfer flag). |
| `rename_payee` | write | Rename a payee across all its transactions. |
| `create_payee` | write | Create a payee. |
| `create_account` | write | Create an account, with a starting balance. |
| `spending_summary` | read | Server-computed spending by category or payee, with optional period comparison. |
| `budget_health` | read | Current-month health check: overspending, underfunded targets, credit-card float. |
| `detect_recurring_charges` | read | Find recurring charges (subscriptions/bills) from about 13 months of history. |
| `income_vs_expense` | read | Monthly income/expense/net series. |
| `net_worth_history` | read | Monthly net-worth series computed from full transaction history. |
| `month_close` | read | Month-close report for a cutoff date: credit-card coverage, blockers, overspent categories, ranked donors. |
| `propose_coverage` | read | Ordered move proposals to bring every overspent category to zero for the cutoff month. |
| `get_category_history` | read | One category's monthly series (assigned/activity/available) across a month range. |
| `credit_card_float_history` | read | Per-month credit-card float analysis over a range: owed vs. payment-category available, gap, changed flag. |
| `record_month_close` | local write | Persist a month-close balance-forward record (per-card gaps, blockers, causes, applied moves). Local file only (`~/.mcp-for-ynab/ledger.json`) — never touches YNAB. |
| `get_month_close_ledger` | read | Read past balance-forward records (newest first), optionally filtered by cutoff. |
| `undo_last` | write | Undo the most recent write made through this server. |

## The month-close session

A guided monthly catch-up flow (Balance → Plan) built on top of the tools above: it works
through blockers until the coverage gap is trusted, attributes credit-card float changes to
their cause, proposes donor-first coverage moves, and — once you approve them — writes a
balance-forward record via `record_month_close` so next month's session has a baseline to
compare against (`get_month_close_ledger`).

- **Claude Code**: use the `/month-close` skill.
- **Claude Desktop and other MCP clients**: the server exposes the same flow as the `month-close-session` MCP prompt.
- Full walkthrough: [docs/playbooks/month-close.md](./docs/playbooks/month-close.md).

## Development

This is a pnpm monorepo: `packages/core` (`@walensis/mcp-for-ynab-core`, the API client for YNAB and domain logic) and `apps/mcp` (`@walensis/mcp-for-ynab`, the MCP server that wraps it).

```
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

To smoke-test against a real budget (read-only — it never writes):

```
YNAB_ACCESS_TOKEN=xxx pnpm smoke
```

To validate `credit_card_float_history` against known-good fixture values (read-only):

```
YNAB_ACCESS_TOKEN=xxx pnpm validate:fixtures
```

## Disclaimer

We are not affiliated, associated, or in any way officially connected with YNAB, or any of its subsidiaries or its affiliates.

## License

MIT © [walensis-labs](https://github.com/walensis-labs)
