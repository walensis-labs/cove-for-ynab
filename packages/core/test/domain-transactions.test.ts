import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab, ConfirmationRequiredError, WriteDisabledError, mapTxn } from '../src/domain.js'
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

// Truthful Tool Output, Task 1: the production incident this pins — the model was shown a bare
// `-1000` next to a raw milliunit `-1000000` in importId and "corrected" a correct −$1,000.00 read
// down to −$1.00 and −$10.00 across a conversation. `amountText` removes the ambiguity: the model
// quotes the formatted string instead of re-deriving units from a bare number.
describe('mapTxn amountText (truthful output)', () => {
  it('the exact production case: raw -1000000 milliunits renders amount -1000 with amountText -$1,000.00', () => {
    const t = mapTxn(apiTxn({ amount: -1000000 }))
    expect(t.amount).toBe(-1000)
    expect(t.amountText).toBe('-$1,000.00')
  })
  it('the boundary the model got wrong: raw -1000 milliunits renders amount -1 with amountText -$1.00 (not -$0.01, not -$1,000.00)', () => {
    const t = mapTxn(apiTxn({ amount: -1000 }))
    expect(t.amount).toBe(-1)
    expect(t.amountText).toBe('-$1.00')
    expect(t.amountText).not.toBe('-$0.01')
    expect(t.amountText).not.toBe('-$1,000.00')
  })
  it('zero renders $0.00', () => {
    const t = mapTxn(apiTxn({ amount: 0 }))
    expect(t.amount).toBe(0)
    expect(t.amountText).toBe('$0.00')
  })
  it('positive amounts render without a leading minus', () => {
    const t = mapTxn(apiTxn({ amount: 250000 }))
    expect(t.amount).toBe(250)
    expect(t.amountText).toBe('$250.00')
  })
  it('subtransactions each carry their own amountText', () => {
    const t = mapTxn(apiTxn({
      amount: -75000,
      subtransactions: [
        { amount: -50000, category_name: 'Groceries', memo: null, deleted: false },
        { amount: -25000, category_name: 'Fun', memo: null, deleted: false },
      ],
    }))
    expect(t.subtransactions).toEqual([
      { amount: -50, amountText: '-$50.00', categoryName: 'Groceries', memo: null },
      { amount: -25, amountText: '-$25.00', categoryName: 'Fun', memo: null },
    ])
  })
})

describe('listTransactions', () => {
  it('states the effective 1-year window and paginates', async () => {
    const client = { request: vi.fn(async () => ({ transactions: [apiTxn(), apiTxn({ id: 't2', amount: -1000 })], server_knowledge: 5 })) } as any
    const y = new Ynab({ client, allowWrites: false })
    const res: any = await y.listTransactions('p1', { limit: 1, offset: 0 })
    expect(res.effectiveWindow.note).toMatch(/defaults to the last 365 days/)
    expect(res.total).toBe(2)
    expect(res.transactions).toHaveLength(1)
    expect(res.transactions[0].amount).toBe(-45.5)
    expect(res.transactions[0].amountText).toBe('-$45.50')
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
      { key: 'Groceries', total: -45.5, totalText: '-$45.50', count: 1 },
      { key: 'Fun', total: -2, totalText: '-$2.00', count: 1 },
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
    // Prior values now come from ONE bulk read (`/plans/{id}/transactions`, no id suffix), not a
    // per-row GET — see the "batched" describe block below for the request-count assertion.
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (!opts?.method) return { transactions: [apiTxn({ approved: false })] }
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateTransactions('p1', [{ id: 't1', approved: true }])
    const entry = journal.popLastCommitted()!
    expect(entry.inverse[0]).toMatchObject({ kind: 'patch_transactions', updates: [{ id: 't1', approved: false }] })
  })
  it('finds a transaction ~14 months old (older than YNAB\'s server-side 1-year since_date default) via one batched read carrying an explicit far-past since_date', async () => {
    // YNAB API changelog v1.85.0: listing endpoints default since_date to one year ago when the query
    // param is omitted. The per-row GET updateTransactions used to make (`/plans/{id}/transactions/{id}`)
    // had no date window at all, so the batched replacement must pass since_date explicitly or it
    // silently drops rows older than ~1 year.
    const oldTxn = apiTxn({ id: 'old1', date: daysAgo(420), category_name: 'Groceries' })
    const requests: any[] = []
    const client = { request: vi.fn(async (path: string, opts: any) => {
      requests.push({ path, opts })
      if (!opts?.method) return { transactions: [oldTxn] }
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res: any = await y.updateTransactions('p1', [{ id: 'old1', categoryId: 'c-new' }])
    // Found and its prior category shows up in the inverse text — proves the batched read didn't
    // silently drop this row for being outside a default 1-year window.
    expect(res.inverse).toMatch(/category back to Groceries/)
    // Exactly one bulk read (not one per row), and it must carry an explicit far-past since_date.
    const reads = requests.filter((r) => !r.opts?.method)
    expect(reads).toHaveLength(1)
    expect(reads[0].opts?.query?.since_date).toBe('2000-01-01')
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
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (!opts?.method) return { transactions: [priorTxn] }
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
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (!opts?.method) return { transactions: [priorTxn] }
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateTransactions('p1', [{ id: 't1', amount: -45.5 }])
    const entry = journal.popLastCommitted()!
    expect(entry.inverse).toEqual([{ kind: 'patch_transactions', planId: 'p1', updates: [{ id: 't1', amount: -50000 }] }])
  })
})
