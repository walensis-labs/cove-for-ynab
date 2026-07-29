import { describe, it, expect } from 'vitest'
import { applyFilters, aggregateTxns } from '../src/filters.js'
import type { Txn } from '../src/types.js'

const t = (o: Partial<Txn>): Txn => ({
  id: 'x', date: '2026-07-01', amount: -10, payeeName: 'P', payeeId: null, categoryName: 'C', categoryId: null,
  accountName: 'A', accountId: 'a1', memo: null, cleared: 'cleared', approved: true, flagColor: null,
  transferAccountId: null, importId: null, ...o,
})

describe('applyFilters', () => {
  it('filters by search across payee and memo, case-insensitive', () => {
    const txns = [t({ payeeName: 'Kroger' }), t({ memo: 'kroger run' }), t({ payeeName: 'Shell' })]
    expect(applyFilters(txns, { search: 'KROG' })).toHaveLength(2)
  })
  it('filters by amount range in dollars and uncleared/unapproved', () => {
    const txns = [t({ amount: -5 }), t({ amount: -50, cleared: 'uncleared' }), t({ amount: -500, approved: false })]
    expect(applyFilters(txns, { minAmount: -100, maxAmount: -20 })).toHaveLength(1)
    expect(applyFilters(txns, { unclearedOnly: true })).toHaveLength(1)
    expect(applyFilters(txns, { unapprovedOnly: true })).toHaveLength(1)
  })
  it('filters by date window', () => {
    const txns = [t({ date: '2026-01-15' }), t({ date: '2026-06-15' })]
    expect(applyFilters(txns, { sinceDate: '2026-06-01' })).toHaveLength(1)
    expect(applyFilters(txns, { untilDate: '2026-02-01' })).toHaveLength(1)
  })
})

describe('aggregateTxns', () => {
  it('groups and sums by category with counts, sorted most-negative first', () => {
    const txns = [t({ categoryName: 'Rent', amount: -1500 }), t({ categoryName: 'Dining', amount: -20 }), t({ categoryName: 'Dining', amount: -30 })]
    expect(aggregateTxns(txns, 'category')).toEqual([
      { key: 'Rent', total: -1500, count: 1 },
      { key: 'Dining', total: -50, count: 2 },
    ])
  })
  it('groups by month', () => {
    const txns = [t({ date: '2026-06-02', amount: -1 }), t({ date: '2026-06-20', amount: -2 }), t({ date: '2026-07-01', amount: -4 })]
    expect(aggregateTxns(txns, 'month')).toEqual([
      { key: '2026-06', total: -3, count: 2 },
      { key: '2026-07', total: -4, count: 1 },
    ])
  })
})
