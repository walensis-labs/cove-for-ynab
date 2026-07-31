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
 * against yet, so this call only establishes a baseline. A repeat of an already-alerted signature
 * (same card, month, and exact gap) is suppressed even if the underlying condition still holds.
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
  const triggered = wentRed || moved
  const suppressed = signature === state.lastAlertSignature

  return { alert: triggered && !suppressed, reason, signature }
}
