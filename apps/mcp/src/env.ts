import { readFileSync } from 'node:fs'

// This library (@walensis/cove-core) can't know its own deployment context, so WriteDisabledError's
// default message names no environment variable — the stdio server (this app) is the one place that
// DOES know it's YNAB_ALLOW_WRITES, so it supplies this as the hint to keep local behavior unchanged.
export const WRITE_DISABLED_HINT = 'Writes are disabled. This server runs read-only by default to protect your budget. ' +
  'To enable writes, set the environment variable YNAB_ALLOW_WRITES=1 in your MCP server config and restart.'

export function resolveEnv(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): { token: string; allowWrites: boolean } {
  let raw = env.YNAB_ACCESS_TOKEN
  if (raw === undefined && env.YNAB_ACCESS_TOKEN_FILE) {
    try {
      raw = readFile(env.YNAB_ACCESS_TOKEN_FILE)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(
        `Could not read YNAB_ACCESS_TOKEN_FILE (${env.YNAB_ACCESS_TOKEN_FILE}): ${msg}. ` +
        'Check the path and permissions, or set YNAB_ACCESS_TOKEN directly. ' +
        'Create a token at app.ynab.com → Account Settings → Developer Settings.')
    }
  }
  const token = raw?.trim()
  if (!token) throw new Error(
    'No YNAB token found. Set YNAB_ACCESS_TOKEN (or YNAB_ACCESS_TOKEN_FILE) in this MCP server\'s env. ' +
    'Create a token at app.ynab.com → Account Settings → Developer Settings → New Token.')
  return { token, allowWrites: env.YNAB_ALLOW_WRITES === '1' }
}
