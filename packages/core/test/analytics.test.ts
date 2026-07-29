import { describe, it, expect } from 'vitest'
import { spendingSummary, budgetHealth, detectRecurring, incomeVsExpense, netWorthHistory } from '../src/analytics.js'
import type { Txn } from '../src/types.js'

const t = (o: Partial<Txn>): Txn => ({
  id: Math.random().toString(36).slice(2), date: '2026-07-01', amount: -10, payeeName: 'P', payeeId: null,
  categoryName: 'C', categoryId: null, accountName: 'A', accountId: 'a1', memo: null, cleared: 'cleared',
  approved: true, flagColor: null, transferAccountId: null, importId: null, ...o,
})

describe('spendingSummary', () => {
  it('compares against a previous period', () => {
    const cur = [t({ categoryName: 'Dining', amount: -100 })]
    const prev = [t({ categoryName: 'Dining', amount: -80 })]
    const [row] = spendingSummary(cur, { by: 'category', compareTxns: prev })
    expect(row).toMatchObject({ key: 'Dining', total: -100, prevTotal: -80, changePct: 25 })
  })
})

describe('budgetHealth', () => {
  it('flags overspent, underfunded, and CC coverage', () => {
    const res = budgetHealth({
      readyToAssign: -50,
      categories: [
        { id: '1', name: 'Dining', group: 'Fun', hidden: false, assigned: 100, activity: -160, available: -60, goalType: null, goalTarget: null, goalUnderFunded: null, goalPercentageComplete: null },
        { id: '2', name: 'Rent', group: 'Bills', hidden: false, assigned: 0, activity: 0, available: 0, goalType: 'NEED', goalTarget: 1500, goalUnderFunded: 1500, goalPercentageComplete: 0 },
        { id: '3', name: 'Visa', group: 'Credit Card Payments', hidden: false, assigned: 0, activity: 0, available: 200, goalType: null, goalTarget: null, goalUnderFunded: null, goalPercentageComplete: null },
      ],
      accounts: [{ name: 'Visa', type: 'creditCard', balance: -350 }],
    })
    expect(res.overspent).toEqual([{ name: 'Dining', available: -60 }])
    expect(res.underfunded).toEqual([{ name: 'Rent', goalUnderFunded: 1500 }])
    expect(res.creditCardStatus).toEqual([{ account: 'Visa', owed: -350, paymentAvailable: 200, covered: false }])
  })
})

describe('detectRecurring', () => {
  it('finds monthly cadence and amount changes', () => {
    const txns = ['2026-01-15', '2026-02-15', '2026-03-14', '2026-04-15'].map((date, i) =>
      t({ payeeName: 'Netflix', date, amount: i === 3 ? -18.99 : -15.99 }))
    const [r] = detectRecurring(txns)
    expect(r).toMatchObject({ payee: 'Netflix', cadence: 'monthly', lastAmount: -18.99, occurrences: 4, amountChanged: true })
  })
  it('ignores payees with fewer than 3 occurrences', () => {
    expect(detectRecurring([t({}), t({})])).toEqual([])
  })
})

describe('incomeVsExpense', () => {
  it('splits by sign, marks the current month partial', () => {
    const txns = [t({ date: '2026-06-01', amount: 3000 }), t({ date: '2026-06-05', amount: -1200 }), t({ date: '2026-07-02', amount: -100 })]
    expect(incomeVsExpense(txns, '2026-07-15')).toEqual([
      { month: '2026-06', income: 3000, expense: -1200, net: 1800, partial: false },
      { month: '2026-07', income: 0, expense: -100, net: -100, partial: true },
    ])
  })
})

describe('netWorthHistory', () => {
  it('cumulates month over month', () => {
    const txns = [t({ date: '2026-05-01', amount: 1000 }), t({ date: '2026-06-10', amount: -250 }), t({ date: '2026-06-11', amount: -250 })]
    expect(netWorthHistory(txns)).toEqual([
      { month: '2026-05', netWorth: 1000 },
      { month: '2026-06', netWorth: 500 },
    ])
  })
})
