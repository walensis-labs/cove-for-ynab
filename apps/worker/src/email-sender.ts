import type { WorkerEnv } from './env.js'

export interface EmailMessage {
  to: string
  from: { email: string; name?: string }
  subject: string
  text: string
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>
}

/** Wraps Cloudflare's `send_email` binding — requires the Workers Paid plan. */
export class CloudflareEmailSender implements EmailSender {
  constructor(private readonly binding: NonNullable<WorkerEnv['EMAIL']>) {}

  async send(msg: EmailMessage): Promise<void> {
    await this.binding.send(msg)
  }
}

/** Sends via Resend's HTTP API (https://resend.com) — works on the Workers Free plan. */
export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string
  readonly #fetch: typeof fetch

  constructor(apiKey: string, fetchImpl?: typeof fetch) {
    this.#apiKey = apiKey
    // Bind the global fetch — an unbound global called as this.#fetch(...) throws
    // "Illegal invocation" in workerd (see YnabClient for the same fix).
    this.#fetch = fetchImpl ?? fetch.bind(globalThis)
  }

  async send(msg: EmailMessage): Promise<void> {
    const from = msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email
    const res = await this.#fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      // NEVER include this.#apiKey here — it would otherwise land in worker logs/thrown errors.
      throw new Error(`Resend API request failed: ${res.status} ${res.statusText} — ${body}`)
    }
  }
}

/**
 * RESEND_API_KEY (non-empty) wins when present — it's the free-plan path and works regardless of
 * Cloudflare plan. Falls back to the EMAIL binding (Cloudflare Email Sending, Workers Paid only)
 * when no Resend key is configured. Throws when neither is configured, so a misconfigured deploy
 * fails loudly at first send rather than silently dropping mail.
 */
export function selectSender(env: WorkerEnv): EmailSender {
  if (env.RESEND_API_KEY) {
    return new ResendEmailSender(env.RESEND_API_KEY)
  }
  if (env.EMAIL) {
    return new CloudflareEmailSender(env.EMAIL)
  }
  throw new Error(
    'No email sender configured: set RESEND_API_KEY (free tier) or bind EMAIL (Cloudflare Email Sending, Workers Paid).',
  )
}
