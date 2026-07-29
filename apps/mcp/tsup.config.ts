import { defineConfig } from 'tsup'
export default defineConfig({ entry: ['src/main.ts'], format: ['esm'], dts: false, clean: true, banner: { js: '#!/usr/bin/env node' } })
