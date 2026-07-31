import { describe, it, expect, beforeEach } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'
import { D1Ledger } from '../src/d1-ledger.js'

interface Call { sql: string; args: unknown[] }

class FakeStatement {
  args: unknown[] = []
  constructor(private readonly sql: string, private readonly db: FakeD1Database) {}
  bind(...args: unknown[]) {
    this.args = args
    return this
  }
  async run() {
    this.db.calls.push({ sql: this.sql, args: this.args })
    return { success: true, meta: {} }
  }
  async all() {
    this.db.calls.push({ sql: this.sql, args: this.args })
    return { success: true, meta: {}, results: this.db.nextResults }
  }
}

class FakeD1Database {
  calls: Call[] = []
  nextResults: Array<{ record: string }> = []
  prepare(sql: string) {
    return new FakeStatement(sql, this)
  }
}

let db: FakeD1Database
beforeEach(() => { db = new FakeD1Database() })

const perCard = (account = 'Citi') => [{ account, workingAsOf: -100, clearedAsOf: -100, availableAtMonthEnd: 50, gap: -50 }]
const blockers = { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 }
const rec = (cutoff = '2026-07-31', account = 'Citi') => ({
  planId: 'p1', cutoff, gapStatus: 'final' as const, perCard: perCard(account), blockers,
})

describe('D1Ledger.append', () => {
  it('INSERTs with a stamped id and recordedAt, defaulting kind to close', async () => {
    const ledger = new D1Ledger(db as unknown as D1Database)
    const written = await ledger.append(rec())
    expect(written.id).toBeTruthy()
    expect(written.recordedAt).toMatch(/^\d{4}-/)
    expect(written.kind).toBe('close')
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0]!.sql).toMatch(/INSERT INTO ledger_records/)
    expect(db.calls[0]!.args).toEqual([
      written.id, written.recordedAt, 'p1', '2026-07-31', 'close', 'Citi', JSON.stringify(written),
    ])
  })
  it('honors an explicit backfill kind', async () => {
    const ledger = new D1Ledger(db as unknown as D1Database)
    const written = await ledger.append({ ...rec(), kind: 'backfill' })
    expect(written.kind).toBe('backfill')
    expect(db.calls[0]!.args[4]).toBe('backfill')
  })
})

describe('D1Ledger.list', () => {
  it('orders by rowid DESC with no filters', async () => {
    const ledger = new D1Ledger(db as unknown as D1Database)
    db.nextResults = []
    await ledger.list()
    expect(db.calls[0]!.sql).toMatch(/SELECT record FROM ledger_records ORDER BY rowid DESC/)
    expect(db.calls[0]!.args).toEqual([])
  })
  it('applies the kind filter and LIMIT in SQL, and parses stored JSON', async () => {
    const stored = { ...rec(), id: 'x1', recordedAt: '2026-07-31T00:00:00.000Z', kind: 'close' as const }
    db.nextResults = [{ record: JSON.stringify(stored) }]
    const ledger = new D1Ledger(db as unknown as D1Database)
    const results = await ledger.list({ kind: 'close', limit: 5 })
    expect(results).toEqual([stored])
    expect(db.calls[0]!.sql).toMatch(/WHERE kind = \?/)
    expect(db.calls[0]!.sql).toMatch(/ORDER BY rowid DESC/)
    expect(db.calls[0]!.sql).toMatch(/LIMIT \?/)
    expect(db.calls[0]!.args).toEqual(['close', 5])
  })
  it('applies the cutoff filter', async () => {
    const ledger = new D1Ledger(db as unknown as D1Database)
    await ledger.list({ cutoff: '2026-07-31' })
    expect(db.calls[0]!.sql).toMatch(/WHERE cutoff = \?/)
    expect(db.calls[0]!.args).toEqual(['2026-07-31'])
  })
})

describe('D1Ledger.replaceBackfill', () => {
  it('DELETEs matching backfill rows for plan+account, then INSERTs the new records', async () => {
    const ledger = new D1Ledger(db as unknown as D1Database)
    const written = await ledger.replaceBackfill('p1', 'Citi', [rec('2026-06-30'), rec('2026-05-31')])
    expect(db.calls[0]!.sql).toMatch(/DELETE FROM ledger_records/)
    expect(db.calls[0]!.sql).toMatch(/kind = 'backfill'/)
    expect(db.calls[0]!.args).toEqual(['p1', 'Citi'])
    expect(db.calls).toHaveLength(3) // 1 DELETE + 2 INSERTs
    expect(db.calls[1]!.sql).toMatch(/INSERT INTO ledger_records/)
    expect(db.calls[2]!.sql).toMatch(/INSERT INTO ledger_records/)
    expect(written).toHaveLength(2)
    expect(written.every((r) => r.kind === 'backfill')).toBe(true)
  })
  it('skips the DELETE entirely when records is empty (mirrors the core zero-month guard)', async () => {
    const ledger = new D1Ledger(db as unknown as D1Database)
    const written = await ledger.replaceBackfill('p1', 'Citi', [])
    expect(written).toEqual([])
    expect(db.calls).toHaveLength(0)
  })
})
