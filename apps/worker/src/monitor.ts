export interface CardCheck {
  cardKey: string
  name: string
  gapMilli: number
  availableMilli: number
  owedMilli: number
}

export interface MonitorState {
  lastGapMilli: number | null
  lastAlertSignature: string | null
}

/** Dedup key for an alert event: same card + month + exact gap value. */
export function alertSignature(cardKey: string, month: string, gapMilli: number): string {
  return `${cardKey}:${month}:${gapMilli}`
}

/**
 * Alert when the gap moves more than `thresholdMilli` since the last observation, OR the card
 * goes red (gap < 0) while it was previously covered (lastGap ?? 0 >= 0) — the latter fires
 * regardless of threshold, since any red payment category is worth flagging immediately.
 * Never alerts on the first-ever observation (lastGapMilli === null): there is nothing to compare
 * against yet, so this call only establishes a baseline.
 *
 * `signature` is returned (and expected to be persisted) for OBSERVABILITY only — e.g. correlating
 * hourly runs in `wrangler tail` — it does not gate whether an alert fires. State-diff already
 * prevents duplicate alerts on an unchanged gap (moved === 0; went_red requires lastGap >= 0, which
 * an already-red card never has again). Signature-based suppression was tried and removed: it can
 * silently drop a legitimate alert when an oscillating gap happens to revisit an exact value it
 * alerted on before (e.g. −600k → −1M via sub-threshold drift → a real >threshold swing back to
 * exactly −600k) purely because the two events share a signature, even though the second swing is
 * its own independent, threshold-crossing event.
 */
export function decideAlert(
  check: CardCheck,
  state: MonitorState,
  thresholdMilli: number,
  month: string,
): { alert: boolean; reason: 'moved' | 'went_red' | null; signature: string } {
  const signature = alertSignature(check.cardKey, month, check.gapMilli)

  if (state.lastGapMilli === null) {
    return { alert: false, reason: null, signature }
  }

  const lastGap = state.lastGapMilli
  const wentRed = check.gapMilli < 0 && lastGap >= 0
  const moved = Math.abs(check.gapMilli - lastGap) > thresholdMilli
  const reason: 'moved' | 'went_red' | null = wentRed ? 'went_red' : moved ? 'moved' : null

  return { alert: wentRed || moved, reason, signature }
}

/**
 * Assignment delta since the last hourly check, MONTH-AWARE. A raw `budgetedNow − lastBudgeted`
 * diff is only meaningful when both observations fall in the same YNAB month — `budgeted` is a
 * cumulative-for-the-month total, so subtracting last month's ACCUMULATED figure from this month's
 * fresh one on the first check after rollover would produce a large phantom negative
 * "payment_category_drain" that never actually happened.
 *
 * - First-ever observation (`lastBudgeted` and `lastMonth` both null): nothing to diff against → 0.
 * - Month has rolled over (`lastMonth !== currentMonth`): the new month starts its `budgeted` total
 *   from zero, so whatever is budgeted at the first hourly check IS the delta — a legitimate cover
 *   (or, if nothing's been assigned yet, a legitimate zero).
 * - Same month as the last check: the plain diff.
 */
export function assignedDeltaMilli(
  budgetedNow: number,
  lastBudgeted: number | null,
  lastMonth: string | null,
  currentMonth: string,
): number {
  if (lastBudgeted === null && lastMonth === null) return 0
  if (lastMonth !== currentMonth) return budgetedNow
  return budgetedNow - (lastBudgeted ?? 0)
}
