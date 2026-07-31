import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string

export default defineConfig({
  entry: ['src/main.ts', 'src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __MCP_VERSION__: JSON.stringify(pkgVersion) },
})
