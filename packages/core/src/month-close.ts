export interface RawAccount { id: string; name: string; type: string; on_budget: boolean; closed: boolean; deleted: boolean; balance: number; cleared_balance: number }
export interface RawSub { id: string; amount: number; category_id: string | null; transfer_account_id: string | null; deleted: boolean }
export interface RawTxn { id: string; date: string; amount: number; cleared: 'cleared' | 'uncleared' | 'reconciled'; approved: boolean; account_id: string; account_name?: string; payee_name?: string | null; category_id: string | null; transfer_account_id: string | null; deleted: boolean; subtransactions?: RawSub[] }
export interface RawMonthCat { id: string; name: string; category_group_name?: string; hidden: boolean; deleted: boolean; internal?: boolean; balance: number; goal_type?: string | null; goal_target?: number | null }

const isCleared = (t: RawTxn) => t.cleared === 'cleared' || t.cleared === 'reconciled'

export function asOfBalances(accounts: RawAccount[], txns: RawTxn[], cutoff: string): Map<string, { workingMilli: number; clearedMilli: number }> {
  const out = new Map(accounts.map((a) => [a.id, { workingMilli: a.balance, clearedMilli: a.cleared_balance }]))
  for (const t of txns) {
    if (t.deleted || t.date <= cutoff) continue
    const entry = out.get(t.account_id)
    if (!entry) continue
    entry.workingMilli -= t.amount
    if (isCleared(t)) entry.clearedMilli -= t.amount
  }
  return out
}

export function findBlockers(txns: RawTxn[], cutoff: string, onBudgetIds: Set<string>) {
  const unapproved: RawTxn[] = []
  const uncategorized: RawTxn[] = []
  const unclearedBeforeCutoff: RawTxn[] = []
  for (const t of txns) {
    if (t.deleted || t.date > cutoff || !onBudgetIds.has(t.account_id)) continue
    if (!t.approved) unapproved.push(t)
    if (t.cleared === 'uncleared') unclearedBeforeCutoff.push(t)
    const liveSubs = (t.subtransactions ?? []).filter((s) => !s.deleted)
    const parentUncat = t.category_id === null && t.transfer_account_id === null && liveSubs.length === 0
    const subUncat = liveSubs.some((s) => s.category_id === null && s.transfer_account_id === null)
    if (parentUncat || subUncat) uncategorized.push(t)
  }
  return { unapproved, uncategorized, unclearedBeforeCutoff }
}
