import { describe, it, expect } from 'vitest'
import { formatAlert, formatWeeklyDigest, formatMonthlyReport } from '../src/emails.js'

const FIX_LINE = 'Fix: run /month-close in Claude — propose_coverage will draft the covering moves for your approval.'

describe('formatAlert', () => {
  it('includes cause lines, dollar formatting, and ends with the Fix sentence', () => {
    const { subject, text } = formatAlert(
      'Citi',
      -300,
      -300,
      [{ cause: 'uncovered_spending', amount: -300 }],
      '2026-07',
    )
    expect(subject).toContain('Citi')
    expect(text).toContain('$300.00')
    expect(text).toContain('uncovered_spending')
    expect(text.trimEnd().endsWith(FIX_LINE)).toBe(true)
  })

  it('formats a positive gapChange without a stray minus sign', () => {
    const { text } = formatAlert('Amex', 400, 400, [{ cause: 'deliberate_cover', amount: 400 }], '2026-07')
    expect(text).toContain('$400.00')
    expect(text).not.toContain('-$400.00')
  })
})

describe('formatWeeklyDigest', () => {
  it('is exactly one line when every card gap is ~0', () => {
    const { subject, text } = formatWeeklyDigest([
      { name: 'Citi', gap: 0 },
      { name: 'Amex', gap: 0 },
    ])
    expect(subject).toBe('All cards covered')
    expect(text.split('\n')).toHaveLength(1)
  })

  it('lists per-card gaps when at least one card is uncovered', () => {
    const { subject, text } = formatWeeklyDigest([
      { name: 'Citi', gap: -50 },
      { name: 'Amex', gap: 0 },
    ])
    expect(subject).not.toBe('All cards covered')
    expect(text).toContain('Citi')
    expect(text).toContain('$50.00')
  })

  it('appends an optional buffer note to the healthy one-liner', () => {
    const { text } = formatWeeklyDigest([{ name: 'Citi', gap: 0 }], 'Buffer: $500.')
    expect(text).toContain('Buffer: $500.')
    expect(text.split('\n')).toHaveLength(1)
  })
})

describe('formatMonthlyReport', () => {
  it('lists a section per card with causes and ends with the Fix sentence', () => {
    const { subject, text } = formatMonthlyReport('2026-07', [
      { name: 'Citi', gap: -100, gapChange: -100, causes: [{ cause: 'uncovered_spending', amount: -100 }] },
      { name: 'Amex', gap: 0, gapChange: 0, causes: [] },
    ])
    expect(subject).toContain('2026-07')
    expect(text).toContain('Citi')
    expect(text).toContain('Amex')
    expect(text).toContain('uncovered_spending')
    expect(text).toContain('$100.00')
    expect(text.trimEnd().endsWith(FIX_LINE)).toBe(true)
  })

  it('renders a "no close recorded" line for a card with no causes', () => {
    const { text } = formatMonthlyReport('2026-07', [
      { name: 'Amex', gap: 0, gapChange: 0, causes: [] },
    ])
    expect(text).toContain('no close recorded')
  })
})
