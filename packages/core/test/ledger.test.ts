import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/ledger.js'

let path: string
beforeEach(() => { path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json') })
const rec = (cutoff = '2026-07-31') => ({
  planId: 'p1', cutoff, gapStatus: 'final' as const,
  perCard: [{ account: 'Citi', workingAsOf: -3241.76, clearedAsOf: -3241.76, availableAtMonthEnd: 2662.65, gap: -579.11 }],
  blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 },
  moves: [{ from: 'Dining Out', to: 'Kid Things', amount: 348.17, source: 'category' as const, reason: 'cover Jul float' }],
})
describe('LedgerStore', () => {
  it('appends with id+recordedAt, persists, survives reload, lists newest-first', () => {
    const s = new LedgerStore(path)
    const a = s.append(rec('2026-06-30'))
    const b = s.append(rec('2026-07-31'))
    expect(a.id).toBeTruthy(); expect(a.recordedAt).toMatch(/^\d{4}-/)
    const reloaded = new LedgerStore(path)
    expect(reloaded.list().map((r) => r.cutoff)).toEqual(['2026-07-31', '2026-06-30'])
    expect(reloaded.list({ cutoff: '2026-06-30' })).toHaveLength(1)
    expect(reloaded.list({ limit: 1 })[0]!.cutoff).toBe(b.cutoff)
  })
  it('returns the second of two back-to-back appends first, even with identical recordedAt', () => {
    const s = new LedgerStore(path)
    const a = s.append(rec('2026-05-31'))
    const b = s.append(rec('2026-05-31'))
    const listed = s.list()
    expect(listed[0]!.id).toBe(b.id)
    expect(listed[1]!.id).toBe(a.id)
  })
  it('validates cutoff and perCard', () => {
    const s = new LedgerStore(path)
    expect(() => s.append({ ...rec(), cutoff: 'July' })).toThrow(/ISO date/)
    expect(() => s.append({ ...rec(), perCard: [] })).toThrow(/perCard/)
  })
  it('tolerates a corrupt file', () => {
    writeFileSync(path, 'not json')
    expect(new LedgerStore(path).list()).toEqual([])
  })
})
