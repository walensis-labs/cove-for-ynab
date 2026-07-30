import { describe, it, expect } from 'vitest'
import { monthRange, floatSeries } from '../src/category-history.js'

describe('monthRange', () => {
  it('produces inclusive first-of-month dates across a year boundary', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'])
  })
  it('single month', () => {
    expect(monthRange('2026-07', '2026-07')).toEqual(['2026-07-01'])
  })
  it('rejects bad formats, inverted ranges, and ranges over 60 months', () => {
    expect(() => monthRange('2026-7', '2026-08')).toThrow(/YYYY-MM/)
    expect(() => monthRange('2026-08', '2026-07')).toThrow(/before/)
    expect(() => monthRange('2020-01', '2026-01')).toThrow(/60 months/)
  })
})

describe('floatSeries', () => {
  // current working balance -1000_000 milli (owes $1000).
  // Txns: -200000 in July (2026-07-10), -300000 in August (2026-08-05).
  // Owed at June EOM: -( -1000000 - (-200000 + -300000) ) = -(-500000) = 500000 (owes $500)
  // Owed at July EOM: -( -1000000 - (-300000) ) = 700000
  // Owed at Aug  EOM: -( -1000000 - 0 ) = 1000000
  const txns = [
    { date: '2026-07-10', amount: -200000 },
    { date: '2026-08-05', amount: -300000 },
    { date: '2026-08-06', amount: -999999, deleted: true },
  ]
  const avail = [
    { month: '2026-06', availableMilli: 500000 },
    { month: '2026-07', availableMilli: 500000 },
    { month: '2026-08', availableMilli: 1000000 },
  ]
  it('computes owed by backing out post-month-end txns from the current balance', () => {
    const s = floatSeries(avail, txns, -1000000)
    expect(s.map((p) => [p.month, p.owedMilli, p.gapMilli, p.changed])).toEqual([
      ['2026-06', 500000, 0, false],       // covered; first point never "changed"
      ['2026-07', 700000, -200000, true],  // new $200 float appeared
      ['2026-08', 1000000, 0, true],       // caught back up
    ])
  })
  it('a static gap is not flagged as changed', () => {
    const s = floatSeries(
      [{ month: '2026-06', availableMilli: 0 }, { month: '2026-07', availableMilli: 0 }],
      [], -100000)
    expect(s.map((p) => [p.gapMilli, p.changed])).toEqual([[-100000, false], [-100000, false]])
  })
})
