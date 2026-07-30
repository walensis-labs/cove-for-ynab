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
  const [y, m] = month.split('-').map(Number) as [number, number]
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const end = new Date(Date.parse(monthEnd) + 30 * DAY).toISOString().slice(0, 10)
  return txns.filter((t) => !t.deleted && t.date >= start && t.date <= end)
}

const byDate = (a: CardTxn, b: CardTxn) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)

/** Earliest txn in `pool` dated within [lo, hi] inclusive, else the earliest overall. Assumes `pool` sorted ascending. */
function pickBetweenOrEarliest(pool: CardTxn[], lo: string, hi: string): CardTxn {
  const between = pool.filter((t) => t.date >= lo && t.date <= hi)
  return (between[0] ?? pool[0])!
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
      // reversal sets: equal-|amount| groups where remaining ≈ −k·amount for k ∈ {1, −1};
      // subset evidence (2 same-sign + 1 opposite-sign, opposite chosen by between-dates rule)
      // ignores same-|amount| bystander txns rather than zeroing the whole group's net.
      const groups = new Map<number, CardTxn[]>()
      for (const t of win) {
        const key = Math.abs(t.amount)
        groups.set(key, [...(groups.get(key) ?? []), t])
      }
      let matched = false
      for (const [absAmount, members] of groups) {
        if (absAmount === 0) continue
        const k = Math.round(-remaining / absAmount)
        if (k !== 1 && k !== -1) continue
        // leftover gate: reject matches whose post-reversal leftover is neither negligible nor
        // exactly the prior red the absorption stage would claim next — closes the ~2/3x–2x
        // false-positive band where an unrelated same-|amount| trio "explains" an unrelated gap.
        const leftover = remaining + k * absAmount
        const prevForGate = i > 0 ? points[i - 1] : undefined
        const leftoverOk = near(leftover, 0) || (prevForGate !== undefined && prevForGate.availableMilli < 0 && near(leftover, -prevForGate.availableMilli))
        if (!leftoverOk) continue
        const positives = members.filter((t) => t.amount > 0).sort(byDate)
        const negatives = members.filter((t) => t.amount < 0).sort(byDate)
        let evidence: CardTxn[]
        if (k === 1) {
          if (positives.length < 2 || negatives.length < 1) continue
          const [p1, p2] = positives as [CardTxn, CardTxn]
          const chosenNeg = pickBetweenOrEarliest(negatives, p1.date, p2.date)
          evidence = [p1, p2, chosenNeg]
        } else {
          if (negatives.length < 2 || positives.length < 1) continue
          const [n1, n2] = negatives as [CardTxn, CardTxn]
          const chosenPos = pickBetweenOrEarliest(positives, n1.date, n2.date)
          evidence = [n1, n2, chosenPos]
        }
        components.push({ cause: 'payment_reversal', amountMilli: -(k * absAmount), evidence: { txns: evidence.map((t) => ({ id: t.id, date: t.date, amountMilli: t.amount })) } })
        remaining += k * absAmount
        matched = true
        break
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
