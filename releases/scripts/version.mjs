// Sets the product version in every package that carries it. Usage: node releases/scripts/version.mjs 0.2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, versioned } from './lib.mjs';

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) {
  console.error('Usage: version.mjs <major.minor.patch>');
  process.exit(1);
}
for (const f of versioned) {
  const p = join(root, f);
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, text.replace(/("version": ")[^"]+(")/, `$1${next}$2`));
  console.log(`${f}  ${next}`);
}
