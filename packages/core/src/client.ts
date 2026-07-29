import { RateLimiter } from './rate-limiter.js'

const HINTS: Record<string, string> = {
  '401': 'The YNAB access token is invalid or was revoked. Create a new one: app.ynab.com → Account Settings → Developer Settings.',
  '403.1': "The YNAB subscription for this account has lapsed — the API rejects requests until it's renewed.",
  '403.2': 'The YNAB trial for this account has expired.',
  '403.3': 'This token is not authorized for that operation (it may be a read-only OAuth scope).',
  '403.4': 'This YNAB account has hit a data limit; the API refused the request.',
  '404.2': 'Resource not found — the plan/account/transaction id may be wrong or deleted.',
  '429': 'YNAB rate limit: 200 requests/hour per token, rolling window. Wait for the window to roll; prefer aggregate tools.',
  '500': 'YNAB had an internal error. Retry once; if persistent, check status.ynab.com.',
}

export class YnabApiError extends Error {
  constructor(readonly status: number, readonly id: string, detail: string, readonly hint?: string) {
    super(hint ? `${detail} — ${hint}` : detail)
    this.name = 'YnabApiError'
  }
}

export class YnabClient {
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #base: string
  readonly #limiter?: RateLimiter

  constructor(opts: { token: string; fetchImpl?: typeof fetch; baseUrl?: string; limiter?: RateLimiter }) {
    this.#token = opts.token
    this.#fetch = opts.fetchImpl ?? fetch
    this.#base = opts.baseUrl ?? 'https://api.ynab.com/v1'
    this.#limiter = opts.limiter
  }

  #redact(s: string): string {
    return s.split(this.#token).join('[redacted]')
  }

  async request<T>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    this.#limiter?.take()
    const url = new URL(this.#base + path)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const res = await this.#fetch(url, {
      method: opts.method ?? 'GET',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const text = await res.text()
    if (!res.ok) {
      let id = String(res.status)
      let detail = res.statusText || 'YNAB API error'
      try {
        const parsed = JSON.parse(text).error
        if (parsed?.id) id = parsed.id
        if (parsed?.detail) detail = parsed.detail
      } catch { /* non-JSON error body */ }
      throw new YnabApiError(res.status, id, this.#redact(detail), HINTS[id] ?? HINTS[String(res.status)])
    }
    return (text ? JSON.parse(text).data : undefined) as T
  }
}
