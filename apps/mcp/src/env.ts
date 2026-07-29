import { readFileSync } from 'node:fs'

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
