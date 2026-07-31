import type { D1Database } from '@cloudflare/workers-types'

export interface WorkerEnv {
  YNAB_ACCESS_TOKEN: string
  MCP_AUTH_TOKEN: string
  WORKER_ALLOW_WRITES?: string
  PLAN_ID?: string
  DB: D1Database
}
