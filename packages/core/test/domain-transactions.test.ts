import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab, ConfirmationRequiredError, WriteDisabledError } from '../src/domain.js'
import { UndoJournal } from '../src/undo-journal.js'

const apiTxn = (o: any = {}) => ({
  id: 't1', date: '2026-07-10', amount: -45500, payee_name: 'Kroger', payee_id: 'pay1', category_name: 'Groceries',
  category_id: 'c1', account_name: 'Checking', account_id: 'a1', memo: null, cleared: 'cleared', approved: true,
  flag_color: null, transfer_account_id: null, import_id: null, deleted: false, subtransactions: [], ...o,
})

let journal: UndoJournal
beforeEach(() => { journal = new UndoJournal(join(mkdtempSync(join(tmpdir(), 'u-')), 'undo.json')) })

describe('listTransactions', () => {
  it('states the effective 1-year window and paginates', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [apiTxn(), apiTxn({ id: 't2', amount: -1000 })], server_knowledge: 5 })) } as any
    const y = new Ynab({ client, allowWrites: false })
    const res: any = await y.listTransactions('p1', { limit: 1, offset: 0 })
    expect(res.effectiveWindow.note).toMatch(/defaults to the last 365 days/)
    expect(res.total).toBe(2)
    expect(res.transactions).toHaveLength(1)
    expect(res.transactions[0].amount).toBe(-45.5)
  })
  it('uses the category sub-endpoint when only categoryId is set', async () => {
    const client = { request: vi.fn(async (path: string) => { expect(path).toBe('/plans/p1/categories/c9/transactions'); return { transactions: [] } }) } as any
    await new Ynab({ client, allowWrites: false }).listTransactions('p1', { categoryId: 'c9' })
  })
  it('aggregate mode returns sums not rows', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [apiTxn(), apiTxn({ id: 't2', category_name: 'Fun', amount: -2000 })] })) } as any
    const res: any = await new Ynab({ client, allowWrites: false }).listTransactions('p1', { aggregate: 'category' })
    expect(res.aggregate).toEqual([
      { key: 'Groceries', total: -45.5, count: 1 },
      { key: 'Fun', total: -2, count: 1 },
    ])
    expect(res.transactions).toBeUndefined()
  })
})

describe('writes', () => {
  it('refuses when allowWrites is false', async () => {
    const y = new Ynab({ client: { request: vi.fn() } as any, allowWrites: false })
    await expect(y.createTransactions('p1', [{ accountId: 'a1', date: '2026-07-01', amount: -5 }])).rejects.toThrow(WriteDisabledError)
  })
  it('creates transactions converting dollars to milliunits, journal-first', async () => {
    const client = { request: vi.fn(async (_p: string, opts: any) => {
      expect(opts.body.transactions[0].amount).toBe(-5250)
      return { transaction_ids: ['n1'], transactions: [apiTxn({ id: 'n1', amount: -5250 })] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res = await y.createTransactions('p1', [{ accountId: 'a1', date: '2026-07-01', amount: -5.25, payeeName: 'Cafe' }])
    expect(res).toEqual({ created: 1, ids: ['n1'] })
    expect(journal.popLastCommitted()!.inverse[0]).toMatchObject({ kind: 'delete_transactions', ids: ['n1'] })
  })
  it('bulk update >5 rows demands confirm + expectedCount', async () => {
    const y = new Ynab({ client: { request: vi.fn() } as any, journal, allowWrites: true })
    const updates = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, approved: true }))
    await expect(y.updateTransactions('p1', updates)).rejects.toThrow(ConfirmationRequiredError)
    await expect(y.updateTransactions('p1', updates, { confirm: true, expectedCount: 5 })).rejects.toThrow(/expected_count/)
  })
  it('bulk update journals prior state for undo', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/transactions/t1') && !opts?.method) return { transaction: apiTxn({ approved: false }) }
      return { transactions: [apiTxn({ approved: true })] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateTransactions('p1', [{ id: 't1', approved: true }])
    const entry = journal.popLastCommitted()!
    expect(entry.inverse[0]).toMatchObject({ kind: 'patch_transactions', updates: [{ id: 't1', approved: false }] })
  })
  it('delete requires confirm and journals the full transaction for restore', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (opts?.method === 'DELETE') return { transaction: apiTxn() }
      return { transaction: apiTxn() }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await expect(y.deleteTransaction('p1', 't1')).rejects.toThrow(ConfirmationRequiredError)
    await y.deleteTransaction('p1', 't1', { confirm: true })
    expect(journal.popLastCommitted()!.inverse[0]!.kind).toBe('restore_transactions')
  })
})
