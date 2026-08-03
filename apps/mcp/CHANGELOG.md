# @walensis/mcp-for-ynab

## 0.4.1

### Patch Changes

- a2067db: `apps/worker` is now endpoint-only: a single-tenant remote MCP endpoint, nothing autonomous. Always-on credit-card float monitoring (hourly checks, digests, alerts) has moved to the hosted product. Self-hosters who want to build their own monitoring on the same open attribution engine, see [docs/build-your-own-monitoring.md](../docs/build-your-own-monitoring.md).

## 0.4.0

### Minor Changes

- 3a41ac2: Rename local state to `~/.cove/` (was `~/.mcp-for-ynab/`) and identify the server as `cove-for-ynab`, matching the product name. If you have an existing undo journal or ledger, move the directory: `mv ~/.mcp-for-ynab ~/.cove`.

## 0.3.0

### Minor Changes

- 9aaa8e8: Rename the npm packages to match the product: `@walensis/mcp-for-ynab-core` → `@walensis/cove-core`, and `@walensis/mcp-for-ynab` → `@walensis/cove-mcp`. The old package names are deprecated in favor of these — update any install commands, imports, or `workspace:*` references. The MCP registry entry (`io.github.walensis-labs/mcp-for-ynab`) keeps its existing descriptive name for discoverability; only its published package identifier changes to `@walensis/cove-mcp`.

### Patch Changes

- 16bdfc4: Retire the `.mcpb` Claude Desktop extension — one fewer artifact to build, version, and publish. There are now exactly two install paths: local (`npx -y @walensis/cove-mcp`, via `claude mcp add` or the Claude Desktop JSON config) or remote (one URL + token, self-hosted today via `apps/worker`, hosted later). See the README for the full install/tier breakdown.
- Updated dependencies [0c0b8ab]
- Updated dependencies [9aaa8e8]
  - @walensis/cove-core@0.3.0

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
