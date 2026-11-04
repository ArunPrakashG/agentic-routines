import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  noExternal: ['@browser-routines/core'],
  banner: { js: '#!/usr/bin/env node' },
});
