import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface MonthCloseRecord {
  id: string; recordedAt: string
  planId: string; cutoff: string; gapStatus: 'provisional' | 'final'
  perCard: { account: string; workingAsOf: number; clearedAsOf: number; availableAtMonthEnd: number; gap: number }[]
  blockers: { unapproved: number; uncategorized: number; unclearedBeforeCutoff: number }
  causes?: { month: string; change: number; cause: string; narrative?: string }[]
  moves?: { from: string; to: string; amount: number; source: 'category' | 'rta'; reason?: string }[]
  buffer?: number; note?: string
}

export class LedgerStore {
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
    const full: MonthCloseRecord = { ...record, id: randomUUID(), recordedAt: new Date().toISOString() }
    this.#records.push(full)
    this.#flush()
    return full
  }
  list(opts?: { limit?: number; cutoff?: string }): MonthCloseRecord[] {
    let results = [...this.#records].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    if (opts?.cutoff) results = results.filter((r) => r.cutoff === opts.cutoff)
    if (opts?.limit != null) results = results.slice(0, opts.limit)
    return results
  }
}
