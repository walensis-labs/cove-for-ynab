import { formatDollars } from '@walensis/mcp-for-ynab-core'

/** §9.7: every alert/monthly email ends with this exact sentence — the nudge into the fix workflow. */
const FIX_LINE = 'Fix: run /month-close in Claude — propose_coverage will draft the covering moves for your approval.'

/** ~half a cent — dollars-ready gaps within this of 0 count as "covered" for digest purposes. */
const COVERED_EPS = 0.005

export interface EmailContent {
  subject: string
  text: string
}

/**
 * Hourly-alert email. All numeric inputs are dollars (not milli) — the caller converts. `causes`
 * comes from core's attributeChanges, one line per attribution component.
 */
export function formatAlert(
  name: string,
  gapChange: number,
  gap: number,
  causes: { cause: string; amount: number }[],
  month: string,
): EmailContent {
  // Covered is direction-neutral by construction — "shrank"/"widened" imply the gap is still open
  // and moving; once it's ~0 there's nothing directional left to say, so use neutral copy ("moved")
  // and drop the Fix nudge (there's nothing to fix).
  const covered = Math.abs(gap) < COVERED_EPS
  const direction = covered ? 'moved' : gapChange < 0 ? 'widened' : 'shrank'
  const subject = `${name}: payment-category gap ${direction} to ${formatDollars(gap)} (${month})`

  const lines: string[] = [
    `${name}'s payment-category gap ${direction} by ${formatDollars(Math.abs(gapChange))} this hour.`,
    `Current gap: ${formatDollars(gap)}.`,
    '',
  ]
  if (causes.length > 0) {
    lines.push('Likely causes:')
    for (const c of causes) lines.push(`- ${c.cause}: ${formatDollars(c.amount)}`)
    lines.push('')
  }
  lines.push(covered ? 'No action needed — the card is covered.' : FIX_LINE)

  return { subject, text: lines.join('\n') }
}

/**
 * Weekly digest. §9.7 quiet-when-healthy: when every card's gap is ~0, the email is EXACTLY one
 * line — no per-card breakdown, no Fix line (there is nothing to fix).
 *
 * `gap` is omitted (and `error: true` set) when the caller's per-card fetch failed — CRITICAL 1:
 * a dropped/missing card must never read as "healthy." The healthy one-liner therefore requires
 * BOTH a non-empty card list AND every card carrying a real, ~0 gap; `cards.every(...)` on an
 * empty array would otherwise be vacuously true (e.g. an expired PAT failing every fetch, or the
 * default empty CARD_PAIRS) and fabricate "All cards covered."
 */
export function formatWeeklyDigest(cards: { name: string; gap?: number; error?: boolean }[]): EmailContent {
  const healthy = cards.length > 0 && cards.every((c) => !c.error && c.gap !== undefined && Math.abs(c.gap) < COVERED_EPS)

  if (healthy) {
    return { subject: 'All cards covered', text: 'All cards covered.' }
  }

  // Only cards needing attention (errored, or a real gap that isn't ~0) get a line — covered
  // cards stay silent here too, same quiet-when-healthy spirit applied per-card.
  const needsAttention = cards.filter((c) => c.error || c.gap === undefined || Math.abs(c.gap) >= COVERED_EPS)
  const subject = `Weekly float check: ${needsAttention.length} card${needsAttention.length === 1 ? '' : 's'} need attention`
  const lines = needsAttention.map((c) =>
    c.error || c.gap === undefined ? `${c.name}: no data (fetch failed — check YNAB token/ids)` : `${c.name}: gap ${formatDollars(c.gap)}`,
  )
  lines.push('', FIX_LINE)

  return { subject, text: lines.join('\n') }
}

export interface MonthlySection {
  name: string
  lines: string[]
}

/**
 * Builds ONE card's section of the monthly report — three honest states, never a fabricated figure:
 *
 * 1. `point` undefined (nothing fetched for this card this month, e.g. the category/account id is
 *    wrong or the fetch failed): a single line saying so. NEVER defaults to a $0/"covered" gap —
 *    that would misreport "no data" as "everything's fine."
 * 2. `point` present, `causes` empty: the gap/gapChange header, plus 'No gap change this month.'
 *    ONLY when `gapChange` is ~0 (a real, unexplained nonzero change with no causes is left
 *    unannotated rather than mislabeled as "nothing happened").
 * 3. `point` present, `causes` non-empty: header + one bullet per cause.
 *
 * Independently of all three: 'No close session recorded — run /month-close.' is appended ONLY
 * when `closedInLedger` is false. This is deliberately decoupled from whether `causes` is empty —
 * a card that WAS closed but had zero gap change would otherwise be mislabeled "no close recorded"
 * just because attribution found nothing to explain (the bug this split fixes).
 */
export function buildMonthlySection(
  name: string,
  point: { gap: number; gapChange: number; causes: { cause: string; amount: number }[] } | undefined,
  closedInLedger: boolean,
): MonthlySection {
  if (!point) {
    return { name, lines: [`${name}: No data available for this month — check the card ids in CARD_PAIRS.`] }
  }

  const lines: string[] = [`${name}: gap ${formatDollars(point.gap)} (change ${formatDollars(point.gapChange)})`]

  if (point.causes.length > 0) {
    for (const cause of point.causes) lines.push(`  - ${cause.cause}: ${formatDollars(cause.amount)}`)
  } else if (Math.abs(point.gapChange) < COVERED_EPS) {
    lines.push('  - No gap change this month.')
  }

  if (!closedInLedger) lines.push('  - No close session recorded — run /month-close.')

  return { name, lines }
}

/** Monthly close report. Consumes pre-built per-card sections (see `buildMonthlySection`). */
export function formatMonthlyReport(month: string, sections: MonthlySection[]): EmailContent {
  const subject = `Month-close report: ${month}`
  const lines: string[] = [`Month-close report for ${month}`, '']

  for (const section of sections) {
    lines.push(...section.lines)
    lines.push('')
  }
  lines.push(FIX_LINE)

  return { subject, text: lines.join('\n') }
}
