import { Ynab, YnabClient, RateLimiter } from '@walensis/mcp-for-ynab-core'

const token = process.env.YNAB_ACCESS_TOKEN?.trim()
const categoryId = process.env.CATEGORY_ID ?? 'b20cf9b7-0c98-4eaf-9256-59abc598cb11'
const since = process.env.SINCE ?? '2024-08'
const until = process.env.UNTIL ?? '2026-07'
if (!token) { console.error('Set YNAB_ACCESS_TOKEN.'); process.exit(1) }

const limiter = new RateLimiter()
const base = new YnabClient({ token, limiter })
let n = 0
const instrumented = {
  request: async (path: string, opts?: any) => {
    const id = ++n
    const t0 = Date.now()
    console.error(`[${id}] -> ${path}`)
    try {
      const out = await base.request(path, opts)
      console.error(`[${id}] <- ${Date.now() - t0}ms`)
      return out
    } catch (e) {
      console.error(`[${id}] !! ${Date.now() - t0}ms: ${(e as Error).message}`)
      throw e
    }
  },
} as any

const y = new Ynab({ client: instrumented, allowWrites: false })
console.error(`diagnosing get_category_history ${since}..${until} category=${categoryId} (rate-limit remaining: ${limiter.remaining()})`)
const t0 = Date.now()
const res = await y.getCategoryHistory('last-used', { categoryId, sinceMonth: since, untilMonth: until })
console.error(`TOTAL ${Date.now() - t0}ms, ${res.points.length} points, skipped ${res.skippedMonths.length}`)
console.log(JSON.stringify(res, null, 2))
