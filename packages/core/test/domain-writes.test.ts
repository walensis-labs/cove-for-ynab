import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab } from '../src/domain.js'
import { UndoJournal } from '../src/undo-journal.js'
import { dollarsToMilli } from '../src/money.js'

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
})
