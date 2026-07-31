---
"@walensis/cove-core": minor
"@walensis/cove-mcp": minor
---

Rename the npm packages to match the product: `@walensis/mcp-for-ynab-core` → `@walensis/cove-core`, and `@walensis/mcp-for-ynab` → `@walensis/cove-mcp`. The old package names are deprecated in favor of these — update any install commands, imports, or `workspace:*` references. The MCP registry entry (`io.github.walensis-labs/mcp-for-ynab`) keeps its existing descriptive name for discoverability; only its published package identifier changes to `@walensis/cove-mcp`.
