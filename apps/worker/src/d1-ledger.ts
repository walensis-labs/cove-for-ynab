import type { D1Database } from '@cloudflare/workers-types'
import type { LedgerLike, MonthCloseRecord } from '@walensis/mcp-for-ynab-core'

type NewRecord = Omit<MonthCloseRecord, 'id' | 'recordedAt'>

/**
 * D1-backed LedgerLike for the worker. Stores the full record as JSON in `record`, with
 * plan_id/cutoff/kind/account extracted into indexed columns for filtering. `list` orders by
 * `rowid DESC` (insertion order) to match LedgerStore's append-only newest-first semantics.
 */
export class D1Ledger implements LedgerLike {
  constructor(private readonly db: D1Database) {}

  async append(record: NewRecord): Promise<MonthCloseRecord> {
    const full: MonthCloseRecord = {
      ...record,
      kind: record.kind ?? 'close',
      id: crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
    }
    const account = full.perCard[0]?.account ?? ''
    await this.db
      .prepare('INSERT INTO ledger_records (id, recorded_at, plan_id, cutoff, kind, account, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(full.id, full.recordedAt, full.planId, full.cutoff, full.kind, account, JSON.stringify(full))
      .run()
    return full
  }

  async list(opts?: { limit?: number; cutoff?: string; kind?: 'close' | 'backfill' }): Promise<MonthCloseRecord[]> {
    const clauses: string[] = []
    const params: unknown[] = []
    if (opts?.cutoff) { clauses.push('cutoff = ?'); params.push(opts.cutoff) }
    if (opts?.kind) { clauses.push('kind = ?'); params.push(opts.kind) }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    let sql = `SELECT record FROM ledger_records${where} ORDER BY rowid DESC`
    if (opts?.limit != null) { sql += ' LIMIT ?'; params.push(opts.limit) }
    const { results } = await this.db.prepare(sql).bind(...params).all<{ record: string }>()
    return results.map((row) => JSON.parse(row.record) as MonthCloseRecord)
  }

  /** Deletes existing kind='backfill' rows for planId+account, then inserts `records` (each forced kind:'backfill').
   *  Skips the DELETE entirely when `records` is empty — mirrors the call-site guard in core's backfillLedger,
   *  which never calls replaceBackfill with zero records, so a bare delete-with-nothing-to-replace never wipes history. */
  async replaceBackfill(planId: string, account: string, records: NewRecord[]): Promise<MonthCloseRecord[]> {
    if (records.length === 0) return []
    await this.db
      .prepare("DELETE FROM ledger_records WHERE plan_id = ? AND kind = 'backfill' AND account = ?")
      .bind(planId, account)
      .run()
    const written: MonthCloseRecord[] = []
    for (const r of records) written.push(await this.append({ ...r, kind: 'backfill' }))
    return written
  }
}
