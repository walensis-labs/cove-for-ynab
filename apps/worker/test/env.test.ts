import { describe, it, expect } from 'vitest'
import { parseCardPairs, alertThresholdMilli, type WorkerEnv } from '../src/env.js'

describe('parseCardPairs', () => {
  it('returns [] when CARD_PAIRS is absent', () => {
    expect(parseCardPairs(undefined)).toEqual([])
  })
  it('returns [] when CARD_PAIRS is an empty string', () => {
    expect(parseCardPairs('')).toEqual([])
  })
  it('parses a well-formed JSON array', () => {
    const json = JSON.stringify([
      { name: 'Citi', paymentCategoryId: 'cat-1', cardAccountId: 'acct-1' },
      { name: 'Amex', paymentCategoryId: 'cat-2', cardAccountId: 'acct-2' },
    ])
    expect(parseCardPairs(json)).toEqual([
      { name: 'Citi', paymentCategoryId: 'cat-1', cardAccountId: 'acct-1' },
      { name: 'Amex', paymentCategoryId: 'cat-2', cardAccountId: 'acct-2' },
    ])
  })
  it('throws a clear error on malformed JSON', () => {
    expect(() => parseCardPairs('{not json')).toThrow(/CARD_PAIRS/)
  })
  it('throws when the JSON is not an array', () => {
    expect(() => parseCardPairs('{"name":"Citi"}')).toThrow(/array/)
  })
  it('throws when an entry is missing required string fields', () => {
    expect(() => parseCardPairs(JSON.stringify([{ name: 'Citi' }]))).toThrow(/CARD_PAIRS\[0\]/)
  })
})

function fakeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    YNAB_ACCESS_TOKEN: 'ynab-token',
    MCP_AUTH_TOKEN: 'auth-token',
    DB: {} as WorkerEnv['DB'],
    EMAIL: { send: async () => ({}) },
    ...overrides,
  }
}

describe('alertThresholdMilli', () => {
  it('defaults to 250_000 milli ($250) when ALERT_THRESHOLD_DOLLARS is absent', () => {
    expect(alertThresholdMilli(fakeEnv())).toBe(250_000)
  })
  it('honors an ALERT_THRESHOLD_DOLLARS override', () => {
    expect(alertThresholdMilli(fakeEnv({ ALERT_THRESHOLD_DOLLARS: '100' }))).toBe(100_000)
  })
  it('honors a fractional-dollar override without float drift', () => {
    expect(alertThresholdMilli(fakeEnv({ ALERT_THRESHOLD_DOLLARS: '12.34' }))).toBe(12_340)
  })
})
