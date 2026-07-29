import { defineConfig } from 'tsup'

// MCPB_BUNDLE=1 produces a fully self-contained build (all deps inlined) in
// dist-mcpb/ for the .mcpb desktop extension — the archive ships no
// node_modules, so nothing may remain external except Node built-ins.
const mcpb = process.env.MCPB_BUNDLE === '1'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  ...(mcpb ? { outDir: 'dist-mcpb', noExternal: [/.*/] } : {}),
})
