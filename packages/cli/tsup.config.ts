import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

const shared = { target: 'node20', platform: 'node', banner: { js: '#!/usr/bin/env node' } } as const;

// `import x from './file?text'` inlines the file as a string: the agent plugin's files ship inside the CLI.
const text = {
  name: 'text',
  setup(build: any) {
    build.onResolve({ filter: /\?text$/ }, (a: any) => ({ path: resolve(a.resolveDir, a.path.slice(0, -5)), namespace: 'text' }));
    build.onLoad({ filter: /.*/, namespace: 'text' }, (a: any) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }));
  },
};

export default defineConfig([
  { ...shared, format: ['esm'], entry: ['src/index.ts'], noExternal: ['@agentic-routines/core', '@agentic-routines/browsers'], esbuildPlugins: [text] },
  // CommonJS, as bundled dependencies use require.
  { ...shared, format: ['cjs'], entry: { 'host-main': 'src/host/main.ts' }, noExternal: [/.*/] },
]);
