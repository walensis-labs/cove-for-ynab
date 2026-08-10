#!/usr/bin/env node
/**
 * Fails if a changeset names a package that isn't in the workspace.
 *
 * `changesets` only discovers this at release time, inside the publish step, *after* the merge to
 * main — so a stale name costs a whole release cycle to find. This exact failure happened once:
 * a changeset referenced `@walensis/mcp-for-ynab`, a name that stopped being a package when the
 * packages were renamed to `cove-*` and now survives only as the MCP registry entry.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const known = new Set()
for (const dir of ['packages', 'apps']) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      known.add(JSON.parse(readFileSync(join(dir, entry.name, 'package.json'), 'utf8')).name)
    } catch {}
  }
}

const problems = []
for (const file of readdirSync('.changeset')) {
  if (!file.endsWith('.md') || file === 'README.md') continue
  const body = readFileSync(join('.changeset', file), 'utf8')
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) continue
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^\s*["']?(@?[^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/)
    if (m && !known.has(m[1])) problems.push(`  ${file}: "${m[1]}" is not a workspace package`)
  }
}

if (problems.length) {
  console.error('Changeset references unknown package(s):\n' + problems.join('\n'))
  console.error('\nWorkspace packages:\n' + [...known].map((n) => '  ' + n).join('\n'))
  process.exit(1)
}
console.log(`changesets ok — all names resolve against ${known.size} workspace packages`)
