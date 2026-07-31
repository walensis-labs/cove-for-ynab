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
  const direction = gapChange < 0 ? 'widened' : 'shrank'
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
  lines.push(FIX_LINE)

  return { subject, text: lines.join('\n') }
}

/**
 * Weekly digest. §9.7 quiet-when-healthy: when every card's gap is ~0, the email is EXACTLY one
 * line — no per-card breakdown, no Fix line (there is nothing to fix).
 */
export function formatWeeklyDigest(cards: { name: string; gap: number }[], bufferNote?: string): EmailContent {
  const healthy = cards.every((c) => Math.abs(c.gap) < COVERED_EPS)

  if (healthy) {
    const suffix = bufferNote ? ` ${bufferNote}` : ''
    return { subject: 'All cards covered', text: `All cards covered.${suffix}` }
  }

  const uncovered = cards.filter((c) => Math.abs(c.gap) >= COVERED_EPS)
  const subject = `Weekly float check: ${uncovered.length} card${uncovered.length === 1 ? '' : 's'} need attention`
  const lines = cards.map((c) => (Math.abs(c.gap) < COVERED_EPS ? `${c.name}: covered` : `${c.name}: gap ${formatDollars(c.gap)}`))
  if (bufferNote) lines.push(bufferNote)

  return { subject, text: lines.join('\n') }
}

/** Monthly close report. One section per card; a card with no ledger record renders "no close recorded". */
export function formatMonthlyReport(
  month: string,
  cards: { name: string; gap: number; gapChange: number; causes: { cause: string; amount: number }[] }[],
): EmailContent {
  const subject = `Month-close report: ${month}`
  const lines: string[] = [`Month-close report for ${month}`, '']

  for (const c of cards) {
    lines.push(`${c.name}: gap ${formatDollars(c.gap)} (change ${formatDollars(c.gapChange)})`)
    if (c.causes.length > 0) {
      for (const cause of c.causes) lines.push(`  - ${cause.cause}: ${formatDollars(cause.amount)}`)
    } else {
      lines.push('  - no close recorded')
    }
    lines.push('')
  }
  lines.push(FIX_LINE)

  return { subject, text: lines.join('\n') }
}
