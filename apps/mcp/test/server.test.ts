import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Ynab, RateLimiter } from '@walensis/mcp-for-ynab-core'
import { buildServer } from '../src/server.js'
import { resolveEnv } from '../src/env.js'

async function connect(ynab: Ynab) {
  const server = buildServer(ynab, new RateLimiter())
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

describe('server', () => {
  it('registers exactly 32 tools', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false }))
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(32)
    expect(tools.map((t) => t.name)).toContain('list_transactions')
  })
  it('month_close is registered read-only and returns the report', async () => {
    const fake = { request: vi.fn(async (path: string) => {
      if (path.endsWith('/accounts')) return { accounts: [] }
      if (path.endsWith('/transactions')) return { transactions: [] }
      return { month: { month: '2026-07-01', to_be_budgeted: 0, categories: [] } }
    }) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'month_close', arguments: { plan_id: 'p1', cutoff: '2026-07-31' } })
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(res.content[0].text).cutoff).toBe('2026-07-31')
  })
  it('get_category_history is registered and returns the series shape', async () => {
    const fake = { request: vi.fn(async () => ({ category: { id: 'c1', name: 'X', budgeted: 0, activity: 0, balance: 0 } })) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'get_category_history', arguments: { plan_id: 'p1', category_id: 'c1', since_month: '2026-06', until_month: '2026-07' } })
    expect(res.isError).toBeUndefined()
    const body = JSON.parse(res.content[0].text)
    expect(body.points).toHaveLength(2)
    expect(body.category.id).toBe('c1')
  })
  it('credit_card_float_history wires both ids to the right endpoints', async () => {
    const fake = { request: vi.fn(async (path: string) => {
      if (path.includes('/categories/')) { expect(path).toMatch(/\/categories\/pay-cat$/); return { category: { id: 'pay-cat', name: 'Visa', budgeted: 0, activity: 0, balance: 100000 } } }
      if (path.endsWith('/accounts/card-acct')) return { account: { id: 'card-acct', name: 'Visa', balance: -100000 } }
      if (path.endsWith('/accounts/card-acct/transactions')) return { transactions: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'credit_card_float_history', arguments: { plan_id: 'p1', payment_category_id: 'pay-cat', card_account_id: 'card-acct', since_month: '2026-07', until_month: '2026-07' } })
    expect(res.isError).toBeUndefined()
    const body = JSON.parse(res.content[0].text)
    expect(body.points).toEqual([{ month: '2026-07', owed: 100, available: 100, gap: 0, changed: false }])
    expect(body.skippedMonths).toEqual([])
  })
  it('read tool returns JSON content', async () => {
    const fake = { request: vi.fn(async () => ({ plans: [{ id: 'p1', name: 'Fam', last_modified_on: 'x', currency_format: { iso_code: 'USD' } }] })) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'list_plans', arguments: {} })
    expect(JSON.parse(res.content[0].text)[0].id).toBe('p1')
  })
  it('write tool refuses politely without YNAB_ALLOW_WRITES', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false }))
    const res: any = await client.callTool({ name: 'create_transactions', arguments: { plan_id: 'p1', transactions: [{ account_id: 'a', date: '2026-07-01', amount: -1 }] } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/YNAB_ALLOW_WRITES=1/)
  })
})

describe('resolveEnv', () => {
  it('reads token from env, file, and flags writes', () => {
    expect(resolveEnv({ YNAB_ACCESS_TOKEN: 'abc' })).toEqual({ token: 'abc', allowWrites: false })
    expect(resolveEnv({ YNAB_ACCESS_TOKEN_FILE: '/x', YNAB_ALLOW_WRITES: '1' }, () => ' filetok\n')).toEqual({ token: 'filetok', allowWrites: true })
    expect(() => resolveEnv({})).toThrow(/YNAB_ACCESS_TOKEN/)
  })
  it('throws a friendly error when the token file cannot be read', () => {
    expect(() => resolveEnv({ YNAB_ACCESS_TOKEN_FILE: '/nope' }, () => { throw new Error('ENOENT') }))
      .toThrow(/Could not read YNAB_ACCESS_TOKEN_FILE/)
  })
})
