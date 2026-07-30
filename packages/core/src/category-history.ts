const MONTH_RE = /^\d{4}-\d{2}$/
const MAX_MONTHS = 60

export function monthRange(sinceMonth: string, untilMonth: string): string[] {
  if (!MONTH_RE.test(sinceMonth) || !MONTH_RE.test(untilMonth)) {
    throw new Error(`Months must be formatted YYYY-MM (got "${sinceMonth}" / "${untilMonth}").`)
  }
  if (sinceMonth > untilMonth) throw new Error(`since_month (${sinceMonth}) must be before or equal to until_month (${untilMonth}).`)
  const out: string[] = []
  const [sy, sm] = sinceMonth.split('-').map(Number) as [number, number]
  const [uy, um] = untilMonth.split('-').map(Number) as [number, number]
  let y = sy, m = sm
  while (y < uy || (y === uy && m <= um)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
    if (++m > 12) { m = 1; y++ }
  }
  if (out.length > MAX_MONTHS) {
    throw new Error(`Range spans ${out.length} months — the limit is 60 months (each month costs one API call against YNAB's 200/hour budget). Narrow the range.`)
  }
  return out
}

export interface FloatPoint { month: string; owedMilli: number; availableMilli: number; gapMilli: number; changed: boolean }

export function floatSeries(
  avail: { month: string; availableMilli: number }[],
  txns: { date: string; amount: number; deleted?: boolean }[],
  currentBalanceMilli: number,
): FloatPoint[] {
  const live = txns.filter((t) => !t.deleted)
  let prevGap: number | null = null
  return avail.map((p) => {
    const monthEnd = `${p.month}-31` // ISO string compare: safely "after this month" for all real dates
    const after = live.filter((t) => t.date > monthEnd).reduce((s, t) => s + t.amount, 0)
    const owedMilli = -(currentBalanceMilli - after)
    const gapMilli = p.availableMilli - owedMilli
    const changed = prevGap !== null && Math.abs(gapMilli - prevGap) > 5
    prevGap = gapMilli
    return { month: p.month, owedMilli, availableMilli: p.availableMilli, gapMilli, changed }
  })
}
