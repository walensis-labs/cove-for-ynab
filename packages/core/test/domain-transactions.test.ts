import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab, ConfirmationRequiredError, WriteDisabledError } from '../src/domain.js'
import { UndoJournal } from '../src/undo-journal.js'

/**
 * Dates here MUST be relative to today, never hardcoded. `listTransactions` applies a default
 * 365-day window (`defaultSince()`), so a fixture with a literal date silently falls out of that
 * window once real time passes it and the test starts failing with no code change. That is not
 * hypothetical: this file hardcoded '2025-08-01' as its oldest transaction and began failing on
 * 2026-08-01, exactly 365 days later.
 */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

const apiTxn = (o: any = {}) => ({
  id: 't1', date: daysAgo(20), amount: -45500, payee_name: 'Kroger', payee_id: 'pay1', category_name: 'Groceries',
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
  it('returns newest-first by default and oldest-first with sort: date_asc', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [
      apiTxn({ id: 'old', date: daysAgo(300) }),
      apiTxn({ id: 'mid', date: daysAgo(150) }),
      apiTxn({ id: 'new', date: daysAgo(10) }),
    ] })) } as any
    const y = new Ynab({ client, allowWrites: false })
    const desc: any = await y.listTransactions('p1', {})
    expect(desc.transactions.map((t: any) => t.id)).toEqual(['new', 'mid', 'old'])
    const asc: any = await y.listTransactions('p1', { sort: 'date_asc' })
    expect(asc.transactions.map((t: any) => t.id)).toEqual(['old', 'mid', 'new'])
    const page: any = await y.listTransactions('p1', { limit: 1 })
    expect(page.transactions[0].id).toBe('new')
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
  it('fields accepts snake_case names and never drops requested keys', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [apiTxn({ transfer_account_id: null })] })) } as any
    const y = new Ynab({ client, allowWrites: false })
    const res: any = await y.listTransactions('p1', { fields: ['payee_name', 'transfer_account_id', 'amount'] as any })
    expect(res.transactions[0]).toEqual({ payee_name: 'Kroger', transfer_account_id: null, amount: -45.5 })
    expect(JSON.stringify(res.transactions[0])).toContain('transfer_account_id')
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
  it('delete of a split transaction restores its subtransactions, not a single uncategorized row', async () => {
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (opts?.method === 'DELETE') return {}
      return { transaction: apiTxn({
        category_id: null,
        subtransactions: [
          { id: 'sub1', amount: -20000, category_id: 'c-groceries', memo: 'half', payee_id: 'pay1', deleted: false },
          { id: 'sub2', amount: -25500, category_id: 'c-fun', memo: null, payee_id: null, deleted: false },
          { id: 'sub3', amount: -1000, category_id: 'c-gone', memo: null, payee_id: null, deleted: true },
        ],
      }) }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.deleteTransaction('p1', 't1', { confirm: true })
    const inverse: any = journal.popLastCommitted()!.inverse[0]
    expect(inverse.kind).toBe('restore_transactions')
    expect(inverse.transactions[0].category_id).toBeNull()
    expect(inverse.transactions[0].subtransactions).toEqual([
      { amount: -20000, category_id: 'c-groceries', memo: 'half', payee_id: 'pay1' },
      { amount: -25500, category_id: 'c-fun', memo: null, payee_id: null },
    ])
  })
})

describe('updateTransactions undo fidelity', () => {
  it('inverse is API wire form (snake_case, milliunits) and ignores undefined keys — the way the MCP tool layer passes them', async () => {
    const priorTxn = apiTxn({ category_id: 'c-old', approved: false })
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/transactions/t1') && !opts?.method) return { transaction: priorTxn }
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    // Mirrors the MCP tool layer: every key present, most explicitly undefined.
    await y.updateTransactions('p1', [{
      id: 't1', date: undefined, amount: undefined, payeeId: undefined, payeeName: undefined,
      categoryId: 'c-new', memo: undefined, cleared: undefined, approved: true, flagColor: undefined,
    }])
    const entry = journal.popLastCommitted()!
    expect(entry.inverse).toEqual([{ kind: 'patch_transactions', planId: 'p1', updates: [{ id: 't1', category_id: 'c-old', approved: false }] }])

    // Replaying that inverse via undoLast must PATCH exactly this API-form body.
    const captured: any[] = []
    const replayClient = { request: vi.fn(async (path: string, opts: any) => { captured.push({ path, opts }); return {} }) } as any
    const replayJournal = new UndoJournal(join(mkdtempSync(join(tmpdir(), 'u-')), 'undo.json'))
    const rid = replayJournal.begin(entry.description, entry.inverse)
    replayJournal.commit(rid)
    const y2 = new Ynab({ client: replayClient, journal: replayJournal, allowWrites: true })
    await y2.undoLast()
    expect(captured[0].path).toBe('/plans/p1/transactions')
    expect(captured[0].opts).toMatchObject({ method: 'PATCH', body: { transactions: [{ id: 't1', category_id: 'c-old', approved: false }] } })
  })
  it('carries the prior amount in MILLIUNITS when amount was updated', async () => {
    const priorTxn = apiTxn({ amount: -50000 })
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/transactions/t1') && !opts?.method) return { transaction: priorTxn }
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateTransactions('p1', [{ id: 't1', amount: -45.5 }])
    const entry = journal.popLastCommitted()!
    expect(entry.inverse).toEqual([{ kind: 'patch_transactions', planId: 'p1', updates: [{ id: 't1', amount: -50000 }] }])
  })
})
