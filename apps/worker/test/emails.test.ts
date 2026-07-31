import { describe, it, expect } from 'vitest'
import { formatAlert, formatWeeklyDigest, formatMonthlyReport, buildMonthlySection } from '../src/emails.js'

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

  it('when the new gap is ~0 (covered), swaps the Fix line for "no action needed" and uses direction-neutral copy', () => {
    const { subject, text } = formatAlert('Citi', 300, 0, [{ cause: 'deliberate_cover', amount: 300 }], '2026-07')
    expect(subject).toContain('moved to $0.00')
    expect(text).not.toContain('shrank')
    expect(text).not.toContain('widened')
    expect(text.trimEnd().endsWith('No action needed — the card is covered.')).toBe(true)
    expect(text).not.toContain(FIX_LINE)
  })

  it('when the gap is NOT covered, keeps directional copy and the Fix line', () => {
    const { text } = formatAlert('Citi', -300, -300, [{ cause: 'uncovered_spending', amount: -300 }], '2026-07')
    expect(text).toContain('widened')
    expect(text.trimEnd().endsWith(FIX_LINE)).toBe(true)
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

  it('unhealthy digest ends with the Fix line', () => {
    const { text } = formatWeeklyDigest([{ name: 'Citi', gap: -50 }])
    expect(text.trimEnd().endsWith(FIX_LINE)).toBe(true)
  })

  it('healthy one-liner never contains the Fix line and stays exactly one line', () => {
    const { text } = formatWeeklyDigest([{ name: 'Citi', gap: 0 }])
    expect(text).not.toContain(FIX_LINE)
    expect(text.split('\n')).toHaveLength(1)
  })

  it('is NOT healthy on an empty card list (vacuous truth guard) — never fabricates "All cards covered"', () => {
    const { subject, text } = formatWeeklyDigest([])
    expect(subject).not.toBe('All cards covered')
    expect(text).not.toContain('All cards covered.')
  })

  it('one error, one healthy card: error line present, healthy per-card line absent, not the healthy one-liner', () => {
    const { subject, text } = formatWeeklyDigest([
      { name: 'Citi', error: true },
      { name: 'Amex', gap: 0 },
    ])
    expect(subject).not.toBe('All cards covered')
    expect(text).toContain('Citi: no data (fetch failed — check YNAB token/ids)')
    expect(text).not.toContain('Amex')
  })

  it('all cards errored: error lines only, plus the Fix line', () => {
    const { text } = formatWeeklyDigest([
      { name: 'Citi', error: true },
      { name: 'Amex', error: true },
    ])
    expect(text).toContain('Citi: no data (fetch failed — check YNAB token/ids)')
    expect(text).toContain('Amex: no data (fetch failed — check YNAB token/ids)')
    expect(text.trimEnd().endsWith(FIX_LINE)).toBe(true)
  })
})

describe('buildMonthlySection', () => {
  it('state 1: point present with causes — header + cause lines, no nudges', () => {
    const section = buildMonthlySection(
      'Citi',
      { gap: -100, gapChange: -100, causes: [{ cause: 'uncovered_spending', amount: -100 }] },
      true,
    )
    expect(section.name).toBe('Citi')
    expect(section.lines[0]).toContain('Citi')
    expect(section.lines[0]).toContain('$100.00')
    expect(section.lines.join('\n')).toContain('uncovered_spending')
    expect(section.lines.join('\n')).not.toContain('No close session recorded')
    expect(section.lines.join('\n')).not.toContain('No gap change')
  })

  it('state 1 variant: point present with causes but NOT closed in the ledger — appends the no-close nudge', () => {
    const section = buildMonthlySection(
      'Citi',
      { gap: -100, gapChange: -100, causes: [{ cause: 'uncovered_spending', amount: -100 }] },
      false,
    )
    expect(section.lines.join('\n')).toContain('No close session recorded — run /month-close.')
  })

  it('state 2: point present, no causes, gapChange ~0, and closed — "No gap change" with NO close-recorded nudge (the mislabeling this split fixes)', () => {
    const section = buildMonthlySection('Amex', { gap: 0, gapChange: 0, causes: [] }, true)
    const text = section.lines.join('\n')
    expect(text).toContain('No gap change this month.')
    expect(text).not.toContain('No close session recorded')
  })

  it('state 2 variant: point present, no causes, gapChange ~0, and NOT closed — both nudges appear', () => {
    const section = buildMonthlySection('Amex', { gap: 0, gapChange: 0, causes: [] }, false)
    const text = section.lines.join('\n')
    expect(text).toContain('No gap change this month.')
    expect(text).toContain('No close session recorded — run /month-close.')
  })

  it('state 3: point undefined — a single honest "no data" line, never a fabricated $0', () => {
    const section = buildMonthlySection('Citi', undefined, true)
    expect(section.lines).toHaveLength(1)
    expect(section.lines[0]).toContain('No data available for this month — check the card ids in CARD_PAIRS.')
    expect(section.lines[0]).not.toContain('$0.00')
  })
})

describe('formatMonthlyReport', () => {
  it('joins the given sections and ends with the Fix sentence', () => {
    const sections = [
      buildMonthlySection('Citi', { gap: -100, gapChange: -100, causes: [{ cause: 'uncovered_spending', amount: -100 }] }, true),
      buildMonthlySection('Amex', { gap: 0, gapChange: 0, causes: [] }, true),
    ]
    const { subject, text } = formatMonthlyReport('2026-07', sections)
    expect(subject).toContain('2026-07')
    expect(text).toContain('Citi')
    expect(text).toContain('Amex')
    expect(text).toContain('uncovered_spending')
    expect(text.trimEnd().endsWith(FIX_LINE)).toBe(true)
  })
})
