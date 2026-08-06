import type { Txn } from './types.js'
import { formatDollars } from './money.js'

export const TXN_FIELD_ALIASES: Record<string, string> = {
  payee_name: 'payeeName', payee_id: 'payeeId', category_name: 'categoryName', category_id: 'categoryId',
  account_name: 'accountName', account_id: 'accountId', transfer_account_id: 'transferAccountId',
  import_id: 'importId', flag_color: 'flagColor',
}

export interface TxnFilters {
  accountId?: string; categoryId?: string; payeeId?: string
  sinceDate?: string; untilDate?: string
  unapprovedOnly?: boolean; unclearedOnly?: boolean
  search?: string
  minAmount?: number; maxAmount?: number
  flagColor?: string
}

export function applyFilters(txns: Txn[], f: TxnFilters): Txn[] {
  const needle = f.search?.toLowerCase()
  return txns.filter((t) => {
    if (f.accountId && t.accountId !== f.accountId) return false
    if (f.categoryId && t.categoryId !== f.categoryId) return false
    if (f.payeeId && t.payeeId !== f.payeeId) return false
    if (f.sinceDate && t.date < f.sinceDate) return false
    if (f.untilDate && t.date > f.untilDate) return false
    if (f.unapprovedOnly && t.approved) return false
    if (f.unclearedOnly && t.cleared !== 'uncleared') return false
    if (f.flagColor && t.flagColor !== f.flagColor) return false
    if (f.minAmount !== undefined && t.amount < f.minAmount) return false
    if (f.maxAmount !== undefined && t.amount > f.maxAmount) return false
    if (needle && !(t.payeeName?.toLowerCase().includes(needle) || t.memo?.toLowerCase().includes(needle))) return false
    return true
  })
}

export function aggregateTxns(txns: Txn[], by: 'category' | 'payee' | 'month'): { key: string; total: number; totalText: string; count: number }[] {
  const groups = new Map<string, { total: number; count: number }>()
  for (const t of txns) {
    const key = by === 'month' ? t.date.slice(0, 7) : (by === 'category' ? t.categoryName : t.payeeName) ?? '(none)'
    const g = groups.get(key) ?? { total: 0, count: 0 }
    g.total = Math.round((g.total + t.amount) * 1000) / 1000
    g.count++
    groups.set(key, g)
  }
  const rows = [...groups.entries()].map(([key, v]) => ({ key, total: v.total, totalText: formatDollars(v.total), count: v.count }))
  return by === 'month' ? rows.sort((a, b) => a.key.localeCompare(b.key)) : rows.sort((a, b) => a.total - b.total)
}
