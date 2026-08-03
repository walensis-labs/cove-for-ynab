import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ynab, RateLimiter, LedgerStore } from '@walensis/cove-core'
import { buildServer } from '../src/server.js'
import { resolveEnv, WRITE_DISABLED_HINT } from '../src/env.js'
import { tools, buildServer as buildServerFromIndex } from '../src/index.js'

async function connect(ynab: Ynab) {
  const server = buildServer(ynab, new RateLimiter())
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

// backfill_ledger now only writes records for fully-elapsed months (IMPORTANT 1) — tests that need "a
// month backfill_ledger will actually write" compute one relative to the real clock instead of
// hardcoding a calendar month, which would eventually become "the current month" and start failing.
function lastCompleteMonthUTC(): string {
  const d = new Date()
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
}
function lastDayOfIso(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

describe('server', () => {
  it('registers exactly 35 tools', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false }))
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(35)
    expect(tools.map((t) => t.name)).toContain('list_transactions')
  })
  it('record_month_close persists and get_month_close_ledger reads it back', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json')
    const ledger = new LedgerStore(path)
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false, ledger }))
    const recordRes: any = await client.callTool({ name: 'record_month_close', arguments: {
      plan_id: 'p1', cutoff: '2026-07-31', gap_status: 'final',
      per_card: [{ account: 'Citi', working_as_of: -3241.76, cleared_as_of: -3241.76, available_at_month_end: 2662.65, gap: -579.11 }],
      blockers: { unapproved: 0, uncategorized: 0, uncleared_before_cutoff: 0 },
    } })
    expect(recordRes.isError).toBeUndefined()
    const readRes: any = await client.callTool({ name: 'get_month_close_ledger', arguments: {} })
    expect(readRes.isError).toBeUndefined()
    const body = JSON.parse(readRes.content[0].text)
    expect(body.records).toHaveLength(1)
    expect(body.records[0].cutoff).toBe('2026-07-31')
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
    expect(body.points).toEqual([{ month: '2026-07', owed: 100, available: 100, gap: 0, changed: false, gapChange: 0, direction: 'flat' }])
    expect(body.skippedMonths).toEqual([])
  })
  it('backfill_ledger writes backfill records and returns the discovery summary', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json')
    const ledger = new LedgerStore(path)
    const month = lastCompleteMonthUTC()
    const fake = { request: vi.fn(async (path: string) => {
      if (path.includes('/categories/')) { expect(path).toMatch(/\/categories\/pay-cat$/); return { category: { id: 'pay-cat', name: 'Visa', budgeted: 0, activity: 0, balance: 0 } } }
      if (path.endsWith('/accounts/card-acct')) return { account: { id: 'card-acct', name: 'Visa', balance: -100000 } }
      if (path.endsWith('/accounts/card-acct/transactions')) return { transactions: [] }
      throw new Error(`unmocked ${path}`)
    }) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false, ledger }))
    const res: any = await client.callTool({ name: 'backfill_ledger', arguments: { plan_id: 'p1', payment_category_id: 'pay-cat', card_account_id: 'card-acct', since_month: month, until_month: month } })
    expect(res.isError).toBeUndefined()
    const body = JSON.parse(res.content[0].text)
    expect(body.account).toBe('Visa')
    expect(body.monthsWritten).toBe(1)
    expect(ledger.list({ kind: 'backfill' })).toHaveLength(1)
    expect(ledger.list({ kind: 'backfill' })[0]!.cutoff).toBe(lastDayOfIso(month))
  })
  it('get_month_close_ledger passes kind through to the server call (IMPORTANT 2)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json')
    const ledger = new LedgerStore(path)
    ledger.append({ planId: 'p1', cutoff: '2026-07-31', gapStatus: 'final', perCard: [{ account: 'Visa', workingAsOf: -100, clearedAsOf: -100, availableAtMonthEnd: 100, gap: 0 }], blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 } })
    ledger.replaceBackfill('p1', 'Visa', [{ planId: 'p1', cutoff: '2026-06-30', gapStatus: 'final', perCard: [{ account: 'Visa', workingAsOf: -50, clearedAsOf: -50, availableAtMonthEnd: 50, gap: 0 }], blockers: { unapproved: 0, uncategorized: 0, unclearedBeforeCutoff: 0 } }])
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false, ledger }))

    const closeRes: any = await client.callTool({ name: 'get_month_close_ledger', arguments: { kind: 'close' } })
    const closeBody = JSON.parse(closeRes.content[0].text)
    expect(closeBody.records).toHaveLength(1)
    expect(closeBody.records[0].cutoff).toBe('2026-07-31')

    const backfillRes: any = await client.callTool({ name: 'get_month_close_ledger', arguments: { kind: 'backfill' } })
    const backfillBody = JSON.parse(backfillRes.content[0].text)
    expect(backfillBody.records).toHaveLength(1)
    expect(backfillBody.records[0].cutoff).toBe('2026-06-30')
  })
  it('read tool returns JSON content', async () => {
    const fake = { request: vi.fn(async () => ({ plans: [{ id: 'p1', name: 'Fam', last_modified_on: 'x', currency_format: { iso_code: 'USD' } }] })) } as any
    const client = await connect(new Ynab({ client: fake, allowWrites: false }))
    const res: any = await client.callTool({ name: 'list_plans', arguments: {} })
    expect(JSON.parse(res.content[0].text)[0].id).toBe('p1')
  })
  it('write tool refuses politely without YNAB_ALLOW_WRITES', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false, writeDisabledHint: WRITE_DISABLED_HINT }))
    const res: any = await client.callTool({ name: 'create_transactions', arguments: { plan_id: 'p1', transactions: [{ account_id: 'a', date: '2026-07-01', amount: -1 }] } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/YNAB_ALLOW_WRITES=1/)
  })
  it('exposes the month-close-session prompt', async () => {
    const client = await connect(new Ynab({ client: { request: vi.fn() } as any, allowWrites: false }))
    const prompts = await client.listPrompts()
    expect(prompts.prompts.map((p) => p.name)).toContain('month-close-session')
    const got = await client.getPrompt({ name: 'month-close-session', arguments: { cutoff: '2026-08-31' } })
    const text = (got.messages[0]!.content as any).text as string
    expect(text).toContain('Cutoff: 2026-08-31')
    expect(text).toContain('PROVISIONAL until blockers')
    expect(text).toContain('never auto-approve')
    expect(text).toContain('record_month_close')
  })
})

// Task 1 (Phase 1b worker substrate): apps/mcp gains a library entrypoint (src/index.ts) so a worker or
// self-hosted embedder can import the tool table + buildServer + playbook directly, without going through
// the bin/CLI. This just proves the entrypoint re-exports the right things — CLI behavior is unchanged.
describe('library entrypoint (src/index.ts)', () => {
  it('re-exports the 35-tool table and buildServer', () => {
    expect(tools).toHaveLength(35)
    expect(typeof buildServerFromIndex).toBe('function')
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
