import type { Txn, CategorySnapshot } from './types.js'
import { aggregateTxns } from './filters.js'

const r2 = (n: number) => Math.round(n * 100) / 100

export function spendingSummary(txns: Txn[], opts: { by: 'category' | 'payee'; compareTxns?: Txn[] }) {
  const cur = aggregateTxns(txns, opts.by)
  if (!opts.compareTxns) return cur
  const prev = new Map(aggregateTxns(opts.compareTxns, opts.by).map((x) => [x.key, x.total]))
  return cur.map((row) => {
    const prevTotal = prev.get(row.key)
    return {
      ...row, prevTotal,
      changePct: prevTotal === undefined || prevTotal === 0 ? null : r2(((Math.abs(row.total) - Math.abs(prevTotal)) / Math.abs(prevTotal)) * 100),
    }
  })
}

export function budgetHealth(input: { readyToAssign: number; categories: CategorySnapshot[]; accounts: { name: string; type: string; balance: number }[] }) {
  const visible = input.categories.filter((c) => !c.hidden)
  return {
    readyToAssign: input.readyToAssign,
    overspent: visible.filter((c) => c.available < 0).map((c) => ({ name: c.name, available: c.available })),
    underfunded: visible.filter((c) => (c.goalUnderFunded ?? 0) > 0).map((c) => ({ name: c.name, goalUnderFunded: c.goalUnderFunded! })),
    creditCardStatus: input.accounts
      .filter((a) => a.type === 'creditCard' && a.balance < 0)
      .map((a) => {
        const pay = visible.find((c) => c.name === a.name)
        const paymentAvailable = pay?.available ?? 0
        return { account: a.name, owed: a.balance, paymentAvailable, covered: paymentAvailable >= -a.balance }
      }),
  }
}

const DAY = 86_400_000
function cadenceOf(gaps: number[]): 'weekly' | 'monthly' | 'yearly' | null {
  const med = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!
  if (med >= 5 && med <= 9) return 'weekly'
  if (med >= 26 && med <= 35) return 'monthly'
  if (med >= 350 && med <= 380) return 'yearly'
  return null
}

export function detectRecurring(txns: Txn[]) {
  const byPayee = new Map<string, Txn[]>()
  for (const t of txns) {
    if (!t.payeeName || t.amount >= 0 || t.transferAccountId) continue
    byPayee.set(t.payeeName, [...(byPayee.get(t.payeeName) ?? []), t])
  }
  const out: { payee: string; cadence: 'weekly' | 'monthly' | 'yearly'; lastAmount: number; lastDate: string; occurrences: number; amountChanged: boolean }[] = []
  for (const [payee, list] of byPayee) {
    if (list.length < 3) continue
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date))
    const gaps = sorted.slice(1).map((t, i) => (Date.parse(t.date) - Date.parse(sorted[i]!.date)) / DAY)
    const cadence = cadenceOf(gaps)
    if (!cadence) continue
    const last = sorted[sorted.length - 1]!
    out.push({ payee, cadence, lastAmount: last.amount, lastDate: last.date, occurrences: sorted.length, amountChanged: Math.abs(last.amount - sorted[0]!.amount) > 0.005 })
  }
  return out.sort((a, b) => a.lastAmount - b.lastAmount)
}

export function incomeVsExpense(txns: Txn[], todayIso: string) {
  const months = new Map<string, { income: number; expense: number }>()
  for (const t of txns) {
    const m = t.date.slice(0, 7)
    const g = months.get(m) ?? { income: 0, expense: 0 }
    if (t.amount >= 0) g.income = r2(g.income + t.amount)
    else g.expense = r2(g.expense + t.amount)
    months.set(m, g)
  }
  const currentMonth = todayIso.slice(0, 7)
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, income: v.income, expense: v.expense, net: r2(v.income + v.expense), partial: month === currentMonth }))
}

export function netWorthHistory(txns: Txn[]) {
  const monthly = new Map<string, number>()
  for (const t of txns) {
    const m = t.date.slice(0, 7)
    monthly.set(m, r2((monthly.get(m) ?? 0) + t.amount))
  }
  let acc = 0
  return [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, delta]) => {
    acc = r2(acc + delta)
    return { month, netWorth: acc }
  })
}
