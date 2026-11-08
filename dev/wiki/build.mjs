// Builds the GitHub wiki from docs/ into the folder given (default .dev/wiki). Nothing is pushed here.
//   node dev/wiki/build.mjs [out]
// GitHub only creates a wiki's git repository when its first page is made in the web UI, and a private repository needs a paid
// plan for a wiki at all. Once the wiki exists: clone <repo>.wiki.git, copy the output over it, commit and push (dev/wiki/README.md).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(process.argv[2] ?? join(ROOT, '.dev/wiki'));
const REPO = 'https://github.com/ArunPrakashG/agentic-routines';

const guide = readdirSync(join(ROOT, 'docs/guide')).filter((f) => f.endsWith('.md')).map((f) => `docs/guide/${f}`);
const extra = ['docs/architecture.md', 'docs/privacy.md', 'docs/directory-guidelines.md'];
const sources = [...guide, ...extra];

const titleOf = (file) => /^# (.+)$/m.exec(readFileSync(join(ROOT, file), 'utf8'))?.[1] ?? basename(file, '.md');
const page = new Map(sources.map((f) => [f, titleOf(f).replace(/[\\/:*?"<>|#]/g, '').trim().replace(/\s+/g, '-')]));
const byStem = new Map(sources.map((f) => [basename(f, '.md'), page.get(f)]));

function rewrite(file, md) {
  return md.replace(/\]\(([^)\s]+)\)/g, (all, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return all;
    const [path, hash] = href.split('#');
    const frag = hash ? `#${hash}` : '';
    // The website's own addresses, such as /docs/safety.
    const site = /^\/docs\/([\w-]+)$/.exec(path);
    if (site && byStem.has(site[1])) return `](${byStem.get(site[1])}${frag})`;
    if (!path) return all;
    const target = normalize(join(dirname(file), path));
    if (page.has(target)) return `](${page.get(target)}${frag})`;
    if (/\.(webp|png|svg)$/.test(target)) return `](${REPO}/raw/main/${target})`;
    return `](${REPO}/blob/main/${relative('.', target)}${frag})`;
  }).replace(/(src|srcset)="(\.\.?\/[^"]+)"/g, (all, a, p) => `${a}="${REPO}/raw/main/${normalize(join(dirname(file), p))}"`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of sources) writeFileSync(join(OUT, `${page.get(f)}.md`), rewrite(f, readFileSync(join(ROOT, f), 'utf8')));

const link = (f) => `[${titleOf(f)}](${page.get(f)})`;
const order = ['getting-started', 'how-it-works', 'routines', 'refine', 'tools', 'agents', 'cli', 'safety', 'sharing', 'repositories', 'remote', 'hooks', 'benchmarks', 'troubleshooting', 'development'];
const ordered = order.map((s) => guide.find((f) => basename(f, '.md') === s)).filter(Boolean);
const rest = guide.filter((f) => !ordered.includes(f));
const lines = [...ordered, ...rest, ...extra].map((f) => `- ${link(f)}`);
writeFileSync(join(OUT, '_Sidebar.md'), `**[Home](Home)**\n\n${lines.join('\n')}\n`);
writeFileSync(join(OUT, 'Home.md'), `# Agentic Routines\n\nA cache for your agent's long browser chores. Repeat tasks replay as one tool call, with no model.\n\nStart with ${link('docs/guide/getting-started.md')}.\n\n${lines.join('\n')}\n\nThe source is in [the repository](${REPO}). These pages are generated from its \`docs/\` folder, so change them there.\n`);
console.log(`${sources.length + 2} pages in ${OUT}`);
