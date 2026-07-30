const EPS = 1000
const FLOOR = 10
const DAY = 86_400_000

export type GapCause = 'deliberate_cover' | 'payment_category_drain' | 'payment_reversal' | 'uncategorized_debt' | 'overpayment_absorption' | 'uncovered_spending' | 'unattributed'
export interface AttributionComponent { cause: GapCause; amountMilli: number; evidence: { assignedMilli?: number; priorRedMilli?: number; txns?: { id: string; date: string; amountMilli: number }[]; residualMilli?: number } }
export interface AttributedChange { month: string; gapChangeMilli: number; components: AttributionComponent[] }
export interface AttributionMonthInput { month: string; gapChangeMilli: number; availableMilli: number; assignedMilli: number }
interface CardTxn { id: string; date: string; amount: number; category_id: string | null; transfer_account_id: string | null; deleted?: boolean }

const near = (a: number, b: number) => Math.abs(a - b) <= EPS

function windowTxns(txns: CardTxn[], month: string): CardTxn[] {
  const start = new Date(Date.parse(`${month}-01`) - 30 * DAY).toISOString().slice(0, 10)
  const end = new Date(Date.parse(`${month}-28`) + 33 * DAY).toISOString().slice(0, 10)
  return txns.filter((t) => !t.deleted && t.date >= start && t.date <= end)
}

export function attributeChanges(points: AttributionMonthInput[], cardTxns: CardTxn[]): AttributedChange[] {
  const out: AttributedChange[] = []
  points.forEach((p, i) => {
    if (Math.abs(p.gapChangeMilli) <= FLOOR) return
    const components: AttributionComponent[] = []
    let remaining = p.gapChangeMilli

    if (p.assignedMilli > 0) {
      components.push({ cause: 'deliberate_cover', amountMilli: p.assignedMilli, evidence: { assignedMilli: p.assignedMilli } })
      remaining -= p.assignedMilli
    } else if (p.assignedMilli < 0) {
      components.push({ cause: 'payment_category_drain', amountMilli: p.assignedMilli, evidence: { assignedMilli: p.assignedMilli } })
      remaining -= p.assignedMilli
    }

    if (Math.abs(remaining) > FLOOR) {
      const win = windowTxns(cardTxns, p.month)
      // reversal sets: equal-|amount| groups whose net ≈ −remaining and |amount| ≈ |remaining|
      const groups = new Map<number, CardTxn[]>()
      for (const t of win) {
        const key = Math.abs(t.amount)
        groups.set(key, [...(groups.get(key) ?? []), t])
      }
      let matched = false
      for (const [absAmount, members] of groups) {
        if (members.length < 2 || !near(absAmount, Math.abs(remaining))) continue
        const net = members.reduce((s, t) => s + t.amount, 0)
        if (near(net, -remaining)) {
          components.push({ cause: 'payment_reversal', amountMilli: -net, evidence: { txns: members.map((t) => ({ id: t.id, date: t.date, amountMilli: t.amount })) } })
          remaining += net
          matched = true
          break
        }
      }
      if (!matched) {
        const debts = win.filter((t) => t.amount < 0 && t.category_id === null && t.transfer_account_id !== null)
        const sum = debts.reduce((s, t) => s + t.amount, 0)
        if (debts.length > 0 && near(sum, remaining)) {
          components.push({ cause: 'uncategorized_debt', amountMilli: sum, evidence: { txns: debts.map((t) => ({ id: t.id, date: t.date, amountMilli: t.amount })) } })
          remaining -= sum
        }
      }
    }

    if (Math.abs(remaining) > FLOOR && i > 0) {
      const prev = points[i - 1]!
      if (prev.availableMilli < 0 && near(remaining, -prev.availableMilli)) {
        components.push({ cause: 'overpayment_absorption', amountMilli: -prev.availableMilli, evidence: { priorRedMilli: prev.availableMilli } })
        remaining -= -prev.availableMilli
      }
    }

    if (remaining < -FLOOR) components.push({ cause: 'uncovered_spending', amountMilli: remaining, evidence: { residualMilli: remaining } })
    else if (remaining > FLOOR) components.push({ cause: 'unattributed', amountMilli: remaining, evidence: { residualMilli: remaining } })

    out.push({ month: p.month, gapChangeMilli: p.gapChangeMilli, components })
  })
  return out
}
