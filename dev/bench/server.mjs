// Test site for the benchmark. It records each rollout, so a run only counts when
// the server received the right values, whichever browser or agent sent them.
//   /small    three tiny pages, about 8 actions
//   /console  a realistic console with large pages, about 25 actions
// POST /__reset?variant=b clears the log and renames the first form's button.
import { createServer } from 'node:http';

const PORT = Number(process.env.BENCH_PORT ?? 8766);
let log = [];
let variant = 'a';

const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:0;display:flex}nav.side{width:220px;padding:12px;border-right:1px solid #ddd}nav.side a{display:block;padding:2px 0}main{padding:20px;flex:1;max-width:900px}label{display:block;margin:10px 0}input:not([type=checkbox]),textarea,select{display:block;width:100%}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:4px;text-align:left}</style>
${body}</html>`;

// ---------- small ----------
const nextLabel = () => (variant === 'b' ? 'Review release' : 'Next');
const small = {
  '/small/': () => page('Acme Console', `<main><h1>Acme Console</h1><nav><a href="/small/apps">Apps</a></nav></main>`),
  '/small/apps': () => page('Apps · Acme Console', `<main><h1>Apps</h1><ul><li><a href="/small/release">Kavyam</a></li><li><a href="/small/release?app=2">Notes</a></li></ul></main>`),
  '/small/release': () =>
    page(
      'New release · Acme Console',
      `<main><h1>Create internal testing release</h1><form onsubmit="return false">
<label>App bundle <input type="file" id="bundle" accept=".aab"></label>
<label>Release name <input id="rname" name="release_name"></label>
<label>Release notes <textarea id="notes" name="notes"></textarea></label>
<button id="${variant === 'b' ? 'review-btn' : 'next'}" type="button">${nextLabel()}</button></form>
<section id="review" hidden><h2>Preview and confirm</h2><p id="summary"></p><button id="rollout" type="button">Start rollout to Internal testing</button></section>
<p id="status" role="status"></p>
<script>
const $ = (i) => document.getElementById(i);
document.querySelector('form button').onclick = () => { const f = $('bundle').files[0]; $('summary').textContent = $('rname').value + ' · ' + (f ? f.name : 'no bundle'); $('review').hidden = false; };
$('rollout').onclick = async () => {
  const f = $('bundle').files[0];
  await fetch('/__rollout', { method: 'POST', body: JSON.stringify({ task: 'small', file: f && f.name, size: f && f.size, name: $('rname').value, notes: $('notes').value }) });
  $('status').textContent = 'Rollout started: ' + $('rname').value;
};
</script></main>`,
    ),
};

// ---------- console ----------
const NAV = 'Dashboard,Statistics,Publishing overview,Inbox,Policy status,App content,Store listing,Custom store listings,Store settings,Translations,Reviews,Ratings,Reach and devices,Crashes and ANRs,Pre-launch report,Deliverables,App bundles,Device catalog,App signing,Internal app sharing,Production,Open testing,Closed testing,Internal testing,Pre-registration,Countries and regions,Testers,Monetise,Products,Subscriptions,Promo codes,Price experiments,Financial reports,Payments profile,Users and permissions,Activity log,Developer page,API access,Email lists,Notifications,Account details,Associated developers,Android vitals,Benchmarks,Deep links,Grow users,Store analysis,Search keywords,Acquisition reports,Campaigns,Audience growth,Engagement,Events,Offers,Help,Documentation,Send feedback,Status,Blog,Settings'.split(',');
const APPS = 'Kavyam,Notes,Tasks,Reader,Weather,Calendar,Contacts,Gallery,Recorder,Scanner,Maps,Radio,Podcasts,Budget,Fitness,Recipes,Journal,Translate,Dictionary,Atlas,Stocks,Clock,Compass,Files,Music,Studio,Chess,Sudoku,Puzzle,Kart,Tickets,Transit,Bank,Wallet,Health,Sleep,Water,Yoga,Garden,Pets'.split(',');
const LISTS = 'QA team,Beta Kerala,Staff,Friends and family,Design,Support,Sales,Partners,Press,Translators,Early access,Tablet users,Low-end devices,Accessibility,Students,Teachers,Writers,Editors,Community,Alumni'.split(',');
const COUNTRIES = 'India,United Arab Emirates,Qatar,Kuwait,Oman,Bahrain,Saudi Arabia,Sri Lanka,Nepal,Bangladesh,Pakistan,Maldives,Singapore,Malaysia,Indonesia,Thailand,Vietnam,Philippines,Japan,South Korea,China,Hong Kong,Taiwan,Australia,New Zealand,United Kingdom,Ireland,France,Germany,Spain,Portugal,Italy,Netherlands,Belgium,Switzerland,Austria,Sweden,Norway,Denmark,Finland,Poland,Czechia,Greece,Turkey,Israel,Egypt,Kenya,Nigeria,South Africa,Ghana,Canada,United States,Mexico,Brazil,Argentina,Chile,Colombia,Peru,Uruguay,Paraguay'.split(',');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const shell = (title, main) =>
  page(
    `${title} · Acme Console`,
    `<script>
const KEY = 'draft';
const draft = JSON.parse(sessionStorage.getItem(KEY) || '{}');
const save = () => sessionStorage.setItem(KEY, JSON.stringify(draft));
</script>
<nav class="side" aria-label="Console">${NAV.map((n) => `<a href="/console/x/${slug(n)}">${n}</a>`).join('')}</nav>
<main><p><a href="/console/">All apps</a> · Signed in as dev@acme.test · <a href="/console/x/help">Help</a></p>${main}</main>`,
  );

const checks = (name, items) => items.map((i) => `<label><input type="checkbox" name="${name}" value="${i}"> ${i}</label>`).join('');
const collect = `[...document.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value)`;

const consolePages = {
  '/console/': () =>
    shell(
      'All apps',
      `<h1>All apps</h1><table><tr><th>App</th><th>Package</th><th>Installs</th><th>Status</th><th>Updated</th><th></th></tr>${APPS.map(
        (a, i) => `<tr><td>${a}</td><td>com.acme.${slug(a)}</td><td>${(i + 3) * 1370}</td><td>Live</td><td>${(i % 27) + 1} Oct 2026</td><td><a href="/console/app/${slug(a)}" aria-label="Manage ${a}">Manage</a></td></tr>`,
      ).join('')}</table>`,
    ),
  '/console/app/kavyam': () =>
    shell(
      'Kavyam',
      `<h1>Kavyam</h1><p>com.acme.kavyam · Live on Production · 41,100 installs</p><h2>Release</h2><ul>${['Production', 'Testing', 'Pre-registration', 'Reach and devices', 'App bundles'].map((n) => `<li><a href="/console/app/kavyam/${slug(n)}">${n}</a></li>`).join('')}</ul>
<h2>Recent activity</h2><table><tr><th>When</th><th>Who</th><th>What</th></tr>${Array.from({ length: 25 }, (_, i) => `<tr><td>${i + 1} Oct 2026</td><td>dev${i % 4}@acme.test</td><td>Updated <a href="/console/x/activity-${i}">item ${i}</a></td></tr>`).join('')}</table>`,
    ),
  '/console/app/kavyam/testing': () =>
    shell(
      'Testing',
      `<h1>Testing</h1><table><tr><th>Track</th><th>Testers</th><th>Latest</th></tr>${['Open testing', 'Closed testing', 'Internal testing'].map((t, i) => `<tr><td><a href="/console/app/kavyam/testing/${slug(t)}">${t}</a></td><td>${(i + 1) * 40}</td><td>2.1${i}.0</td></tr>`).join('')}</table>`,
    ),
  '/console/app/kavyam/testing/internal-testing': () =>
    shell(
      'Internal testing',
      `<h1>Internal testing</h1><p><a href="/console/release/details">Create new release</a></p><h2>Release history</h2><table><tr><th>Release</th><th>Date</th><th>Status</th><th></th></tr>${Array.from({ length: 30 }, (_, i) => `<tr><td>2.${13 - (i % 13)}.${i}</td><td>${(i % 27) + 1} Sep 2026</td><td>Superseded</td><td><a href="/console/x/release-${i}">View</a></td></tr>`).join('')}</table>`,
    ),
  '/console/release/details': () =>
    shell(
      'New release',
      `<h1>Create internal testing release</h1><form onsubmit="return false">
<label>App bundle <input type="file" id="bundle" accept=".aab"></label>
<label>Release name <input id="rname"></label>
<label>Release notes <textarea id="notes"></textarea></label>
<button type="button" id="${variant === 'b' ? 'pick' : 'go'}">${variant === 'b' ? 'Pick who gets it' : 'Continue to testers'}</button></form>
<script>document.querySelector('form button').onclick = () => { const f = document.getElementById('bundle').files[0];
Object.assign(draft, { file: f && f.name, size: f && f.size, name: document.getElementById('rname').value, notes: document.getElementById('notes').value }); save(); location.href = '/console/release/testers'; };</script>`,
    ),
  '/console/release/testers': () =>
    shell(
      'Testers',
      `<h1>Choose testers</h1><form onsubmit="return false">${checks('lists', LISTS)}<label>Feedback URL <input id="feedback"></label><button type="button" id="go">Continue to countries</button></form>
<script>document.getElementById('go').onclick = () => { draft.lists = ${collect}; draft.feedback = document.getElementById('feedback').value; save(); location.href = '/console/release/countries'; };</script>`,
    ),
  '/console/release/countries': () =>
    shell(
      'Countries',
      `<h1>Countries and regions</h1><form onsubmit="return false">${checks('countries', COUNTRIES)}<label>Rollout percentage <select id="pct">${[5, 10, 20, 50, 100].map((p) => `<option>${p}%</option>`).join('')}</select></label><button type="button" id="go">Continue to review</button></form>
<script>document.getElementById('go').onclick = () => { draft.countries = ${collect}; draft.pct = document.getElementById('pct').value; save(); location.href = '/console/release/review'; };</script>`,
    ),
  '/console/release/review': () =>
    shell(
      'Review',
      `<h1>Review release</h1><p id="summary"></p><form onsubmit="return false">
<label>Release owner <select id="owner">${['Arjun', 'Meera', 'Sana', 'Tom'].map((o) => `<option>${o}</option>`).join('')}</select></label>
<label>Ticket <input id="ticket"></label>
<label><input type="checkbox" id="ack"> I have tested this build</label>
<button type="button" id="rollout">Start rollout to Internal testing</button></form><p id="status" role="status"></p>
<script>document.getElementById('summary').textContent = (draft.name || '') + ' · ' + (draft.file || 'no bundle') + ' · ' + (draft.countries || []).length + ' countries';
document.getElementById('rollout').onclick = async () => { const $ = (i) => document.getElementById(i);
await fetch('/__rollout', { method: 'POST', body: JSON.stringify({ task: 'console', ...draft, owner: $('owner').value, ticket: $('ticket').value, ack: $('ack').checked }) });
$('status').textContent = 'Rollout started: ' + draft.name; };</script>`,
    ),
};

const generic = (p) => shell(p.split('/').pop(), `<h1>${p.split('/').pop()}</h1><p>Nothing here for this task.</p>`);

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (url.pathname === '/__reset') {
        log = [];
        variant = url.searchParams.get('variant') ?? 'a';
        return send(200, 'text/plain', 'ok');
      }
      if (url.pathname === '/__rollout') {
        log.push(JSON.parse(body));
        return send(200, 'text/plain', 'ok');
      }
      send(404, 'text/plain', 'no');
    });
    return;
  }
  if (url.pathname === '/__log') return send(200, 'application/json', JSON.stringify(log));
  const render = small[url.pathname] ?? consolePages[url.pathname] ?? (url.pathname.startsWith('/console/') ? () => generic(url.pathname) : undefined);
  if (!render) return send(404, 'text/plain', 'Not found');
  send(200, 'text/html; charset=utf-8', render());
}).listen(PORT, '127.0.0.1', () => console.log(`bench site on ${PORT}`));
