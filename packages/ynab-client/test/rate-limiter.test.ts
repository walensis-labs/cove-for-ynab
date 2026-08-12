import { describe, it, expect } from 'vitest'
import { RateLimiter, RateLimitError } from '../src/rate-limiter.js'

describe('RateLimiter', () => {
  it('allows up to limit within window then throws', () => {
    let t = 0
    const rl = new RateLimiter(3, 1000, () => t)
    rl.take(); rl.take(); rl.take()
    expect(() => rl.take()).toThrow(RateLimitError)
  })
  it('rolls the window', () => {
    let t = 0
    const rl = new RateLimiter(2, 1000, () => t)
    rl.take(); t = 500; rl.take()
    expect(() => rl.take()).toThrow(RateLimitError)
    t = 1001 // first stamp expired
    expect(() => rl.take()).not.toThrow()
  })
  it('reports remaining and warns under 50', () => {
    let t = 0
    const rl = new RateLimiter(51, 60_000, () => t)
    expect(rl.warning()).toBeNull()
    rl.take(); rl.take()
    expect(rl.remaining()).toBe(49)
    expect(rl.warning()).toMatch(/49 YNAB API requests remain/)
  })
})
