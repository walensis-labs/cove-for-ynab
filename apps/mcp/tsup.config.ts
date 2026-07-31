import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

// MCPB_BUNDLE=1 produces a fully self-contained build (all deps inlined) in
// dist-mcpb/ for the .mcpb desktop extension — the archive ships no
// node_modules, so nothing may remain external except Node built-ins.
const mcpb = process.env.MCPB_BUNDLE === '1'
const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string

export default defineConfig({
  entry: mcpb ? ['src/main.ts'] : ['src/main.ts', 'src/index.ts'],
  format: ['esm'],
  dts: !mcpb,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __MCP_VERSION__: JSON.stringify(pkgVersion) },
  ...(mcpb ? { outDir: 'dist-mcpb', noExternal: [/.*/] } : {}),
})
