import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface MonthCloseRecord {
  id: string; recordedAt: string
  planId: string; cutoff: string; gapStatus: 'provisional' | 'final'
  // *Text companions are additive and optional: records written before Truthful Tool Output Task 1
  // (or supplied by a caller that hasn't picked up the new core version) won't carry them.
  perCard: {
    account: string
    workingAsOf: number; workingAsOfText?: string
    clearedAsOf: number; clearedAsOfText?: string
    availableAtMonthEnd: number; availableAtMonthEndText?: string
    gap: number; gapText?: string
  }[]
  blockers: { unapproved: number; uncategorized: number; unclearedBeforeCutoff: number }
  causes?: { month: string; change: number; changeText?: string; cause: string; narrative?: string }[]
  moves?: { from: string; to: string; amount: number; amountText?: string; source: 'category' | 'rta'; reason?: string }[]
  buffer?: number; note?: string
  kind?: 'close' | 'backfill' // absent = 'close' (pre-Phase-1a records predate this field)
}

export interface LedgerLike {
  append(record: Omit<MonthCloseRecord, 'id' | 'recordedAt'>): MonthCloseRecord | Promise<MonthCloseRecord>
  list(opts?: { limit?: number; cutoff?: string; kind?: 'close' | 'backfill' }): MonthCloseRecord[] | Promise<MonthCloseRecord[]>
  replaceBackfill(planId: string, account: string, records: Omit<MonthCloseRecord, 'id' | 'recordedAt'>[]): MonthCloseRecord[] | Promise<MonthCloseRecord[]>
}

export class LedgerStore implements LedgerLike {
  #records: MonthCloseRecord[] = []
  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try { this.#records = (JSON.parse(readFileSync(filePath, 'utf8')).records ?? []) as MonthCloseRecord[] } catch { this.#records = [] }
    }
  }
  #flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify({ records: this.#records }, null, 2))
  }
  append(record: Omit<MonthCloseRecord, 'id' | 'recordedAt'>): MonthCloseRecord {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.cutoff)) throw new Error('cutoff must be an ISO date (YYYY-MM-DD)')
    if (!record.perCard || record.perCard.length === 0) throw new Error('perCard must contain at least one card')
    const full: MonthCloseRecord = { ...record, kind: record.kind ?? 'close', id: randomUUID(), recordedAt: new Date().toISOString() }
    this.#records.push(full)
    this.#flush()
    return full
  }
  /** Removes every kind==='backfill' record for this planId+account, then appends `records` (each forced kind:'backfill'). Real 'close' records are never touched. */
  replaceBackfill(planId: string, account: string, records: Omit<MonthCloseRecord, 'id' | 'recordedAt'>[]): MonthCloseRecord[] {
    this.#records = this.#records.filter((r) => !(r.kind === 'backfill' && r.planId === planId && r.perCard[0]?.account === account))
    this.#flush()
    return records.map((r) => this.append({ ...r, kind: 'backfill' }))
  }
  list(opts?: { limit?: number; cutoff?: string; kind?: 'close' | 'backfill' }): MonthCloseRecord[] {
    // Append-only ⇒ reversed insertion order IS newest-first — immune to same-millisecond recordedAt ties.
    let results = [...this.#records].reverse()
    if (opts?.cutoff) results = results.filter((r) => r.cutoff === opts.cutoff)
    if (opts?.kind) results = results.filter((r) => (r.kind ?? 'close') === opts.kind)
    if (opts?.limit != null) results = results.slice(0, opts.limit)
    return results
  }
}
