import { describe, it, expect } from 'vitest'
import type { WorkerEnv } from '../src/env.js'

function fakeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    YNAB_ACCESS_TOKEN: 'ynab-token',
    MCP_AUTH_TOKEN: 'auth-token',
    DB: {} as WorkerEnv['DB'],
    ...overrides,
  }
}

describe('WorkerEnv', () => {
  it('accepts the minimal required fields', () => {
    const env = fakeEnv()
    expect(env.YNAB_ACCESS_TOKEN).toBe('ynab-token')
    expect(env.MCP_AUTH_TOKEN).toBe('auth-token')
  })
  it('accepts optional PLAN_ID and WORKER_ALLOW_WRITES overrides', () => {
    const env = fakeEnv({ PLAN_ID: 'last-used', WORKER_ALLOW_WRITES: '1' })
    expect(env.PLAN_ID).toBe('last-used')
    expect(env.WORKER_ALLOW_WRITES).toBe('1')
  })
})
