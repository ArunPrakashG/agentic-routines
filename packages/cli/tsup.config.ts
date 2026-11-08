import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

const shared = { target: 'node20', platform: 'node', banner: { js: '#!/usr/bin/env node' } } as const;

// The public half of the release key: a copy only updates itself from what that key signed.
const keyFile = resolve(__dirname, '../../releases/update-key.pub');
const updateKey = process.env.AR_UPDATE_PUBLIC_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');

// `import x from './file?text'` inlines the file as a string: the agent plugin's files ship inside the CLI.
const text = {
  name: 'text',
  setup(build: any) {
    build.onResolve({ filter: /\?text$/ }, (a: any) => ({ path: resolve(a.resolveDir, a.path.slice(0, -5)), namespace: 'text' }));
    build.onLoad({ filter: /.*/, namespace: 'text' }, (a: any) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }));
  },
};

export default defineConfig([
  { ...shared, format: ['esm'], entry: { index: 'src/index.ts', 'execute-worker': 'src/mcp/execute-worker.ts' }, noExternal: ['@agentic-routines/core', '@agentic-routines/browsers'], esbuildPlugins: [text], define: { __UPDATE_KEY__: JSON.stringify(updateKey) } },
  // CommonJS, as bundled dependencies use require.
  { ...shared, format: ['cjs'], entry: { 'host-main': 'src/host/main.ts' }, noExternal: [/.*/] },
]);
