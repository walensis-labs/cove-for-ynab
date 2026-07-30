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

export const CC_GROUP = 'Credit Card Payments'
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const isLive = (c: RawMonthCat) => !c.hidden && !c.deleted && !c.internal

export function matchCards(accounts: RawAccount[], monthCats: RawMonthCat[]) {
  const livePayCats = monthCats.filter((c) => !c.deleted && c.category_group_name === CC_GROUP)

  // Detect normalized-name collisions
  const nameCount = new Map<string, number>()
  for (const c of livePayCats) {
    const key = norm(c.name)
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1)
  }

  // Build map, skipping ambiguous names
  const ambiguousNames = new Set<string>()
  const payCats = new Map<string, RawMonthCat>()
  for (const c of livePayCats) {
    const key = norm(c.name)
    if (nameCount.get(key)! > 1) {
      ambiguousNames.add(key)
    } else {
      payCats.set(key, c)
    }
  }

  const matches: { account: RawAccount; category: RawMonthCat }[] = []
  const warnings: string[] = []

  // Emit warnings for ambiguous names
  for (const ambigName of ambiguousNames) {
    warnings.push(`Multiple payment categories normalize to "${ambigName}" in Credit Card Payments — matching is ambiguous; affected card(s) are NOT covered by this report.`)
  }

  // Match accounts
  for (const a of accounts) {
    if (a.closed || a.deleted || a.type !== 'creditCard') continue
    const category = payCats.get(norm(a.name))
    if (category) matches.push({ account: a, category })
    else warnings.push(`No payment category found for credit card account "${a.name}" — it is NOT covered by this report.`)
  }
  return { matches, warnings }
}

export function findRedCategories(monthCats: RawMonthCat[]): RawMonthCat[] {
  return monthCats.filter((c) => isLive(c) && c.category_group_name !== CC_GROUP && c.balance < 0)
}

export function rankDonors(monthCats: RawMonthCat[], excludeIds: Set<string>) {
  return monthCats
    .filter((c) => isLive(c) && c.category_group_name !== CC_GROUP && c.balance > 0 && !excludeIds.has(c.id))
    .map((cat) => ({ cat, excessMilli: cat.goal_type != null ? cat.balance - (cat.goal_target ?? 0) : cat.balance }))
    .filter((d) => d.excessMilli > 0)
    .sort((a, b) => b.excessMilli - a.excessMilli)
}
