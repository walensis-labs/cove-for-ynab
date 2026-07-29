import { readFileSync } from 'node:fs'

export function resolveEnv(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): { token: string; allowWrites: boolean } {
  const raw = env.YNAB_ACCESS_TOKEN ?? (env.YNAB_ACCESS_TOKEN_FILE ? readFile(env.YNAB_ACCESS_TOKEN_FILE) : undefined)
  const token = raw?.trim()
  if (!token) throw new Error(
    'No YNAB token found. Set YNAB_ACCESS_TOKEN (or YNAB_ACCESS_TOKEN_FILE) in this MCP server\'s env. ' +
    'Create a token at app.ynab.com → Account Settings → Developer Settings → New Token.')
  return { token, allowWrites: env.YNAB_ALLOW_WRITES === '1' }
}
