import { describe, it, expect } from 'vitest'
import { asOfBalances, findBlockers, type RawAccount, type RawTxn } from '../src/month-close.js'

const acct = (o: Partial<RawAccount> = {}): RawAccount => ({
  id: 'a1', name: 'Citi Card', type: 'creditCard', on_budget: true, closed: false, deleted: false,
  balance: -3291760, cleared_balance: -3100000, ...o,
})
const txn = (o: Partial<RawTxn> = {}): RawTxn => ({
  id: Math.random().toString(36).slice(2), date: '2026-07-15', amount: -10000, cleared: 'cleared',
  approved: true, account_id: 'a1', payee_name: 'P', category_id: 'c1', transfer_account_id: null,
  deleted: false, ...o,
})

describe('asOfBalances', () => {
  it('backs post-cutoff transactions out of current balances', () => {
    const txns = [
      txn({ date: '2026-08-02', amount: -50000 }),                       // after cutoff, cleared
      txn({ date: '2026-08-03', amount: -25000, cleared: 'uncleared' }), // after cutoff, uncleared
      txn({ date: '2026-07-30', amount: -99000 }),                       // before cutoff — irrelevant
    ]
    const m = asOfBalances([acct()], txns, '2026-07-31')
    // working backs out ALL post-cutoff: -3291760 - (-75000) = -3216760
    // cleared backs out only cleared post-cutoff: -3100000 - (-50000) = -3050000
    expect(m.get('a1')).toEqual({ workingMilli: -3216760, clearedMilli: -3050000 })
  })
  it('sums parent amounts only (splits do not double-count) and skips deleted', () => {
    const split = txn({ date: '2026-08-01', amount: -30000, subtransactions: [
      { id: 's1', amount: -10000, category_id: 'c1', transfer_account_id: null, deleted: false },
      { id: 's2', amount: -20000, category_id: 'c2', transfer_account_id: null, deleted: false },
    ] })
    const dead = txn({ date: '2026-08-01', amount: -999000, deleted: true })
    const m = asOfBalances([acct()], [split, dead], '2026-07-31')
    expect(m.get('a1')!.workingMilli).toBe(-3291760 + 30000)
  })
  it('reconciled counts as cleared for the cleared back-out', () => {
    const m = asOfBalances([acct()], [txn({ date: '2026-08-01', amount: -7000, cleared: 'reconciled' })], '2026-07-31')
    expect(m.get('a1')!.clearedMilli).toBe(-3100000 + 7000)
  })
})

describe('findBlockers', () => {
  const onBudget = new Set(['a1'])
  it('flags unapproved, uncleared, and uncategorized before cutoff; ignores after-cutoff rows', () => {
    const txns = [
      txn({ id: 'u1', approved: false }),
      txn({ id: 'u2', cleared: 'uncleared' }),
      txn({ id: 'u3', category_id: null }),
      txn({ id: 'after', date: '2026-08-05', approved: false, cleared: 'uncleared', category_id: null }),
    ]
    const b = findBlockers(txns, '2026-07-31', onBudget)
    expect(b.unapproved.map((t) => t.id)).toEqual(['u1'])
    expect(b.unclearedBeforeCutoff.map((t) => t.id)).toEqual(['u2'])
    expect(b.uncategorized.map((t) => t.id)).toEqual(['u3'])
  })
  it('transfers are never uncategorized; a split with one uncategorized leg is; tracking accounts are skipped', () => {
    const transfer = txn({ id: 'tr', category_id: null, transfer_account_id: 'other' })
    const badSplit = txn({ id: 'sp', category_id: null, subtransactions: [
      { id: 's1', amount: -5000, category_id: 'c1', transfer_account_id: null, deleted: false },
      { id: 's2', amount: -5000, category_id: null, transfer_account_id: null, deleted: false },
    ] })
    const okSplitDeadLeg = txn({ id: 'ok', category_id: null, subtransactions: [
      { id: 's3', amount: -5000, category_id: 'c1', transfer_account_id: null, deleted: false },
      { id: 's4', amount: -5000, category_id: null, transfer_account_id: null, deleted: true },
    ] })
    const tracking = txn({ id: 'tk', account_id: 'a9', category_id: null })
    const b = findBlockers([transfer, badSplit, okSplitDeadLeg, tracking], '2026-07-31', new Set(['a1']))
    expect(b.uncategorized.map((t) => t.id)).toEqual(['sp'])
  })
})
