# @walensis/ynab-client

Typed YNAB API client with rate limiting and delta-sync caching.

## Install

```bash
npm install @walensis/ynab-client
```

## Usage

```typescript
import { YnabClient, RateLimiter } from '@walensis/ynab-client'

// Defaults to 190 requests/hour (headroom under YNAB's 200/hour limit).
const limiter = new RateLimiter()

const token = process.env.YNAB_TOKEN
if (!token) throw new Error('set YNAB_TOKEN')

const client = new YnabClient({ token, limiter })
const data = await client.request<{ plans: Array<{ id: string; name: string }> }>('/plans')
```

## Spec drift

The vendored OpenAPI spec is checked against upstream in CI. Review and re-vendor with `pnpm -F @walensis/ynab-client gen:api` if needed.
