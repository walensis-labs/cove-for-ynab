import { describe, it, expect } from 'vitest'
import { attributeChanges, type AttributionMonthInput } from '../src/attribution.js'

const pt = (month: string, gapChangeMilli: number, availableMilli: number, assignedMilli = 0): AttributionMonthInput =>
  ({ month, gapChangeMilli, availableMilli, assignedMilli })

describe('attributeChanges — §12 fixture table (binding)', () => {
  it('flat run produces zero change-points', () => {
    const flat = ['2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02'].map((m) => pt(m, 0, -865750))
    expect(attributeChanges(flat, [])).toEqual([])
  })
  it('2025-03: absorption of the Feb red', () => {
    const res = attributeChanges([pt('2025-02', 0, -3660), pt('2025-03', 3660, 102670)], [])
    expect(res).toHaveLength(1)
    expect(res[0]!.components).toEqual([{ cause: 'overpayment_absorption', amountMilli: 3660, evidence: { priorRedMilli: -3660 } }])
  })
  it('2025-05: deliberate cover (brief-corrected from unattributed)', () => {
    const res = attributeChanges([pt('2025-04', 0, 766270), pt('2025-05', 7320, 2094240, 7320)], [])
    expect(res[0]!.components).toEqual([{ cause: 'deliberate_cover', amountMilli: 7320, evidence: { assignedMilli: 7320 } }])
  })
  it('2025-12: absorption of the Nov red', () => {
    const res = attributeChanges([pt('2025-11', 0, -189490), pt('2025-12', 189490, 3223110)], [])
    expect(res[0]!.components).toEqual([{ cause: 'overpayment_absorption', amountMilli: 189490, evidence: { priorRedMilli: -189490 } }])
  })
  it('2026-04: the reversal trio', () => {
    const trio = [
      { id: 'pay1', date: '2026-04-10', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
      { id: 'rev1', date: '2026-04-15', amount: -3322550, category_id: null, transfer_account_id: null },
      { id: 'pay2', date: '2026-04-17', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
    ]
    const res = attributeChanges([pt('2026-03', 0, 6966920), pt('2026-04', -3322550, 1417170)], trio)
    expect(res[0]!.components).toHaveLength(1)
    const c = res[0]!.components[0]!
    expect(c.cause).toBe('payment_reversal')
    expect(c.amountMilli).toBe(-3322550)
    expect(c.evidence.txns!.map((t) => t.id).sort()).toEqual(['pay1', 'pay2', 'rev1'])
  })
  it('2026-06: deliberate cover, exact', () => {
    const res = attributeChanges([pt('2026-05', 0, 1101370), pt('2026-06', 1516550, 0, 1516550)], [])
    expect(res[0]!.components).toEqual([{ cause: 'deliberate_cover', amountMilli: 1516550, evidence: { assignedMilli: 1516550 } }])
  })
  it('2026-07: compound — cover 2501.05 plus uncovered spending −29.77', () => {
    const res = attributeChanges([pt('2026-06', 0, 0), pt('2026-07', 2471280, 1350960, 2501050)], [])
    expect(res[0]!.components).toEqual([
      { cause: 'deliberate_cover', amountMilli: 2501050, evidence: { assignedMilli: 2501050 } },
      { cause: 'uncovered_spending', amountMilli: -29770, evidence: { residualMilli: -29770 } },
    ])
  })
  it('synthetic: honest unattributed when nothing matches', () => {
    const res = attributeChanges([pt('2026-01', 0, 500000), pt('2026-02', 7320, 507320)], [])
    expect(res[0]!.components).toEqual([{ cause: 'unattributed', amountMilli: 7320, evidence: { residualMilli: 7320 } }])
  })
  it('uncategorized owed-side debt: categoryless transfer matches the change', () => {
    const cashAdvance = [{ id: 'ca1', date: '2026-05-10', amount: -400000, category_id: null, transfer_account_id: 'chk' }]
    const res = attributeChanges([pt('2026-04', 0, 100000), pt('2026-05', -400000, 100000)], cashAdvance)
    expect(res[0]!.components[0]).toMatchObject({ cause: 'uncategorized_debt', amountMilli: -400000 })
    expect(res[0]!.components[0]!.evidence.txns![0]!.id).toBe('ca1')
  })
})

describe('attributeChanges — reversal subset matching (review fix)', () => {
  it('bystander: an unrelated same-|amount| charge is excluded from the reversal evidence', () => {
    const trioPlusBystander = [
      { id: 'pay1', date: '2026-04-10', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
      { id: 'rev1', date: '2026-04-15', amount: -3322550, category_id: null, transfer_account_id: null },
      { id: 'pay2', date: '2026-04-17', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
      { id: 'sub1', date: '2026-04-05', amount: -3322550, category_id: 'c-sub', transfer_account_id: null },
    ]
    const res = attributeChanges([pt('2026-03', 0, 6966920), pt('2026-04', -3322550, 1417170)], trioPlusBystander)
    expect(res[0]!.components).toHaveLength(1)
    const c = res[0]!.components[0]!
    expect(c.cause).toBe('payment_reversal')
    expect(c.amountMilli).toBe(-3322550)
    expect(c.evidence.txns!.map((t) => t.id).sort()).toEqual(['pay1', 'pay2', 'rev1'])
  })

  it('partial reversal (k=1 subset) leaves a residual that absorption then clears', () => {
    const trio = [
      { id: 'pay1', date: '2026-04-10', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
      { id: 'rev1', date: '2026-04-15', amount: -3322550, category_id: null, transfer_account_id: null },
      { id: 'pay2', date: '2026-04-17', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
    ]
    const res = attributeChanges([pt('2026-03', 0, -189490), pt('2026-04', -3133060, 100000)], trio)
    expect(res[0]!.components).toHaveLength(2)
    const [c1, c2] = res[0]!.components
    expect(c1).toMatchObject({ cause: 'payment_reversal', amountMilli: -3322550 })
    expect(c1!.evidence.txns!.map((t) => t.id).sort()).toEqual(['pay1', 'pay2', 'rev1'])
    expect(c2).toEqual({ cause: 'overpayment_absorption', amountMilli: 189490, evidence: { priorRedMilli: -189490 } })
  })

  it('two unrelated equal-|amount| charges (a 2x multiple) do not form a reversal', () => {
    const unrelated = [
      { id: 'x1', date: '2026-04-08', amount: -50000, category_id: 'c1', transfer_account_id: null },
      { id: 'x2', date: '2026-04-20', amount: -50000, category_id: 'c2', transfer_account_id: null },
    ]
    const res = attributeChanges([pt('2026-03', 0, 500000), pt('2026-04', -100000, 400000)], unrelated)
    expect(res[0]!.components).toEqual([{ cause: 'uncovered_spending', amountMilli: -100000, evidence: { residualMilli: -100000 } }])
  })
})

describe('attributeChanges — leftover gate (second review fix)', () => {
  it('false positive rejection: an unrelated same-|amount| trio does not fabricate a reversal for an unrelated gap', () => {
    // Shape matches k=+1's requirement (2 positives + 1 negative), so without the leftover gate
    // this group passes the sign-count check and would fabricate a payment_reversal purely because
    // |150000 − |−100000|| happens to round-trip to k=1. Leftover after applying it (−100000 +
    // 150000 = +50000) is neither negligible nor the prior red (prior availableMilli is positive,
    // so absorption can't claim it either) — the gate must reject it.
    const unrelatedTrio = [
      { id: 'a', date: '2026-03-05', amount: 150000, category_id: null, transfer_account_id: 'chk' },
      { id: 'c', date: '2026-03-15', amount: -150000, category_id: 'c1', transfer_account_id: null },
      { id: 'b', date: '2026-03-25', amount: 150000, category_id: null, transfer_account_id: 'chk' },
    ]
    const res = attributeChanges([pt('2026-02', 0, 500000), pt('2026-03', -100000, 400000)], unrelatedTrio)
    expect(res[0]!.components).toEqual([{ cause: 'uncovered_spending', amountMilli: -100000, evidence: { residualMilli: -100000 } }])
  })

  it('window regression: txns beyond monthEnd+30d are excluded even though the old month-28+33d bound admitted them', () => {
    // month = 2025-02 (28-day Feb). New correct bound: monthEnd(2025-02-28) + 30d = 2025-03-30.
    // Old buggy bound: (month)-28 + 33d = 2025-04-02. These three dates sit strictly between
    // the two bounds, so they must be excluded by the fixed window but would have been wrongly
    // admitted (and would have formed a false payment_reversal) under the old arithmetic.
    const trio = [
      { id: 'pay1', date: '2025-03-31', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
      { id: 'rev1', date: '2025-04-01', amount: -3322550, category_id: null, transfer_account_id: null },
      { id: 'pay2', date: '2025-04-02', amount: 3322550, category_id: null, transfer_account_id: 'chk' },
    ]
    const res = attributeChanges([pt('2025-02', -3322550, 100000)], trio)
    expect(res[0]!.components).toEqual([{ cause: 'uncovered_spending', amountMilli: -3322550, evidence: { residualMilli: -3322550 } }])
  })
})
