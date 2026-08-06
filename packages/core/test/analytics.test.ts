import { describe, it, expect } from 'vitest'
import { spendingSummary, budgetHealth, detectRecurring, incomeVsExpense, netWorthHistory, monthWindowStart } from '../src/analytics.js'
import { formatDollars } from '../src/money.js'
import type { Txn, CategorySnapshot } from '../src/types.js'

const t = (o: Partial<Txn>): Txn => {
  const amount = o.amount ?? -10
  return {
    id: Math.random().toString(36).slice(2), date: '2026-07-01', amount, amountText: formatDollars(amount), payeeName: 'P', payeeId: null,
    categoryName: 'C', categoryId: null, accountName: 'A', accountId: 'a1', memo: null, cleared: 'cleared',
    approved: true, flagColor: null, transferAccountId: null, importId: null, ...o,
  }
}

const cat = (o: Partial<CategorySnapshot>): CategorySnapshot => {
  const assigned = o.assigned ?? 0, activity = o.activity ?? 0, available = o.available ?? 0
  const goalTarget = o.goalTarget ?? null, goalUnderFunded = o.goalUnderFunded ?? null
  return {
    id: '1', name: 'Cat', group: 'Group', hidden: false,
    assigned, assignedText: formatDollars(assigned), activity, activityText: formatDollars(activity),
    available, availableText: formatDollars(available),
    goalType: null, goalTarget, goalTargetText: goalTarget === null ? null : formatDollars(goalTarget),
    goalUnderFunded, goalUnderFundedText: goalUnderFunded === null ? null : formatDollars(goalUnderFunded),
    goalPercentageComplete: null, ...o,
  }
}

describe('spendingSummary', () => {
  it('compares against a previous period', () => {
    const cur = [t({ categoryName: 'Dining', amount: -100 })]
    const prev = [t({ categoryName: 'Dining', amount: -80 })]
    const [row] = spendingSummary(cur, { by: 'category', compareTxns: prev })
    expect(row).toMatchObject({ key: 'Dining', total: -100, totalText: '-$100.00', prevTotal: -80, prevTotalText: '-$80.00', changePct: 25 })
  })
})

describe('budgetHealth', () => {
  it('flags overspent, underfunded, and CC coverage', () => {
    const res = budgetHealth({
      readyToAssign: -50,
      categories: [
        cat({ id: '1', name: 'Dining', group: 'Fun', assigned: 100, activity: -160, available: -60 }),
        cat({ id: '2', name: 'Rent', group: 'Bills', goalType: 'NEED', goalTarget: 1500, goalUnderFunded: 1500, goalPercentageComplete: 0 }),
        cat({ id: '3', name: 'Visa', group: 'Credit Card Payments', available: 200 }),
      ],
      accounts: [{ name: 'Visa', type: 'creditCard', balance: -350 }],
    })
    expect(res.readyToAssignText).toBe('-$50.00')
    expect(res.overspent).toEqual([{ name: 'Dining', available: -60, availableText: '-$60.00' }])
    expect(res.underfunded).toEqual([{ name: 'Rent', goalUnderFunded: 1500, goalUnderFundedText: '$1,500.00' }])
    expect(res.creditCardStatus).toEqual([{ account: 'Visa', owed: -350, owedText: '-$350.00', paymentAvailable: 200, paymentAvailableText: '$200.00', covered: false }])
  })
})

describe('detectRecurring', () => {
  it('finds monthly cadence and amount changes', () => {
    const txns = ['2026-01-15', '2026-02-15', '2026-03-14', '2026-04-15'].map((date, i) =>
      t({ payeeName: 'Netflix', date, amount: i === 3 ? -18.99 : -15.99 }))
    const [r] = detectRecurring(txns)
    expect(r).toMatchObject({ payee: 'Netflix', cadence: 'monthly', lastAmount: -18.99, lastAmountText: '-$18.99', occurrences: 4, amountChanged: true })
  })
  it('ignores payees with fewer than 3 occurrences', () => {
    expect(detectRecurring([t({}), t({})])).toEqual([])
  })
})

describe('incomeVsExpense', () => {
  it('splits by sign, marks the current month partial', () => {
    const txns = [t({ date: '2026-06-01', amount: 3000 }), t({ date: '2026-06-05', amount: -1200 }), t({ date: '2026-07-02', amount: -100 })]
    expect(incomeVsExpense(txns, '2026-07-15')).toEqual([
      { month: '2026-06', income: 3000, incomeText: '$3,000.00', expense: -1200, expenseText: '-$1,200.00', net: 1800, netText: '$1,800.00', partial: false },
      { month: '2026-07', income: 0, incomeText: '$0.00', expense: -100, expenseText: '-$100.00', net: -100, netText: '-$100.00', partial: true },
    ])
  })
})

describe('monthWindowStart', () => {
  it('returns the 1st of the month (n-1) months before the current month', () => {
    expect(monthWindowStart('2026-07-15', 6)).toBe('2026-02-01')
  })
  it('wraps across a year boundary', () => {
    expect(monthWindowStart('2026-01-15', 6)).toBe('2025-08-01')
  })
  it('with months=1 the window starts at the 1st of the current month', () => {
    expect(monthWindowStart('2026-07-15', 1)).toBe('2026-07-01')
  })
})

describe('netWorthHistory', () => {
  it('cumulates month over month', () => {
    const txns = [t({ date: '2026-05-01', amount: 1000 }), t({ date: '2026-06-10', amount: -250 }), t({ date: '2026-06-11', amount: -250 })]
    expect(netWorthHistory(txns)).toEqual([
      { month: '2026-05', netWorth: 1000, netWorthText: '$1,000.00' },
      { month: '2026-06', netWorth: 500, netWorthText: '$500.00' },
    ])
  })
})
