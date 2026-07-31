# @walensis/mcp-for-ynab

## 0.2.1

### Patch Changes

- 16bdfc4: Retire the `.mcpb` Claude Desktop extension — one fewer artifact to build, version, and publish. There are now exactly two install paths: local (`npx -y @walensis/mcp-for-ynab`, via `claude mcp add` or the Claude Desktop JSON config) or remote (one URL + token, self-hosted today via `apps/worker`, hosted later). See the README for the full install/tier breakdown.
- Updated dependencies [0c0b8ab]
  - @walensis/mcp-for-ynab-core@0.2.1

## 0.2.0

### Minor Changes

- 7029301: Library entrypoint: export the 35-tool table, buildServer, and the month-close playbook for embedding (worker/self-host reuse). CLI behavior unchanged.

### Patch Changes

- Updated dependencies [7029301]
  - @walensis/mcp-for-ynab-core@0.2.0

## 0.1.0

### Minor Changes

- 3e92eb0: Initial public release: 35 tools for YNAB over MCP — full budget read/write coverage (read-only by default, gated writes with confirmation and undo), month-close sessions with blocker-aware gaps, credit-card float history with deterministic cause attribution, balance-forward ledger with historical backfill, and token-efficient analytics. Ships as npx stdio server and Claude Desktop extension.

### Patch Changes

- Updated dependencies [3e92eb0]
  - @walensis/mcp-for-ynab-core@0.1.0
