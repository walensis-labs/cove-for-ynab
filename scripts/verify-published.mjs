import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
for (const dir of ['packages/core', 'apps/mcp']) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  const remote = execSync(`npm view ${pkg.name}@${pkg.version} version`, { encoding: 'utf8' }).trim()
  if (remote !== pkg.version) { console.error(`NOT PUBLISHED: ${pkg.name}@${pkg.version}`); process.exit(1) }
  console.log(`ok: ${pkg.name}@${pkg.version}`)
}
