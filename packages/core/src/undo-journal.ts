import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type InverseOp =
  | { kind: 'delete_transactions'; planId: string; ids: string[] }
  | { kind: 'restore_transactions'; planId: string; transactions: Record<string, unknown>[] }
  | { kind: 'patch_transactions'; planId: string; updates: Record<string, unknown>[] }
  | { kind: 'patch_category'; planId: string; categoryId: string; patch: Record<string, unknown> }
  | { kind: 'assign_budget'; planId: string; month: string; categoryId: string; budgetedMilli: number }
  | { kind: 'delete_scheduled'; planId: string; id: string }
  | { kind: 'restore_scheduled'; planId: string; scheduled: Record<string, unknown> }
  | { kind: 'patch_scheduled'; planId: string; id: string; patch: Record<string, unknown> }
  | { kind: 'rename_payee'; planId: string; payeeId: string; name: string }

export interface UndoEntry { id: string; at: string; description: string; committed: boolean; inverse: InverseOp[] }

const CAP = 50

export class UndoJournal {
  #entries: UndoEntry[] = []
  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try { this.#entries = (JSON.parse(readFileSync(filePath, 'utf8')).entries ?? []) as UndoEntry[] } catch { this.#entries = [] }
    }
  }
  #flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify({ entries: this.#entries }, null, 2))
  }
  begin(description: string, inverse: InverseOp[]): string {
    const entry: UndoEntry = { id: randomUUID(), at: new Date().toISOString(), description, committed: false, inverse }
    this.#entries.push(entry)
    if (this.#entries.length > CAP) this.#entries.splice(0, this.#entries.length - CAP)
    this.#flush()
    return entry.id
  }
  commit(id: string): void {
    const e = this.#entries.find((x) => x.id === id)
    if (e) { e.committed = true; this.#flush() }
  }
  setInverse(id: string, inverse: InverseOp[]): void {
    const e = this.#entries.find((x) => x.id === id)
    if (e) { e.inverse = inverse; this.#flush() }
  }
  popLastCommitted(): UndoEntry | undefined {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i]!.committed) {
        const [entry] = this.#entries.splice(i, 1)
        this.#flush()
        return entry
      }
    }
    return undefined
  }
  size(): number { return this.#entries.length }
}
