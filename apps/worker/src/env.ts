import type { D1Database } from '@cloudflare/workers-types'
import { dollarsToMilli } from '@walensis/mcp-for-ynab-core'

export interface WorkerEnv {
  YNAB_ACCESS_TOKEN: string
  MCP_AUTH_TOKEN: string
  WORKER_ALLOW_WRITES?: string
  PLAN_ID?: string
  CARD_PAIRS?: string
  DIGEST_TO?: string
  DIGEST_FROM?: string
  DIGEST_FROM_NAME?: string
  ALERT_THRESHOLD_DOLLARS?: string
  DB: D1Database
  /** Cloudflare Email Sending binding — requires Workers Paid. Optional: free-plan deploys instead
   *  set RESEND_API_KEY and skip binding this. See email-sender.ts's selectSender(). */
  EMAIL?: { send(msg: { to: string; from: { email: string; name?: string }; subject: string; text: string; html?: string }): Promise<unknown> }
  /** Resend (https://resend.com) API key — the free-plan alternative to the EMAIL binding. */
  RESEND_API_KEY?: string
}

export interface CardPair { name: string; paymentCategoryId: string; cardAccountId: string }

/** [] when CARD_PAIRS is absent/empty; throws a clear Error on malformed or malshaped JSON. */
export function parseCardPairs(json: string | undefined): CardPair[] {
  if (json === undefined || json === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`CARD_PAIRS is not valid JSON: ${msg}. Expected an array of {name, paymentCategoryId, cardAccountId}.`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('CARD_PAIRS must be a JSON array of {name, paymentCategoryId, cardAccountId} objects.')
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`CARD_PAIRS[${i}] must be an object with string fields: name, paymentCategoryId, cardAccountId.`)
    }
    const { name, paymentCategoryId, cardAccountId } = entry as Record<string, unknown>
    if (typeof name !== 'string' || typeof paymentCategoryId !== 'string' || typeof cardAccountId !== 'string') {
      throw new Error(`CARD_PAIRS[${i}] must have string fields: name, paymentCategoryId, cardAccountId.`)
    }
    return { name, paymentCategoryId, cardAccountId }
  })
}

/** Alert threshold in integer milli, default $250 (250_000 milli). */
export function alertThresholdMilli(env: WorkerEnv): number {
  if (env.ALERT_THRESHOLD_DOLLARS === undefined || env.ALERT_THRESHOLD_DOLLARS === '') return 250_000
  const dollars = Number(env.ALERT_THRESHOLD_DOLLARS)
  if (!Number.isFinite(dollars)) {
    throw new Error(`ALERT_THRESHOLD_DOLLARS must be a number, got: ${env.ALERT_THRESHOLD_DOLLARS}`)
  }
  return dollarsToMilli(dollars)
}
