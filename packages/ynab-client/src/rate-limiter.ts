export class RateLimitError extends Error {
  constructor(minutesUntilNext: number) {
    super(`YNAB API rate limit reached (200 requests/hour, rolling window; this server stops at 190 to leave headroom). ` +
      `The next request slot opens in about ${minutesUntilNext} minute(s). Prefer aggregate/list tools over many small calls.`)
  }
}

export class RateLimiter {
  #stamps: number[] = []
  constructor(
    readonly limit = 190,
    readonly windowMs = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  #prune(): void {
    const cutoff = this.now() - this.windowMs
    this.#stamps = this.#stamps.filter((s) => s > cutoff)
  }

  take(): void {
    this.#prune()
    if (this.#stamps.length >= this.limit) {
      const oldest = this.#stamps[0]!
      const ms = oldest + this.windowMs - this.now()
      throw new RateLimitError(Math.max(1, Math.ceil(ms / 60_000)))
    }
    this.#stamps.push(this.now())
  }

  remaining(): number {
    this.#prune()
    return this.limit - this.#stamps.length
  }

  warning(): string | null {
    const rem = this.remaining()
    return rem < 50 ? `Warning: only ${rem} YNAB API requests remain in this hour's window. Prefer aggregate tools; avoid per-item calls.` : null
  }
}
