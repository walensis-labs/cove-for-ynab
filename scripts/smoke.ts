import { Ynab, YnabClient, DeltaCache, RateLimiter } from '@walensis/mcp-for-ynab-core'

const token = process.env.YNAB_ACCESS_TOKEN?.trim()
if (!token) { console.error('Set YNAB_ACCESS_TOKEN to run the smoke test.'); process.exit(1) }
const y = new Ynab({ client: new YnabClient({ token, limiter: new RateLimiter() }), cache: new DeltaCache(), allowWrites: false })

const plans = await y.listPlans()
console.log(`plans: ${plans.map((p) => `${p.name} (${p.currency})`).join(', ')}`)
const planId = plans[0]!.id
const overview = await y.getPlanOverview(planId)
console.log(`RTA: ${overview.month.readyToAssign} | accounts: ${overview.accounts.length} | age of money: ${overview.month.ageOfMoney}`)
const txns: any = await y.listTransactions(planId, { limit: 5 })
console.log(`recent txns (${txns.total} in window): ${txns.transactions.map((t: any) => `${t.date} ${t.payeeName} ${t.amount}`).join(' | ')}`)
const agg: any = await y.listTransactions(planId, { aggregate: 'category' })
console.log(`top category outflow: ${agg.aggregate[0]?.key} ${agg.aggregate[0]?.total}`)
console.log('smoke: OK (read-only)')
