// Checks the links in the Markdown files: relative paths and #anchors must exist, and web addresses must answer.
//   node dev/check-links.mjs            local links and web addresses
//   node dev/check-links.mjs --local    local links only
// The site serves docs/guide pages at /docs/<slug> and its own pages from apps/site/src/pages, so a link starting
// with / is checked against those files.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ONLY = process.argv.includes('--local');
const SKIP = new Set(['node_modules', '.git', '.dev', '.output', '.wxt', '.astro', 'dist', 'releases']);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.md')) files.push(p);
  }
})(ROOT);
// Release notes are history, and their links are not kept up to date.
files.push(...['releases/README.md'].map((f) => join(ROOT, f)).filter(existsSync));

const slug = (h) =>
  h
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .trim()
    .replace(/ /g, '-');
const anchors = (file) => {
  const out = new Set();
  let fence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && line.match(/^#{1,6}\s+(.*)$/);
    if (m) out.add(slug(m[1]));
  }
  return out;
};

const links = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, (b) => b.replace(/[^\n]/g, ' '));
  const rel = relative(ROOT, file);
  const found = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  found.push(...[...text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1]));
  for (const l of found) links.push({ file, rel, link: l });
}

const bad = [];
const web = new Map();
for (const { file, rel, link } of links) {
  if (/^(mailto:|tel:|data:)/.test(link) || /[<{]/.test(link)) continue;
  if (/^https?:\/\//.test(link)) {
    const url = link.replace(/[.,]$/, '');
    if (!web.has(url)) web.set(url, []);
    web.get(url).push(rel);
    continue;
  }
  const [path, hash] = link.split('#');
  let target = path ? (path.startsWith('/') ? join(ROOT, path) : resolve(dirname(file), path)) : file;
  // /docs/<page> on the website is docs/guide/<page>.md.
  const m = path.match(/^\/docs\/([\w-]+)$/);
  if (m) target = join(ROOT, 'docs/guide', `${m[1]}.md`);
  else if (path === '/docs') target = join(ROOT, 'docs/guide');
  else if (path.startsWith('/')) target = [join(ROOT, 'apps/site/src/pages', `${path}.astro`), join(ROOT, 'apps/site/src/pages', path, 'index.astro'), target].find(existsSync) ?? target;
  if (!existsSync(target)) {
    bad.push(`${rel}: ${link} (no such file)`);
    continue;
  }
  if (hash && target.endsWith('.md') && !anchors(target).has(hash)) bad.push(`${rel}: ${link} (no such heading)`);
}

if (!LOCAL_ONLY) {
  const check = async (url) => {
    for (const method of ['HEAD', 'GET']) {
      try {
        const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'agentic-routines-link-check' } });
        if (r.ok) return null;
        if (method === 'GET') return `HTTP ${r.status}`;
      } catch (e) {
        if (method === 'GET') return e.message;
      }
    }
  };
  const urls = [...web.keys()];
  const results = await Promise.all(urls.map(async (u) => [u, await check(u)]));
  for (const [u, err] of results) if (err) bad.push(`${web.get(u)[0]}: ${u} (${err})`);
}

console.log(`${links.length} links in ${files.length} files${LOCAL_ONLY ? '' : `, ${web.size} web addresses`}`);
if (bad.length) {
  console.log(bad.join('\n'));
  process.exit(1);
}
console.log('All links resolve.');
