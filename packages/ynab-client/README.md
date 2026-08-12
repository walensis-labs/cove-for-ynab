# @walensis/ynab-client

Typed YNAB API client with rate limiting and delta-sync caching.

## Install

```bash
npm install @walensis/ynab-client
```

## Usage

```typescript
import { YnabClient, RateLimiter } from '@walensis/ynab-client'

const limiter = new RateLimiter({ requests: 200, intervalMs: 3600000 })
const client = new YnabClient({ token: process.env.YNAB_TOKEN, limiter })
const budgets = await client.request('/budgets', { method: 'GET' })
```

## Spec drift

The vendored OpenAPI spec is checked against upstream in CI. Review and re-vendor with `pnpm -F @walensis/ynab-client gen:api` if needed.
