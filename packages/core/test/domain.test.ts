import { describe, it, expect, vi } from 'vitest'
import { Ynab, WriteDisabledError, ConfirmationRequiredError } from '../src/domain.js'

// Currency-symbol threading (fix/currency-symbol): every *Text-emitting Ynab method now resolves the
// plan's real currency format via one `GET /plans/{plan_id}/settings` fetch before formatting — an
// unresolvable symbol renders currency-neutral rather than defaulting to "$", so a client mock that
// doesn't handle the settings endpoint would otherwise strip the "$" this file's fixtures assert. This
// is a resolvable USD format so those historical assertions stay unchanged.
const PLAN_SETTINGS_USD = { settings: { currency_format: { iso_code: 'USD', currency_symbol: '$', decimal_digits: 2, symbol_first: true, decimal_separator: '.', group_separator: ',', display_symbol: true } } }

describe('WriteDisabledError', () => {
  it('default message names no environment variable', () => {
    const err = new WriteDisabledError()
    expect(err.message).not.toContain('ALLOW_WRITES')
    // No SCREAMING_SNAKE_CASE token anywhere in the message — that's the shape of every env var
    // this library's three hosts use (YNAB_ALLOW_WRITES, WORKER_ALLOW_WRITES, ...). A library can't
    // know its deployment context, so the default must not name any of them.
    expect(err.message).not.toMatch(/[A-Z]+_[A-Z]+/)
  })

  it('a supplied hint appears in the message', () => {
    const err = new WriteDisabledError('Ask your administrator to enable writes for this workspace.')
    expect(err.message).toContain('Ask your administrator to enable writes for this workspace.')
  })

  // Pins the concatenation contract exactly (not by substring) — a hint that repeats the constructor's
  // own "Writes are disabled on this server." lead-in produces a doubled sentence that substring
  // assertions above would not catch. See apps/mcp/src/env.ts's WRITE_DISABLED_HINT for the host-side
  // rule this contract implies: hints must NOT include their own "Writes are disabled" lead-in.
  it('exact rendered message with no hint', () => {
    const err = new WriteDisabledError()
    expect(err.message).toBe('Writes are disabled on this server.')
  })

  it('exact rendered message with a supplied hint', () => {
    const err = new WriteDisabledError('Ask your administrator to enable writes for this workspace.')
    expect(err.message).toBe('Writes are disabled on this server. Ask your administrator to enable writes for this workspace.')
  })
})

describe('Ynab writeDisabledHint wiring', () => {
  it('assertWrites (via a write call) includes the configured hint in the thrown error', async () => {
    const client = { request: vi.fn() } as any
    const y = new Ynab({ client, allowWrites: false, writeDisabledHint: 'Set FOO_BAR=1 to enable.' })
    await expect(y.createPayee('p1', 'Landlord')).rejects.toThrow('Set FOO_BAR=1 to enable.')
  })

  it('assertWrites with no hint configured throws the bare default message', async () => {
    const client = { request: vi.fn() } as any
    const y = new Ynab({ client, allowWrites: false })
    await expect(y.createPayee('p1', 'Landlord')).rejects.toThrow('Writes are disabled on this server.')
  })
})

describe('moveMoney confirmation gate', () => {
  function client() {
    return { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) return { category: { id: path.includes('c-from') ? 'c-from' : 'c-to', budgeted: 500000 } }
      return { category: {} }
    }) } as any
  }

  it('throws ConfirmationRequiredError when confirm is absent', async () => {
    const y = new Ynab({ client: client(), allowWrites: true })
    await expect(y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 100)).rejects.toThrow(ConfirmationRequiredError)
  })

  it('succeeds when confirm: true is passed', async () => {
    const y = new Ynab({ client: client(), allowWrites: true })
    const res: any = await y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 100, undefined, { confirm: true })
    expect(res.moved).toBe(100)
    expect(res.movedText).toBe('$100.00')
    expect(res.from.assigned).toBe(400) // 500 - 100
    expect(res.from.assignedText).toBe('$400.00')
    expect(res.to.assigned).toBe(600) // 500 + 100
    expect(res.to.assignedText).toBe('$600.00')
  })
})

describe('assignBudget confirmation gate', () => {
  function client() {
    return { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) return { category: { id: 'c1', budgeted: 100000 } }
      return { category: { id: 'c1', budgeted: 250000 } }
    }) } as any
  }

  it('throws ConfirmationRequiredError when confirm is absent', async () => {
    const y = new Ynab({ client: client(), allowWrites: true })
    await expect(y.assignBudget('p1', '2026-07-01', 'c1', 250)).rejects.toThrow(ConfirmationRequiredError)
  })

  it('succeeds when confirm: true is passed', async () => {
    const y = new Ynab({ client: client(), allowWrites: true })
    const res: any = await y.assignBudget('p1', '2026-07-01', 'c1', 250, undefined, { confirm: true })
    expect(res.assigned).toBe(250)
    expect(res.assignedText).toBe('$250.00')
  })
})

// ---------------------------------------------------------------------------
// Task 2: writes return their own inverse (hosted tier has no undo journal —
// the conversation carries the undo instead). Each of the 7 allowlisted write
// methods gets an additive `inverse: string` field on its result.
// ---------------------------------------------------------------------------

describe('moveMoney inverse', () => {
  it('names the reversed direction and the same formatted amount as the move', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) {
        if (path.includes('c-from')) return { category: { id: 'c-from', name: 'Dining Out', budgeted: 500000 } }
        return { category: { id: 'c-to', name: 'Credit Card Payment', budgeted: 200000 } }
      }
      return { category: {} }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 340, undefined, { confirm: true })
    expect(res.inverse).toContain('$340.00')
    expect(res.inverse).toMatch(/Credit Card Payment/)
    expect(res.inverse).toMatch(/Dining Out/)
    // The move was Dining Out -> Credit Card Payment; the inverse must run the OTHER way:
    // "from Credit Card Payment ... back to Dining Out" — destination named before source.
    const idxTo = res.inverse.indexOf('Credit Card Payment')
    const idxFrom = res.inverse.indexOf('Dining Out')
    expect(idxTo).toBeGreaterThanOrEqual(0)
    expect(idxFrom).toBeGreaterThan(idxTo)
  })

  it('never leaks raw milliunits into the inverse string', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) return { category: { id: path.includes('c-from') ? 'c-from' : 'c-to', name: 'Cat', budgeted: 500000 } }
      return { category: {} }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 25, undefined, { confirm: true })
    expect(res.inverse).toContain('$25.00')
    expect(res.inverse).not.toMatch(/25000/)
  })
})

describe('assignBudget inverse', () => {
  it('names the category and the prior formatted amount', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) return { category: { id: 'c1', name: 'Groceries', budgeted: 100000 } }
      return { category: { id: 'c1', budgeted: 250000 } }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.assignBudget('p1', '2026-07-01', 'c1', 250, undefined, { confirm: true })
    expect(res.inverse).toMatch(/Groceries/)
    expect(res.inverse).toContain('$100.00')
    expect(res.inverse).not.toMatch(/100000/)
  })
})

describe('updateTransactions inverse', () => {
  const txn = (o: any = {}) => ({
    id: 't1', date: '2026-07-01', amount: -45500, payee_name: 'Kroger', payee_id: 'pay1',
    category_name: 'Dining Out', category_id: 'c-old', account_name: 'Checking', account_id: 'a1',
    memo: null, cleared: 'cleared', approved: true, flag_color: null, transfer_account_id: null,
    import_id: null, deleted: false, subtransactions: [], ...o,
  })

  it('names the PRIOR category, proving the read happened before the write', async () => {
    // The stubbed bulk-read returns a DIFFERENT category name once a write has occurred. If the
    // implementation ever reads after writing (or per-row against the wrong value), the mock would
    // hand back the post-write name and this test would catch it.
    let written = false
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (!opts?.method) return { transactions: [txn({ category_name: written ? 'Groceries' : 'Dining Out', category_id: written ? 'c-new' : 'c-old' })] }
      written = true
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.updateTransactions('p1', [{ id: 't1', categoryId: 'c-new' }])
    expect(res.inverse).toMatch(/Dining Out/)
    expect(res.inverse).not.toMatch(/Groceries/)
  })

  it('batches the prior-value read into a single request regardless of row count', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => txn({ id: `t${i}` }))
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) return { transactions: rows }
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const updates = rows.map((r) => ({ id: r.id, categoryId: 'c-new' }))
    await y.updateTransactions('p1', updates, { confirm: true, expectedCount: updates.length })
    // A per-row loop would issue 40 reads here; the brief requires exactly one bulk TRANSACTIONS read.
    // The /plans currency-symbol lookup is a separate, cached-per-instance concern (fix/currency-symbol).
    const readCalls = client.request.mock.calls.filter(([path, opts]: any) => !opts?.method && !path.endsWith('/settings'))
    expect(readCalls).toHaveLength(1)
  })

  it('formats the prior amount as dollars, not milliunits', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) return { transactions: [txn({ amount: -50000 })] }
      return { transactions: [] }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.updateTransactions('p1', [{ id: 't1', amount: -12.34 }])
    expect(res.inverse).toContain('$50.00')
    expect(res.inverse).not.toMatch(/50000/)
  })
})

describe('updateCategory inverse', () => {
  it('names the prior goal amount, formatted as dollars', async () => {
    const client = { request: vi.fn(async (path: string, opts: any) => {
      if (path.endsWith('/settings')) return PLAN_SETTINGS_USD
      if (!opts?.method) return { category: { id: 'c1', name: 'Rent', hidden: false, goal_target: 1000000, goal_target_date: null, goal_frequency: null, goal_needs_whole_amount: null } }
      return { category: { id: 'c1' } }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.updateCategory('p1', 'c1', { goalTarget: 1500 })
    expect(res.inverse).toMatch(/Rent/)
    expect(res.inverse).toContain('$1,000.00')
    expect(res.inverse).not.toMatch(/1000000/)
  })
  it('renders an unset (null) prior non-goal-target field as "(none)", not the literal text "null"', async () => {
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (!opts?.method) return { category: { id: 'c1', name: 'Rent', hidden: false, goal_target: null, goal_target_date: null, goal_frequency: null, goal_needs_whole_amount: null } }
      return { category: { id: 'c1' } }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.updateCategory('p1', 'c1', { goalFrequency: 'monthly' })
    expect(res.inverse).toContain('(none)')
    expect(res.inverse).not.toMatch(/back to null\b/)
  })
})

describe('renamePayee inverse', () => {
  it('names the prior payee name', async () => {
    const client = { request: vi.fn(async (_path: string, opts: any) => {
      if (!opts?.method) return { payee: { id: 'pay1', name: 'Bob' } }
      return { payee: {} }
    }) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.renamePayee('p1', 'pay1', 'Alice')
    expect(res.inverse).toMatch(/Bob/)
  })
})

describe('createCategory and createPayee inverse (no delete endpoint in the YNAB API)', () => {
  it('createCategory says plainly that it cannot be reversed, rather than inventing a fake undo', async () => {
    const client = { request: vi.fn(async () => ({ category: { id: 'c1', name: 'Fun' } })) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.createCategory('p1', { name: 'Fun', groupId: 'g1' })
    expect(res.inverse).toMatch(/no way to delete|cannot be (undone|reversed)/i)
  })

  it('createPayee says plainly that it cannot be reversed, rather than inventing a fake undo', async () => {
    const client = { request: vi.fn(async () => ({ payee: { id: 'pay1', name: 'Landlord' } })) } as any
    const y = new Ynab({ client, allowWrites: true })
    const res: any = await y.createPayee('p1', 'Landlord')
    expect(res.inverse).toMatch(/no way to delete|cannot be (undone|reversed)/i)
  })
})
