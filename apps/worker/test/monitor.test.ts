import { describe, it, expect } from 'vitest'
import { alertSignature, decideAlert, type CardCheck, type MonitorState } from '../src/monitor.js'

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

  it('suppresses an alert whose signature matches lastAlertSignature, even though the underlying condition fires', () => {
    const gapMilli = -500_000
    const signature = alertSignature('citi', MONTH, gapMilli)
    const state: MonitorState = { lastGapMilli: 100_000, lastAlertSignature: signature }
    const result = decideAlert(check({ gapMilli }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(false)
    expect(result.signature).toBe(signature)
  })

  it('does not suppress when the signature differs from lastAlertSignature', () => {
    const state: MonitorState = { lastGapMilli: 100_000, lastAlertSignature: 'citi:2026-06:999' }
    const result = decideAlert(check({ gapMilli: 500_000 }), state, THRESHOLD, MONTH)
    expect(result.alert).toBe(true)
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
