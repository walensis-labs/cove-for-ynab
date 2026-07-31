# @walensis/mcp-for-ynab-core

## 0.2.0

### Minor Changes

- 7029301: LedgerLike interface: Ynab accepts any sync-or-async ledger implementation (file LedgerStore unchanged; enables D1-backed ledgers in workers).

## 0.1.0

### Minor Changes

- 3e92eb0: Initial public release: 35 tools for YNAB over MCP — full budget read/write coverage (read-only by default, gated writes with confirmation and undo), month-close sessions with blocker-aware gaps, credit-card float history with deterministic cause attribution, balance-forward ledger with historical backfill, and token-efficient analytics. Ships as npx stdio server and Claude Desktop extension.
