import { describe, it, expect } from 'vitest'
import { alertSignature, decideAlert, assignedDeltaMilli, type CardCheck, type MonitorState } from '../src/monitor.js'

const THRESHOLD = 250_000 // $250 in milli
const MONTH = '2026-07'

function check(overrides: Partial<CardCheck> = {}): CardCheck {
  return { cardKey: 'citi', name: 'Citi', gapMilli: 0, availableMilli: 0, owedMilli: 0, ...overrides }
}

describe('alertSignature', () => {
  it('joins cardKey, month, and gapMilli with colons', () => {
    expect(alertSignature('citi', '2026-07', -50_000)).toBe('citi:2026-07:-50000')
  })
})

describe('decideAlert', () => {
  it('never alerts on the first-ever observation (lastGapMilli null), but still records a signature', () => {
    const state: MonitorState = { lastGapMilli: null, lastAlertSignature: null }
    const result = decideAlert(check({ gapMilli: -500_000 }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    expect(result.reason).toBeNull()
    expect(result.signature).toBe(alertSignature('citi', MONTH, -500_000))
  })

  it('alerts with reason "moved" when the gap moves more than the threshold (staying non-negative)', () => {
    const state: MonitorState = { lastGapMilli: 100_000, lastAlertSignature: null }
    const result = decideAlert(check({ gapMilli: 500_000 }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(true)
    expect(result.reason).toBe('moved')
  })

  it('does not alert when the gap moves less than or equal to the threshold', () => {
    const state: MonitorState = { lastGapMilli: 100_000, lastAlertSignature: null }
    const result = decideAlert(check({ gapMilli: 200_000 }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    expect(result.reason).toBeNull()
  })

  it('alerts with reason "went_red" when the card goes negative, even when the move is under threshold', () => {
    const state: MonitorState = { lastGapMilli: 0, lastAlertSignature: null }
    const result = decideAlert(check({ gapMilli: -50_000 }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(true)
    expect(result.reason).toBe('went_red')
  })

  it('does not treat an already-red card moving further red (under threshold) as went_red', () => {
    const state: MonitorState = { lastGapMilli: -50_000, lastAlertSignature: null }
    const result = decideAlert(check({ gapMilli: -80_000 }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    expect(result.reason).toBeNull()
  })

  it('does not alert when the gap is unchanged from the last observation, regardless of the stored signature', () => {
    const gapMilli = -600_000
    const state: MonitorState = { lastGapMilli: gapMilli, lastAlertSignature: alertSignature('citi', MONTH, gapMilli) }
    const result = decideAlert(check({ gapMilli }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    expect(result.reason).toBeNull()
  })

  it('an oscillating gap is not suppressed by a stale alert signature — a real threshold-crossing swing back to a previously-alerted value still alerts', () => {
    // Reproduces the exact regression traced in review: t1 alerts at −600k; t2/t3 drift further red
    // in individually sub-threshold steps (no alert, so — under the OLD "only store on alert"
    // policy — lastAlertSignature is never refreshed past t1's); t4 swings back +400k to EXACTLY
    // −600k again, a real >threshold move, but its signature collides with the one stored at t1.
    // Signature-based suppression would have silently dropped this legitimate alert; decideAlert no
    // longer looks at lastAlertSignature at all, so t4 must still alert on the state-diff alone.
    const cardKey = 'citi'
    const buildCheck = (gapMilli: number) => check({ cardKey, gapMilli })

    // t0: first-ever observation — establishes the baseline, never alerts.
    let state: MonitorState = { lastGapMilli: null, lastAlertSignature: null }
    let result = decideAlert(buildCheck(0), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    state = { lastGapMilli: 0, lastAlertSignature: state.lastAlertSignature }

    // t1: card goes red — alerts.
    result = decideAlert(buildCheck(-600_000), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(true)
    expect(result.reason).toBe('went_red')
    state = { lastGapMilli: -600_000, lastAlertSignature: result.signature } // worst case: only advances on alert

    // t2: sub-threshold drift further red — no alert; stale signature from t1 is left untouched.
    result = decideAlert(buildCheck(-800_000), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    state = { lastGapMilli: -800_000, lastAlertSignature: state.lastAlertSignature }

    // t3: another sub-threshold drift further red — still no alert, signature still stale from t1.
    result = decideAlert(buildCheck(-1_000_000), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    state = { lastGapMilli: -1_000_000, lastAlertSignature: state.lastAlertSignature }

    // t4: a legitimate 400k swing back to exactly −600k — same signature as t1's alert, but a real,
    // independent threshold-crossing event. Must alert.
    result = decideAlert(buildCheck(-600_000), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(true)
    expect(result.reason).toBe('moved')
    expect(result.signature).toBe(state.lastAlertSignature) // proves the collision the old logic would've suppressed on
  })

  it('recovery from red to zero alerts as "moved" only when the swing exceeds the threshold', () => {
    const bigState: MonitorState = { lastGapMilli: -500_000, lastAlertSignature: null }
    const big = decideAlert(check({ gapMilli: 0 }), bigState, THRESHOLD, MONTH)
    expect(big.alert).toBe(true)
    expect(big.reason).toBe('moved')

    const smallState: MonitorState = { lastGapMilli: -100_000, lastAlertSignature: null }
    const small = decideAlert(check({ gapMilli: 0 }), smallState, THRESHOLD, MONTH)
    expect(small.alert).toBe(false)
    expect(small.reason).toBeNull()
  })
})

describe('assignedDeltaMilli', () => {
  it('returns 0 on the first-ever observation (no prior budgeted figure or month tag)', () => {
    expect(assignedDeltaMilli(500_000, null, null, '2026-07')).toBe(0)
  })

  it('returns the raw diff when the last check was in the same month', () => {
    expect(assignedDeltaMilli(700_000, 500_000, '2026-07', '2026-07')).toBe(200_000)
  })

  it('discards last month\'s accumulated total at month rollover — the fresh figure IS the delta', () => {
    // Last month ended with $2,000 budgeted total; this month's first check sees $300 budgeted so
    // far. A raw diff would read as a $1,700 phantom drain; the correct delta is just the $300.
    expect(assignedDeltaMilli(300_000, 2_000_000, '2026-06', '2026-07')).toBe(300_000)
  })

  it('returns 0 at rollover when nothing has been assigned yet in the new month', () => {
    expect(assignedDeltaMilli(0, 2_000_000, '2026-06', '2026-07')).toBe(0)
  })
})
