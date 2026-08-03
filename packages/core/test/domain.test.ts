import { describe, it, expect, vi } from 'vitest'
import { Ynab, WriteDisabledError, ConfirmationRequiredError } from '../src/domain.js'

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
    const res = await y.moveMoney('p1', '2026-07-01', 'c-from', 'c-to', 100, undefined, { confirm: true })
    expect(res.moved).toBe(100)
  })
})

describe('assignBudget confirmation gate', () => {
  function client() {
    return { request: vi.fn(async (path: string, opts: any) => {
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
    const res = await y.assignBudget('p1', '2026-07-01', 'c1', 250, undefined, { confirm: true })
    expect(res.assigned).toBe(250)
  })
})
