import type { D1Database } from '@cloudflare/workers-types'
import { Hono, type Context } from 'hono'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Ynab, YnabClient, RateLimiter, attributeChanges, milliToDollars, type RawTxn } from '@walensis/mcp-for-ynab-core'
import { buildServer } from '@walensis/mcp-for-ynab'
import { D1Ledger } from './d1-ledger.js'
import { parseCardPairs, alertThresholdMilli, type WorkerEnv, type CardPair } from './env.js'
import { decideAlert, assignedDeltaMilli, type MonitorState } from './monitor.js'
import { formatAlert, formatWeeklyDigest, formatMonthlyReport, buildMonthlySection, type MonthlySection } from './emails.js'

/** Constant-time-ish token check: compare SHA-256 digests, not raw strings. */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const av = new Uint8Array(a)
  const bv = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < av.length; i++) diff |= av[i]! ^ bv[i]!
  return diff === 0
}

/**
 * Shared per-request MCP server construction — identical for both auth routes below (bearer header
 * and token-in-path). Stateless per-request server; the transport aborts its stream when the
 * response completes and nothing else holds resources — no explicit close.
 */
async function handleMcpRequest(c: Context<{ Bindings: WorkerEnv }>): Promise<Response | undefined> {
  // NOTE: RateLimiter state is per-isolate and best-effort on Workers — instantiated fresh per
  // request here because module-level "shared across requests" state is unreliable (isolates are
  // recycled/scaled out at will; there is no cross-request durability without external storage
  // such as a Durable Object, which is out of scope for v1). YNAB's own 200/hr server-side limit
  // is the real backstop.
  const limiter = new RateLimiter()
  const ynab = new Ynab({
    client: new YnabClient({ token: c.env.YNAB_ACCESS_TOKEN, limiter }),
    ledger: new D1Ledger(c.env.DB),
    allowWrites: c.env.WORKER_ALLOW_WRITES === '1',
  })
  const server = buildServer(ynab, limiter)
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return transport.handleRequest(c)
}

export const app = new Hono<{ Bindings: WorkerEnv }>()

app.get('/health', (c) => c.json({ ok: true }))

app.post('/mcp', async (c) => {
  const auth = c.req.header('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!c.env.MCP_AUTH_TOKEN || !token || !(await tokenMatches(token, c.env.MCP_AUTH_TOKEN))) {
    return c.json({ error: 'unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>' }, 401)
  }
  return handleMcpRequest(c)
})

app.on(['GET', 'DELETE'], '/mcp', (c) => {
  c.header('Allow', 'POST')
  return c.json({ error: 'method not allowed: stateless server, POST only' }, 405)
})

// Token-in-path route — claude.ai's custom-connector dialog only accepts a URL (+ optional OAuth);
// static request-header configuration is beta-gated there, so the bearer route above is unreachable
// from claude.ai's UI. This mirrors the suite's health-mcp precedent: embed the token in the path
// instead, e.g. https://<worker-url>/mcp/<MCP_AUTH_TOKEN>. Same constant-time comparison, same
// shared request handler — the only difference is where the token comes from.
app.post('/mcp/:token', async (c) => {
  const token = c.req.param('token')
  if (!c.env.MCP_AUTH_TOKEN || !token || !(await tokenMatches(token, c.env.MCP_AUTH_TOKEN))) {
    return c.json({ error: 'unauthorized: the URL token does not match MCP_AUTH_TOKEN' }, 401)
  }
  return handleMcpRequest(c)
})

app.on(['GET', 'DELETE'], '/mcp/:token', (c) => {
  c.header('Allow', 'POST')
  return c.json({ error: 'method not allowed: stateless server, POST only' }, 405)
})

// --- scheduled() plumbing ------------------------------------------------
//
// The three cron expressions below are declared once in wrangler.jsonc's `triggers.crons` and
// matched verbatim here — see that file for the human-readable cadence (hourly float scan, Sunday
// weekly digest, 1st-of-month close report).
const CRON_HOURLY = '0 * * * *'
const CRON_WEEKLY = '0 13 * * SUN'
const CRON_MONTHLY = '0 13 1 * *'

const CRON_MISFIRE = 'scheduled(): unrecognized cron expression, expected one of ' +
  `${CRON_HOURLY} / ${CRON_WEEKLY} / ${CRON_MONTHLY}`

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7)
}

/** Worker-persisted monitor state: `MonitorState` (decideAlert's pure contract) plus the last
 *  observed `budgeted` figure AND the month it was observed in — `assignedDeltaMilli` (monitor.ts)
 *  needs both to tell a same-month diff from a month-rollover reset. */
interface PersistedState extends MonitorState {
  lastBudgetedMilli: number | null
  lastMonth: string | null
}

async function readMonitorState(db: D1Database, cardKey: string): Promise<PersistedState> {
  const row = await db
    .prepare('SELECT last_gap_milli, last_alert_signature, last_budgeted_milli, last_month FROM monitor_state WHERE card_key = ?')
    .bind(cardKey)
    .first<{ last_gap_milli: number | null; last_alert_signature: string | null; last_budgeted_milli: number | null; last_month: string | null }>()
  return {
    lastGapMilli: row?.last_gap_milli ?? null,
    lastAlertSignature: row?.last_alert_signature ?? null,
    lastBudgetedMilli: row?.last_budgeted_milli ?? null,
    lastMonth: row?.last_month ?? null,
  }
}

async function writeMonitorState(db: D1Database, cardKey: string, state: PersistedState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO monitor_state (card_key, last_gap_milli, last_alert_signature, last_budgeted_milli, last_month, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(card_key) DO UPDATE SET
         last_gap_milli = excluded.last_gap_milli,
         last_alert_signature = excluded.last_alert_signature,
         last_budgeted_milli = excluded.last_budgeted_milli,
         last_month = excluded.last_month,
         updated_at = excluded.updated_at`,
    )
    .bind(cardKey, state.lastGapMilli, state.lastAlertSignature, state.lastBudgetedMilli, state.lastMonth, new Date().toISOString())
    .run()
}

/** category.balance + account.balance, raw milli — same gap identity as month_close. */
async function fetchGapMilli(
  client: YnabClient,
  planId: string,
  pair: CardPair,
): Promise<{ gapMilli: number; availableMilli: number; owedMilli: number; budgetedMilli: number }> {
  const [catData, acctData] = await Promise.all([
    client.request<{ category: { balance: number; budgeted: number } }>(`/plans/${planId}/months/current/categories/${pair.paymentCategoryId}`),
    client.request<{ account: { balance: number } }>(`/plans/${planId}/accounts/${pair.cardAccountId}`),
  ])
  const availableMilli = catData.category.balance
  const owedMilli = -acctData.account.balance
  return {
    gapMilli: availableMilli + acctData.account.balance,
    availableMilli,
    owedMilli,
    budgetedMilli: catData.category.budgeted,
  }
}

async function sendDigest(env: WorkerEnv, email: { subject: string; text: string }): Promise<void> {
  await env.EMAIL.send({
    to: env.DIGEST_TO ?? '',
    from: { email: env.DIGEST_FROM ?? '', name: env.DIGEST_FROM_NAME },
    subject: email.subject,
    text: email.text,
  })
}

/** Hourly float scan: per-card gap check, alert-on-threshold/red, `monitor_state` upserted every run. */
async function hourlySweep(env: WorkerEnv): Promise<void> {
  const planId = env.PLAN_ID ?? 'last-used'
  const pairs = parseCardPairs(env.CARD_PAIRS)
  const threshold = alertThresholdMilli(env)
  const month = currentMonth()
  const client = new YnabClient({ token: env.YNAB_ACCESS_TOKEN, limiter: new RateLimiter() })

  for (const pair of pairs) {
    const cardKey = pair.cardAccountId
    try {
      const { gapMilli, availableMilli, owedMilli, budgetedMilli } = await fetchGapMilli(client, planId, pair)
      const state = await readMonitorState(env.DB, cardKey)
      const decision = decideAlert({ cardKey, name: pair.name, gapMilli, availableMilli, owedMilli }, state, threshold, month)

      if (decision.alert) {
        const gapChangeMilli = gapMilli - (state.lastGapMilli ?? 0)
        // Month-aware assignment delta (monitor.ts) — NOT a raw budgetedMilli-vs-lastBudgetedMilli
        // diff, which would read last month's ACCUMULATED total against this month's fresh figure
        // as a phantom drain on the first check after rollover.
        const assignedMilli = assignedDeltaMilli(budgetedMilli, state.lastBudgetedMilli, state.lastMonth, month)
        const txnsData = await client.request<{ transactions: RawTxn[] }>(`/plans/${planId}/accounts/${pair.cardAccountId}/transactions`, {
          query: { since_date: `${month}-01` },
        })
        // NOTE: a single hourly point has no "previous month" for attributeChanges to compare
        // against, so its overpayment_absorption stage can never fire here (it only looks at
        // points[i-1]). Near-rollover gap changes may therefore come back as unattributed/residual
        // rather than absorption — that's the honest outcome given what's observable within an hour.
        const [attributed] = attributeChanges(
          [{ month, gapChangeMilli, availableMilli, assignedMilli }],
          txnsData.transactions,
        )
        const causes = (attributed?.components ?? []).map((c) => ({ cause: c.cause as string, amount: milliToDollars(c.amountMilli) }))
        const email = formatAlert(pair.name, milliToDollars(gapChangeMilli), milliToDollars(gapMilli), causes, month)
        await sendDigest(env, email)
      }

      // Upserted every check (alert or not); lastAlertSignature is now stored purely for
      // observability (decideAlert no longer uses it to suppress) — always advance it to the
      // latest computed signature. lastMonth is stamped with the CURRENT check's month so the next
      // check can tell a same-month diff from a rollover.
      await writeMonitorState(env.DB, cardKey, {
        lastGapMilli: gapMilli,
        lastAlertSignature: decision.signature,
        lastBudgetedMilli: budgetedMilli,
        lastMonth: month,
      })
    } catch (e) {
      // One card's failure must never kill the sweep for the rest — logged for `wrangler tail`.
      console.error(`hourly float scan failed for card "${pair.name}" (${cardKey}):`, e)
    }
  }
}

/**
 * Sunday weekly digest: one line when every card is covered, a per-card breakdown otherwise.
 *
 * CRITICAL 1 fix: a per-card fetch failure must never silently drop the card from the digest —
 * that would let `formatWeeklyDigest`'s healthy check pass vacuously on whatever cards happen to
 * remain (or on an empty array, with an expired PAT/partial outage). Every pair yields an entry:
 * `{ name, gap }` on success, `{ name, error: true }` on failure — never omitted.
 */
async function weeklyDigest(env: WorkerEnv): Promise<void> {
  const planId = env.PLAN_ID ?? 'last-used'
  const pairs = parseCardPairs(env.CARD_PAIRS)
  const client = new YnabClient({ token: env.YNAB_ACCESS_TOKEN, limiter: new RateLimiter() })

  const cards: { name: string; gap?: number; error?: boolean }[] = []
  for (const pair of pairs) {
    try {
      const { gapMilli } = await fetchGapMilli(client, planId, pair)
      cards.push({ name: pair.name, gap: milliToDollars(gapMilli) })
    } catch (e) {
      console.error(`weekly digest fetch failed for card "${pair.name}":`, e)
      cards.push({ name: pair.name, error: true })
    }
  }
  await sendDigest(env, formatWeeklyDigest(cards))
}

/**
 * 1st-of-month close report: per-card section for last month, sourced LIVE from
 * `ynab.getCreditCardFloatHistory` (the same inline-attribution pipeline `credit_card_float_history`
 * uses) — never from the ledger. A recorded `MonthCloseRecord` can bundle multiple cards behind one
 * flat `causes` list with no per-card tag; deriving each card's section from that would leak every
 * other closed card's causes (and their summed gapChange) into this card's line. The ledger is
 * still consulted, but ONLY to detect whether a `/month-close` session actually ran for THIS card
 * last month (any `kind:'close'` record whose `cutoff` falls in last month AND whose `perCard`
 * includes this card's account name) — `buildMonthlySection` (emails.ts) decides, independently of
 * whether live causes exist, whether that "no close recorded" nudge belongs in the section.
 */
async function monthlyReport(env: WorkerEnv): Promise<void> {
  const planId = env.PLAN_ID ?? 'last-used'
  const pairs = parseCardPairs(env.CARD_PAIRS)
  const client = new YnabClient({ token: env.YNAB_ACCESS_TOKEN, limiter: new RateLimiter() })
  const ynab = new Ynab({ client, allowWrites: false })
  const ledger = new D1Ledger(env.DB)
  const lastMonth = previousMonth(currentMonth())
  const monthBeforeLast = previousMonth(lastMonth)

  // Bounded to the most recent rows (list() is newest-first) — last month's closes are always
  // among the newest records in an append-only ledger, so this avoids scanning the full history.
  const closeRecords = await ledger.list({ kind: 'close', limit: 200 })
  const closedCardsLastMonth = new Set(
    closeRecords
      .filter((r) => r.cutoff.startsWith(lastMonth))
      .flatMap((r) => r.perCard.map((p) => p.account)),
  )

  const sections: MonthlySection[] = []
  for (const pair of pairs) {
    try {
      const history = await ynab.getCreditCardFloatHistory(planId, {
        paymentCategoryId: pair.paymentCategoryId,
        cardAccountId: pair.cardAccountId,
        sinceMonth: monthBeforeLast,
        untilMonth: lastMonth,
      })
      // `closeRecords[].perCard[].account` is the YNAB account NAME (see D1Ledger/domain.ts), so
      // the probe key must be `history.account` (same field, same source) — NOT `pair.name`, which
      // is CARD_PAIRS' free-form display label and need not match the YNAB account name at all.
      // Probing with pair.name would silently mismatch on any budget where the two differ, always
      // emitting "no close recorded" even right after a real /month-close run for this card.
      const closedInLedger = closedCardsLastMonth.has(history.account)
      const raw = history.points.find((p) => p.month === lastMonth)
      // `raw` is undefined when the range fetch returned nothing for last month at all (e.g. wrong
      // ids) — that's Minor B's "no data" case, kept separate from a real, unchanged point.
      const point = raw
        ? { gap: raw.gap, gapChange: raw.gapChange, causes: (raw.evidence?.components ?? []).map((c) => ({ cause: c.cause, amount: c.amount })) }
        : undefined
      sections.push(buildMonthlySection(pair.name, point, closedInLedger))
    } catch (e) {
      console.error(`monthly report fetch failed for card "${pair.name}":`, e)
      // A fetch failure is data we don't have, same as an absent point — report it honestly rather
      // than silently dropping the card from the email. No `history.account` is available here (the
      // fetch that would have produced it failed), so fall back to the CARD_PAIRS label — the best
      // available approximation when we have nothing else to probe with.
      const closedInLedger = closedCardsLastMonth.has(pair.name)
      sections.push(buildMonthlySection(pair.name, undefined, closedInLedger))
    }
  }
  await sendDigest(env, formatMonthlyReport(lastMonth, sections))
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case CRON_HOURLY:
        await hourlySweep(env)
        break
      case CRON_WEEKLY:
        // README's "CARD_PAIRS defaults to [] — nothing monitored, crons are no-ops" claim: the
        // hourly loop is naturally a no-op on an empty pair list, but weeklyDigest/formatWeeklyDigest
        // are NOT — an empty `cards` array must not reach formatWeeklyDigest and be misread as
        // "nothing to report" via some other path, so skip the send outright rather than relying on
        // formatWeeklyDigest's empty-array guard alone to keep the email silent.
        if (parseCardPairs(env.CARD_PAIRS).length === 0) {
          console.log('scheduled(): CARD_PAIRS is empty — weekly digest skipped')
          break
        }
        await weeklyDigest(env)
        break
      case CRON_MONTHLY:
        if (parseCardPairs(env.CARD_PAIRS).length === 0) {
          console.log('scheduled(): CARD_PAIRS is empty — monthly report skipped')
          break
        }
        await monthlyReport(env)
        break
      default:
        // Should be unreachable — wrangler.jsonc only declares the three crons above — but logged
        // rather than thrown so a misconfigured/manual trigger doesn't show up as a Worker error.
        console.error(`${CRON_MISFIRE} — got "${event.cron}"`)
    }
  },
}
