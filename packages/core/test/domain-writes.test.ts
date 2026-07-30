import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab } from '../src/domain.js'
import { UndoJournal } from '../src/undo-journal.js'
import { dollarsToMilli } from '../src/money.js'
import { YnabApiError } from '../src/client.js'

let journal: UndoJournal
beforeEach(() => { journal = new UndoJournal(join(mkdtempSync(join(tmpdir(), 'u-')), 'undo.json')) })

describe('targets and assignment', () => {
  it('updateCategory converts goal dollars and journals prior state', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: 'c1', name: 'Rent', hidden: false, goal_target: 1000000, goal_target_date: null, goal_frequency: null, goal_needs_whole_amount: null } }
      expect(opts.body.category.goal_target).toBe(1500000)
      return { category: { id: 'c1' } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateCategory('p1', 'c1', { goalTarget: 1500 })
    expect(journal.popLastCommitted()!.inverse[0]).toMatchObject({ kind: 'patch_category', patch: { goal_target: 1000000 } })
  })
  it('assignBudget journals the previous budgeted amount', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: 'c1', budgeted: 100000 } }
      expect(opts.body.category.budgeted).toBe(dollarsToMilli(250))
      return { category: { id: 'c1', budgeted: 250000 } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res = await y.assignBudget('p1', '2026-07-01', 'c1', 250)
    expect(res.assigned).toBe(250)
    expect(journal.popLastCommitted()!.inverse[0]).toMatchObject({ kind: 'assign_budget', budgetedMilli: 100000 })
  })
  it('moveMoney rolls back the first PATCH if the second fails', async () => {
    const calls: any[] = []
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: path.includes('c-from') ? 'c-from' : 'c-to', budgeted: 500000 } }
      calls.push({ path, body: opts.body })
      if (path.includes('c-to') && calls.length === 2) throw new Error('boom')
      return { category: {} }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await expect(y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 100)).rejects.toThrow(/boom.*rolled back|rolled back.*boom/s)
    // 3rd PATCH restores c-from to 500000
    expect(calls[2]!.path).toContain('c-from')
    expect(calls[2]!.body.category.budgeted).toBe(500000)
  })
  it('assignBudget records reason in the journal description and echoes it', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: 'c1', budgeted: 100000 } }
      expect(JSON.stringify(opts.body)).not.toContain('cover Jul float') // never sent to YNAB
      return { category: { id: 'c1', budgeted: 250000 } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res: any = await y.assignBudget('p1', '2026-07-01', 'c1', 250, '[suite] cover Jul float: payment reversal $3,322.55')
    expect(res.reason).toBe('[suite] cover Jul float: payment reversal $3,322.55')
    expect(journal.popLastCommitted()!.description).toMatch(/reason: \[suite\] cover Jul float/)
  })
  it('moveMoney records reason in the journal description and echoes it', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: path.includes('c-from') ? 'c-from' : 'c-to', budgeted: 500000 } }
      expect(JSON.stringify(opts.body)).not.toContain('rebalance float') // never sent to YNAB
      return { category: {} }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const res: any = await y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 100, '[suite] rebalance float between cards')
    expect(res.reason).toBe('[suite] rebalance float between cards')
    expect(journal.popLastCommitted()!.description).toMatch(/reason: \[suite\] rebalance float/)
  })
})

describe('undoLast', () => {
  it('replays inverse ops and reports, without journaling the undo', async () => {
    const client = { request: vi.fn(async () => ({ transaction_ids: [] })) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const id = journal.begin('create 2 transaction(s)', [{ kind: 'delete_transactions', planId: 'p1', ids: ['a', 'b'] }])
    journal.commit(id)
    const res: any = await y.undoLast()
    expect(res.undone).toBe('create 2 transaction(s)')
    expect(client.request).toHaveBeenCalledWith('/plans/p1/transactions/a', { method: 'DELETE' })
    expect(journal.size()).toBe(0)
  })
  it('reports empty journal gracefully', async () => {
    const y = new Ynab({ client: { request: vi.fn() } as any, journal, allowWrites: true })
    const res: any = await y.undoLast()
    expect(res.undone).toBeNull()
  })
  it('re-journals the entry for retry when an inverse op fails', async () => {
    const client = { request: vi.fn(async () => { throw new Error('network down') }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const id = journal.begin('delete scheduled sched1', [{ kind: 'delete_scheduled', planId: 'p1', id: 'sched1' }])
    journal.commit(id)
    await expect(y.undoLast()).rejects.toThrow(/failed.*retry|retry.*failed/is)
    const entry = journal.popLastCommitted()
    expect(entry).toBeDefined()
    expect(entry!.description).toBe('delete scheduled sched1')
    expect(entry!.inverse[0]).toMatchObject({ kind: 'delete_scheduled', id: 'sched1' })
  })
  it('tolerates already-deleted ids (404) in delete_transactions replay and continues the loop', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/a')) throw new YnabApiError(404, '404.2', 'not found')
      expect(opts.method).toBe('DELETE')
      return {}
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const id = journal.begin('delete 3 transaction(s)', [{ kind: 'delete_transactions', planId: 'p1', ids: ['a', 'b', 'c'] }])
    journal.commit(id)
    const res: any = await y.undoLast()
    expect(res.undone).toBe('delete 3 transaction(s)')
    expect(res.actions).toBe(2)
    expect(journal.size()).toBe(0)
  })
})

describe('updateScheduled', () => {
  it('journals the full writable snapshot even for a memo-only change', async () => {
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (!opts?.method) return { scheduled_transaction: { id: 's1', account_id: 'a1', date_next: '2026-08-01', amount: -5000, frequency: 'monthly', payee_id: 'pay1', category_id: 'c1', memo: 'old memo', flag_color: null } }
      return { scheduled_transaction: { id: 's1' } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.updateScheduled('p1', 's1', { memo: 'new memo' })
    const entry = journal.popLastCommitted()
    expect(entry!.inverse[0]).toMatchObject({
      kind: 'patch_scheduled',
      patch: { account_id: 'a1', date: '2026-08-01', amount: -5000, frequency: 'monthly', payee_id: 'pay1', category_id: 'c1', memo: 'old memo', flag_color: null },
    })
  })
})

describe('non-undoable writes', () => {
  it('createPayee journals a committed, not-undoable marker with an empty inverse', async () => {
    const client = { request: vi.fn(async () => ({ payee: { id: 'p1', name: 'Landlord' } })) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.createPayee('plan1', 'Landlord')
    const entry = journal.popLastCommitted()!
    expect(entry.undoable).toBe(false)
    expect(entry.inverse).toEqual([])
    expect(entry.description).toMatch(/Landlord/)
    expect(entry.description).toMatch(/not undoable/i)
  })
  it('undoLast on a not-undoable entry returns the cannot-undo message without calling the client, then reaches the prior entry', async () => {
    const client = { request: vi.fn(async () => ({ payee: { id: 'p1', name: 'Landlord' } })) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    const priorId = journal.begin('rename payee Bob → Alice', [{ kind: 'rename_payee', planId: 'plan1', payeeId: 'p0', name: 'Bob' }])
    journal.commit(priorId)
    await y.createPayee('plan1', 'Landlord')
    client.request.mockClear()

    const res: any = await y.undoLast()
    expect(res.undone).toBeNull()
    expect(res.message).toMatch(/cannot undo/i)
    expect(res.message).toMatch(/undo_last again/i)
    expect(client.request).not.toHaveBeenCalled()

    const res2: any = await y.undoLast()
    expect(res2.undone).toBe('rename payee Bob → Alice')
    expect(client.request).toHaveBeenCalledWith('/plans/plan1/payees/p0', { method: 'PATCH', body: { payee: { name: 'Bob' } } })
  })
  it('createCategory, createAccount, and importTransactions also journal not-undoable markers', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/categories')) return { category: { id: 'c1', name: 'Fun' } }
      if (path.endsWith('/accounts')) return { account: { id: 'a1' } }
      if (path.endsWith('/transactions/import')) return { transaction_ids: ['t1', 't2'] }
      return {}
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.createCategory('plan1', { name: 'Fun', groupId: 'g1' })
    expect(journal.popLastCommitted()!.undoable).toBe(false)
    await y.createAccount('plan1', { name: 'New Checking', type: 'checking', balance: 0 })
    expect(journal.popLastCommitted()!.undoable).toBe(false)
    await y.importTransactions('plan1')
    expect(journal.popLastCommitted()!.undoable).toBe(false)
  })
})

describe('undoLast cache invalidation', () => {
  it('invalidates the cache for every distinct planId touched by the executed inverse ops', async () => {
    const client = { request: vi.fn(async () => ({})) } as any
    const cache = { invalidate: vi.fn() } as any
    const y = new Ynab({ client, cache, journal, allowWrites: true })
    const id = journal.begin('rename payee', [
      { kind: 'rename_payee', planId: 'plan1', payeeId: 'p0', name: 'Bob' },
      { kind: 'assign_budget', planId: 'plan2', month: '2026-07-01', categoryId: 'c1', budgetedMilli: 1000 },
    ])
    journal.commit(id)
    await y.undoLast()
    expect(cache.invalidate).toHaveBeenCalledWith('plan1')
    expect(cache.invalidate).toHaveBeenCalledWith('plan2')
    expect(cache.invalidate).toHaveBeenCalledTimes(2)
  })
})

describe('deleteScheduled', () => {
  it('carries payee_name and flag_color into the restore inverse, not just payee_id', async () => {
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (opts?.method === 'DELETE') return {}
      return { scheduled_transaction: {
        id: 's1', account_id: 'a1', date_next: '2026-08-01', amount: -5000, frequency: 'monthly',
        payee_id: 'pay1', payee_name: 'Landlord', category_id: 'c1', memo: 'rent', flag_color: 'red',
      } }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await y.deleteScheduled('p1', 's1', { confirm: true })
    const inverse: any = journal.popLastCommitted()!.inverse[0]
    expect(inverse.kind).toBe('restore_scheduled')
    expect(inverse.scheduled).toMatchObject({ payee_name: 'Landlord', flag_color: 'red' })
  })
})

describe('createScheduled', () => {
  it('journals before the POST (journal-first) and leaves the entry uncommitted on failure', async () => {
    const client = { request: vi.fn(async () => { throw new Error('boom') }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await expect(y.createScheduled('p1', { accountId: 'a1', date: '2026-07-01', amount: -10, frequency: 'monthly' })).rejects.toThrow('boom')
    expect(journal.size()).toBe(1)
    expect(journal.popLastCommitted()).toBeUndefined()
  })
})

describe('moveMoney double failure', () => {
  it('reports both failures and preserves the journal entry when the rollback PATCH also fails', async () => {
    let patchCalls = 0
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (!opts?.method) return { category: { id: path.includes('c-from') ? 'c-from' : 'c-to', budgeted: 500000 } }
      patchCalls++
      if (patchCalls === 2) throw new Error('to-patch failed')
      if (patchCalls === 3) throw new Error('rollback failed')
      return { category: {} }
    }) } as any
    const y = new Ynab({ client, journal, allowWrites: true })
    await expect(y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 100)).rejects.toThrow(/half-applied.*undo_last|undo_last.*half-applied/is)
    const entry = journal.popLastCommitted()
    expect(entry).toBeDefined()
    expect(entry!.inverse).toHaveLength(2)
    expect(entry!.inverse[0]).toMatchObject({ kind: 'assign_budget' })
    expect(entry!.inverse[1]).toMatchObject({ kind: 'assign_budget' })
  })
})
