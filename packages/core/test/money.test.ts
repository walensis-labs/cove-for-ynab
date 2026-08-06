import { describe, it, expect } from 'vitest'
import { milliToDollars, dollarsToMilli, formatDollars } from '../src/money.js'

describe('money', () => {
  it('converts milliunits to dollars', () => {
    expect(milliToDollars(1234560)).toBe(1234.56)
    expect(milliToDollars(-500)).toBe(-0.5)
    expect(milliToDollars(0)).toBe(0)
    expect(milliToDollars(1234567)).toBe(1234.567) // exact tenth-of-cent preserved
  })
  it('converts dollars to milliunits (rounds to integer milli)', () => {
    expect(dollarsToMilli(1234.56)).toBe(1234560)
    expect(dollarsToMilli(-0.5)).toBe(-500)
    expect(dollarsToMilli(0.005)).toBe(5)
    expect(dollarsToMilli(19.999)).toBe(19999)
  })
  it('round-trips', () => {
    for (const m of [0, 1, -1, 999, 123456789, -42010]) expect(dollarsToMilli(milliToDollars(m))).toBe(m)
  })
  it('formats', () => {
    expect(formatDollars(1234.5)).toBe('$1,234.50')
    expect(formatDollars(-3.211, { decimals: 2 })).toBe('-$3.21')
    expect(formatDollars(10, { symbol: '€' })).toBe('€10.00')
  })
  it('MINOR 6: drops a misleading negative sign once rounding erases the sub-cent amount', () => {
    expect(formatDollars(-0.001)).toBe('$0.00')
    expect(formatDollars(-0.0049)).toBe('$0.00')
    // still negative once it rounds to a nonzero cent
    expect(formatDollars(-0.006)).toBe('-$0.01')
  })
  it('MINOR 6: throws rather than emit a plausible-looking "$NaN"', () => {
    expect(() => formatDollars(NaN)).toThrow(/NaN/)
  })
})
