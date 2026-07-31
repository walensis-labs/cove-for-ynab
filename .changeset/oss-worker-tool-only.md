---
"@walensis/cove-mcp": patch
---

`apps/worker` is now endpoint-only: a single-tenant remote MCP endpoint, nothing autonomous. Always-on credit-card float monitoring (hourly checks, digests, alerts) has moved to the hosted product. Self-hosters who want to build their own monitoring on the same open attribution engine, see [docs/build-your-own-monitoring.md](../docs/build-your-own-monitoring.md).
