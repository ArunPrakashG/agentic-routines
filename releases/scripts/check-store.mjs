// Checks a built extension against what the stores reject for. Usage: node check-store.mjs <dir with chrome-mv3 and firefox-mv3>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, releases } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: check-store.mjs <build dir>');
  process.exit(1);
}

const allowed = readJson(join(releases, 'store', 'permissions.json'));
const problems = [];
const bad = (target, msg) => problems.push(`${target}: ${msg}`);

function walk(d) {
  return readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
}

for (const target of ['chrome-mv3', 'firefox-mv3']) {
  const base = join(dir, target);
  if (!existsSync(base)) {
    bad(target, 'not built');
    continue;
  }
  const m = readJson(join(base, 'manifest.json'));
  if (m.manifest_version !== 3) bad(target, 'must be manifest version 3');
  if (!m.name || m.name.length > 75) bad(target, 'name missing or over 75 characters');
  if (!m.description || m.description.length > 132) bad(target, 'description missing or over 132 characters');
  if (!/^\d+(\.\d+){0,3}$/.test(m.version)) bad(target, `version "${m.version}" is not 1 to 4 numbers`);
  for (const size of ['16', '32', '48', '128']) {
    if (!existsSync(join(base, 'icon', `${size}.png`))) bad(target, `icon ${size}.png missing`);
  }
  if ('key' in m) bad(target, 'a store build must not carry the dev key');
  if (m.content_security_policy && JSON.stringify(m.content_security_policy).match(/unsafe-eval|https?:/)) bad(target, 'content security policy allows remote or eval code');
  // Every permission asked for has a stated reason, and no reason is left over.
  const asked = [...(m.permissions ?? []), ...(m.host_permissions ?? [])];
  for (const p of asked) if (!allowed[p]) bad(target, `permission "${p}" has no justification in releases/store/permissions.json`);
  const chromeOnly = new Set(['sidePanel', 'debugger']);
  for (const p of Object.keys(allowed)) if (!asked.includes(p) && !(target === 'firefox-mv3' && chromeOnly.has(p))) bad(target, `justification for "${p}" but it is not requested`);
  if (target === 'firefox-mv3') {
    const g = m.browser_specific_settings?.gecko;
    if (!g?.id) bad(target, 'gecko id missing');
    if (!g?.data_collection_permissions) bad(target, 'data_collection_permissions missing');
  } else if (!m.minimum_chrome_version) {
    bad(target, 'minimum_chrome_version missing');
  }
  // Remote code: stores reject scripts loaded or built from strings at run time.
  for (const f of walk(base).filter((f) => /\.(js|html)$/.test(f))) {
    const text = readFileSync(f, 'utf8');
    if (/<script[^>]+src=["']https?:/i.test(text)) bad(target, `${f.slice(base.length + 1)} loads a remote script`);
    if (/\beval\s*\(/.test(text) || /new Function\s*\(/.test(text)) bad(target, `${f.slice(base.length + 1)} builds code from a string`);
    if (/import\s*\(\s*["']https?:/.test(text)) bad(target, `${f.slice(base.length + 1)} imports remote code`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('✓ store checks passed for chrome-mv3 and firefox-mv3');
