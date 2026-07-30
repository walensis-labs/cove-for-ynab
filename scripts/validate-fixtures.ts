import { Ynab, YnabClient, RateLimiter } from '@walensis/mcp-for-ynab-core'

const token = process.env.YNAB_ACCESS_TOKEN?.trim()
if (!token) { console.error('Set YNAB_ACCESS_TOKEN.'); process.exit(1) }
const y = new Ynab({ client: new YnabClient({ token, limiter: new RateLimiter() }), allowWrites: false })

const EXPECT: Record<string, number> = {
  '2024-08': -865.75, '2024-09': -865.75, '2024-10': -865.75, '2024-11': -865.75,
  '2024-12': -865.75, '2025-01': -865.75, '2025-02': -865.75,
  '2025-03': -862.09, '2025-05': -854.77, '2025-12': -665.28,
  '2026-04': -3987.83, '2026-06': -2471.28, '2026-07': 0.0,
}
const res = await y.getCreditCardFloatHistory('last-used', {
  paymentCategoryId: 'b20cf9b7-0c98-4eaf-9256-59abc598cb11',
  cardAccountId: '1213c7f4-7499-4d72-8727-a968902d8755',
  sinceMonth: '2024-08', untilMonth: '2026-07',
})
let fail = 0
for (const [month, want] of Object.entries(EXPECT)) {
  const p = res.points.find((x) => x.month === month)
  const got = p?.gap
  const ok = got !== undefined && Math.abs(got - want) < 0.005
  console.log(`${ok ? 'PASS' : 'FAIL'} ${month}: gap ${got} (expected ${want})${p ? ` direction=${p.direction}` : ' [missing]'}`)
  if (!ok) fail++
}
console.log(fail === 0 ? 'ALL FIXTURES PASS' : `${fail} FIXTURE(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
