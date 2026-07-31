import { describe, it, expect, vi } from 'vitest'
import { CloudflareEmailSender, ResendEmailSender, selectSender, type EmailMessage } from '../src/email-sender.js'
import type { WorkerEnv } from '../src/env.js'

function baseEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    YNAB_ACCESS_TOKEN: 'ynab-token',
    MCP_AUTH_TOKEN: 'auth-token',
    DB: {} as WorkerEnv['DB'],
    ...overrides,
  }
}

describe('ResendEmailSender', () => {
  const msg: EmailMessage = {
    to: 'to@example.com',
    from: { email: 'from@example.com', name: 'Digest Bot' },
    subject: 'Subject line',
    text: 'Body text',
  }

  it('POSTs to the Resend API with the correct URL, auth header, and body shape (from with name)', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }))
    const sender = new ResendEmailSender('resend-api-key', fetchStub as unknown as typeof fetch)

    await sender.send(msg)

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer resend-api-key')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      from: 'Digest Bot <from@example.com>',
      to: ['to@example.com'],
      subject: 'Subject line',
      text: 'Body text',
    })
  })

  it('uses a bare email for "from" when no name is given', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }))
    const sender = new ResendEmailSender('resend-api-key', fetchStub as unknown as typeof fetch)

    await sender.send({ ...msg, from: { email: 'from@example.com' } })

    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.from).toBe('from@example.com')
  })

  it('throws an error including the status and response body on a non-2xx response, without leaking the api key', async () => {
    const fetchStub = vi.fn(async () => new Response('{"message":"invalid api key"}', { status: 500 }))
    const sender = new ResendEmailSender('super-secret-key', fetchStub as unknown as typeof fetch)

    await expect(sender.send(msg)).rejects.toThrow(/500/)
    await expect(sender.send(msg)).rejects.toThrow(/invalid api key/)
    try {
      await sender.send(msg)
      expect.unreachable()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      expect(message).not.toContain('super-secret-key')
    }
  })
})

describe('CloudflareEmailSender', () => {
  it('forwards the message to the binding unchanged', async () => {
    const bindingSend = vi.fn(async () => ({}))
    const sender = new CloudflareEmailSender({ send: bindingSend })

    const msg: EmailMessage = {
      to: 'to@example.com',
      from: { email: 'from@example.com', name: 'Digest Bot' },
      subject: 'Subject line',
      text: 'Body text',
    }
    await sender.send(msg)

    expect(bindingSend).toHaveBeenCalledTimes(1)
    expect(bindingSend).toHaveBeenCalledWith(msg)
  })
})

describe('selectSender', () => {
  it('picks ResendEmailSender when RESEND_API_KEY is set (no EMAIL binding)', () => {
    const env = baseEnv({ RESEND_API_KEY: 'resend-key' })
    expect(selectSender(env)).toBeInstanceOf(ResendEmailSender)
  })

  it('picks CloudflareEmailSender when only the EMAIL binding is present', () => {
    const env = baseEnv({ EMAIL: { send: async () => ({}) } })
    expect(selectSender(env)).toBeInstanceOf(CloudflareEmailSender)
  })

  it('throws a clear error when neither RESEND_API_KEY nor EMAIL is configured', () => {
    const env = baseEnv()
    expect(() => selectSender(env)).toThrow(
      'No email sender configured: set RESEND_API_KEY (free tier) or bind EMAIL (Cloudflare Email Sending, Workers Paid).',
    )
  })

  it('prefers Resend when both RESEND_API_KEY and EMAIL are present', () => {
    const env = baseEnv({ RESEND_API_KEY: 'resend-key', EMAIL: { send: async () => ({}) } })
    expect(selectSender(env)).toBeInstanceOf(ResendEmailSender)
  })

  it('treats an empty-string RESEND_API_KEY as absent, falling back to the EMAIL binding', () => {
    const env = baseEnv({ RESEND_API_KEY: '', EMAIL: { send: async () => ({}) } })
    expect(selectSender(env)).toBeInstanceOf(CloudflareEmailSender)
  })
})

describe('global fetch binding (workerd regression)', () => {
  it('binds the global fetch when no fetchImpl is injected', async () => {
    const original = globalThis.fetch
    let seenThis: unknown = 'never-called'
    globalThis.fetch = function (this: unknown) {
      seenThis = this
      return Promise.resolve(new Response('{}', { status: 200 }))
    } as unknown as typeof fetch
    try {
      const sender = new ResendEmailSender('re_test_key')
      await sender.send({ to: 'a@b.com', from: { email: 'c@d.com' }, subject: 's', text: 't' })
    } finally {
      globalThis.fetch = original
    }
    expect(seenThis === globalThis || seenThis === undefined).toBe(true)
  })
})
