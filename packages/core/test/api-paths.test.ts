import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Contract test: every API path domain.ts constructs must actually exist in the vendored OpenAPI spec.
// This caught a real bug — createCategory POSTed /plans/{plan_id}/categories/groups, a path that
// doesn't exist; the spec defines /plans/{plan_id}/category_groups.

const __dirname = dirname(fileURLToPath(import.meta.url))
const domainSrc = readFileSync(join(__dirname, '../src/domain.ts'), 'utf8')
const specSrc = readFileSync(join(__dirname, '../openapi/ynab-v1.yaml'), 'utf8')

/** Every template-literal path in domain.ts that starts with /plans or /user. */
function extractUsedPaths(src: string): string[] {
  const out = new Set<string>()
  const templateRe = /`([^`]*)`/g
  let m: RegExpExecArray | null
  while ((m = templateRe.exec(src))) {
    const lit = m[1]!
    if (lit.startsWith('/plans') || lit.startsWith('/user')) out.add(lit)
  }
  return [...out]
}

/** Every top-level path key under `paths:` in the vendored spec. */
function extractSpecPaths(src: string): string[] {
  const re = /^ {2}'?(\/[^\s:']+)'?:/
  const out: string[] = []
  for (const line of src.split('\n')) {
    const found = re.exec(line)
    if (found) out.push(found[1]!)
  }
  return out
}

/**
 * Builds a RegExp from a used-path template: `${...}` interpolations become a wildcard that can
 * absorb one or more literal path segments (so e.g. `${sub[0]}` — which itself expands to something
 * like `accounts/${accountId}` — still lines up against a spec path like
 * /plans/{plan_id}/accounts/{account_id}/transactions). Everything else must match literally, so a
 * bogus hardcoded segment (like `groups` where the spec expects `{category_id}` or `category_groups`)
 * is caught rather than silently treated as a valid param value.
 */
function toMatcher(usedPath: string): RegExp {
  const PLACEHOLDER = ' '
  const withPlaceholders = usedPath.replace(/\$\{[^}]*\}/g, PLACEHOLDER)
  const escaped = withPlaceholders.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.split(PLACEHOLDER).join('.+')
  return new RegExp(`^${pattern}$`)
}

describe('API path contract (domain.ts vs. vendored OpenAPI spec)', () => {
  const usedPaths = extractUsedPaths(domainSrc)
  const specPaths = extractSpecPaths(specSrc)

  it('found a healthy number of paths on both sides (sanity check the extraction itself)', () => {
    expect(usedPaths.length).toBeGreaterThan(10)
    expect(specPaths.length).toBeGreaterThan(10)
  })

  for (const path of usedPaths) {
    it(`${path} matches a path defined in the spec`, () => {
      const matcher = toMatcher(path)
      const match = specPaths.some((spec) => matcher.test(spec))
      expect(match, `no spec path matches used path "${path}" (checked against ${specPaths.length} spec paths)`).toBe(true)
    })
  }
})
