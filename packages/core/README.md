# @walensis/cove-core

Core library for MCP for YNAB: typed YNAB API client, month-close math, credit-card float
attribution, local balance-forward ledger.

## Package layout

The YNAB API client (`YnabClient`, `YnabApiError`, `RateLimiter`, `RateLimitError`,
`DeltaCache`) now lives in its own package, [`@walensis/ynab-client`](../ynab-client). cove-core
re-exports it in full for backward compatibility — existing imports from `@walensis/cove-core`
keep working unchanged. New code should import from `@walensis/ynab-client` directly.
