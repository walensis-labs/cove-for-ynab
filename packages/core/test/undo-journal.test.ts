import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UndoJournal } from '../src/undo-journal.js'

let path: string
beforeEach(() => { path = join(mkdtempSync(join(tmpdir(), 'undo-')), 'undo.json') })

describe('UndoJournal', () => {
  it('journal-first: begin persists before commit', () => {
    const j = new UndoJournal(path)
    const id = j.begin('delete txn t1', [{ kind: 'restore_transactions', planId: 'p', transactions: [{ id: 't1' }] }])
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.entries[0].committed).toBe(false)
    j.commit(id)
    expect(JSON.parse(readFileSync(path, 'utf8')).entries[0].committed).toBe(true)
  })
  it('pops only committed entries, newest first, and persists removal', () => {
    const j = new UndoJournal(path)
    const a = j.begin('a', []); j.commit(a)
    j.begin('b-uncommitted', [])
    const c = j.begin('c', []); j.commit(c)
    expect(j.popLastCommitted()!.description).toBe('c')
    expect(j.popLastCommitted()!.description).toBe('a')
    expect(j.popLastCommitted()).toBeUndefined()
  })
  it('survives reload from disk and caps at 50', () => {
    const j = new UndoJournal(path)
    for (let i = 0; i < 55; i++) { const id = j.begin(`e${i}`, []); j.commit(id) }
    const j2 = new UndoJournal(path)
    expect(j2.size()).toBe(50)
    expect(j2.popLastCommitted()!.description).toBe('e54')
  })
  it('setInverse replaces inverse before commit', () => {
    const j = new UndoJournal(path)
    const id = j.begin('create', [])
    j.setInverse(id, [{ kind: 'delete_transactions', planId: 'p', ids: ['n1'] }])
    j.commit(id)
    expect(j.popLastCommitted()!.inverse).toHaveLength(1)
  })
})
