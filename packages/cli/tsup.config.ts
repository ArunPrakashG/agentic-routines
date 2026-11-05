import { defineConfig } from 'tsup';

const shared = { target: 'node20', platform: 'node', banner: { js: '#!/usr/bin/env node' } } as const;

export default defineConfig([
  { ...shared, format: ['esm'], entry: ['src/index.ts'], noExternal: ['@browser-routines/core'] },
  // CommonJS, as bundled dependencies use require.
  { ...shared, format: ['cjs'], entry: ['src/host-main.ts'], noExternal: [/.*/] },
]);
