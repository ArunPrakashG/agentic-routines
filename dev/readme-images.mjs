// Builds the images in docs/images from the raw frames dev/shots.mjs captured (light/ and dark/ folders), and
// takes the website's home page from apps/site/dist. Needs Chromium (Playwright's is fine), ffmpeg and ImageMagick.
//   node dev/readme-images.mjs <frames-dir> [out-dir]
// dev/readme-images.sh runs the whole chain, including the captures.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FRAMES = resolve(process.argv[2] ?? '');
const OUT = resolve(process.argv[3] ?? join(ROOT, 'docs/images'));
if (!process.argv[2]) throw new Error('usage: node dev/readme-images.mjs <frames-dir> [out-dir]');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FONTS = join(ROOT, 'apps/site/node_modules/@fontsource/schibsted-grotesk/files');
const work = mkdtempSync(join(tmpdir(), 'ar-images-'));

// ---------- Chromium ----------
const chromePath =
  process.env.AR_CHROME ??
  readdirSync(join(homedir(), '.cache/ms-playwright'))
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .map((d) => join(homedir(), '.cache/ms-playwright', d, 'chrome-linux64/chrome'))
    .filter(existsSync)
    .pop();
if (!chromePath) throw new Error('No Chromium found. Run: npx playwright install chromium');
const PORT = Number(process.env.AR_IMAGES_CDP_PORT ?? 9611);
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(150);
  target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const wait = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) (wait.get(m.id)(m), wait.delete(m.id));
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    wait.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });

// Loads a page, waits for its images and fonts, and returns a PNG of the box at `#shot` (or the viewport).
async function render(url, { width, height, scale = 1, scheme = 'light', selector, still = false }) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, ...(still ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [])] });
  await send('Page.navigate', { url });
  await sleep(300);
  for (let i = 0; i < 100; i++) {
    const ready = await send('Runtime.evaluate', { expression: `document.readyState === 'complete' && [...document.images].every((i) => i.complete) && document.fonts.status === 'loaded'`, returnByValue: true });
    if (ready.result.value) break;
    await sleep(100);
  }
  await sleep(700);
  let clip;
  if (selector) {
    const r = await send('Runtime.evaluate', { expression: `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`, returnByValue: true });
    const b = JSON.parse(r.result.value);
    clip = { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 };
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  return Buffer.from(data, 'base64');
}

// ---------- layout ----------
const THEME = {
  light: { desk: 'linear-gradient(135deg,#E8E7F6,#F6F6FA)', bar: '#FFFFFF', line: '#D9D8E8', ink: '#14131F', mute: '#6A6880', shadow: '0 18px 50px rgba(53,48,224,.18), 0 2px 8px rgba(20,19,31,.12)', card: '#FFFFFF', accent: '#3530E0' },
  dark: { desk: 'linear-gradient(135deg,#0B0A12,#17162A)', bar: '#1C1B2B', line: '#2E2D45', ink: '#ECECF5', mute: '#9A98B2', shadow: '0 18px 50px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4)', card: '#191825', accent: '#9D99FF' },
};
const fontFace = `
@font-face{font-family:SG;font-weight:400;src:url(file://${FONTS}/schibsted-grotesk-latin-400-normal.woff2)}
@font-face{font-family:SG;font-weight:500;src:url(file://${FONTS}/schibsted-grotesk-latin-500-normal.woff2)}
@font-face{font-family:SG;font-weight:600;src:url(file://${FONTS}/schibsted-grotesk-latin-600-normal.woff2)}`;
const base = (t) => `<!doctype html><meta charset="utf-8"><style>${fontFace}
*{box-sizing:border-box}body{margin:0;font-family:SG,system-ui,sans-serif;color:${t.ink}}
.desk{background:${t.desk};padding:44px;display:block;width:max-content}</style>`;

// A browser window: the page on the left, the side panel on the right.
const windowHtml = (scheme, page, panel) => {
  const t = THEME[scheme];
  return `${base(t)}<style>
.win{width:1160px;border-radius:14px;overflow:hidden;border:1px solid ${t.line};box-shadow:${t.shadow};background:${t.bar}}
.top{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid ${t.line};background:${t.bar}}
.top i{width:12px;height:12px;border-radius:50%;background:${t.line}}
.top b{flex:1;text-align:center;font-weight:500;font-size:13px;color:${t.mute};margin-right:44px}
.body{display:flex}.body img{display:block;height:640px}
.body img.pg{width:760px}.body img.pn{width:400px;border-left:1px solid ${t.line}}
</style><div class="desk" id="shot"><div class="win"><div class="top"><i></i><i></i><i></i><b>Acme Console (test site)</b></div>
<div class="body"><img class="pg" src="file://${page}"><img class="pn" src="file://${panel}"></div></div></div>`;
};

// Three panel screens with a caption each.
const stepsHtml = (scheme, items) => {
  const t = THEME[scheme];
  return `${base(t)}<style>
.row{display:flex;gap:28px}.col{width:300px}
.shot{border:1px solid ${t.line};border-radius:12px;overflow:hidden;box-shadow:${t.shadow};background:${t.card}}
.shot img{display:block;width:300px;height:auto}
.n{font-size:13px;font-weight:600;color:${t.accent};letter-spacing:.04em;margin:18px 0 2px}
.c{font-size:18px;font-weight:600}.d{font-size:14px;color:${t.mute};margin-top:2px;line-height:1.4}
</style><div class="desk" id="shot"><div class="row">${items
    .map((x, i) => `<div class="col"><div class="shot"><img src="file://${x.src}"></div><div class="n">0${i + 1}</div><div class="c">${x.title}</div><div class="d">${x.text}</div></div>`)
    .join('')}</div></div>`;
};

const encode = (png, out, quality = 88) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-c:v', 'libwebp', '-quality', String(quality), '-compression_level', '6', out]);
const html = (name, body) => {
  const p = join(work, name);
  writeFileSync(p, body);
  return `file://${p}`;
};
// The glow tints the page's edge, so the edge differs from a point just inside it. Needs ImageMagick.
const hasGlow = (png) => {
  const px = (x) => execFileSync('magick', [png, '-format', `%[fx:int(255*p{${x},640}.r)] %[fx:int(255*p{${x},640}.g)] %[fx:int(255*p{${x},640}.b)]`, 'info:']).toString().trim().split(' ').map(Number);
  const [a, b] = [px(10), px(220)];
  return a.some((v, i) => Math.abs(v - b[i]) > 10);
};
const frame = (scheme, name) => join(FRAMES, scheme, `${name}.png`);

for (const scheme of ['light', 'dark']) {
  const size = { width: 1250, height: 780, scale: 1.5, scheme, selector: '#shot' };
  // Stills: a moment of the replay, and the pause before the last step.
  // The extension hides its glow for its own screenshots, and a capture can land in that gap. Those frames are left out.
  const frames = readdirSync(join(FRAMES, scheme)).filter((f) => /^frame-\d+-panel\.png$/.test(f)).map((f) => f.slice(6, 9)).sort().filter((n) => hasGlow(frame(scheme, `frame-${n}-page`)));
  const mid = frames[Math.floor(frames.length * 0.5)];
  const still = async (name, page, panel) => {
    const png = await render(html(`${name}-${scheme}.html`, windowHtml(scheme, page, panel)), size);
    writeFileSync(join(work, `${name}-${scheme}.png`), png);
    encode(join(work, `${name}-${scheme}.png`), join(OUT, `${name}-${scheme}.webp`));
    console.log('wrote', `${name}-${scheme}.webp`);
  };
  await still('replay', frame(scheme, `frame-${mid}-page`), frame(scheme, `frame-${mid}-panel`));
  await still('pause', frame(scheme, 'page-paused'), frame(scheme, 'panel-paused'));

  // The three steps.
  const png = await render(
    html(`steps-${scheme}.html`, stepsHtml(scheme, [
      { src: frame(scheme, 'panel-recorded'), title: 'Record', text: 'Your agent does the task once. Every run is recorded on your computer.' },
      { src: frame(scheme, 'panel-save'), title: 'Refine', text: 'Typed values become parameters, and a direct address replaces the click-through.' },
      { src: frame(scheme, 'panel-paused'), title: 'Replay', text: 'One tool call, no model. It pauses before the step that cannot be undone.' },
    ])),
    { width: 1080, height: 800, scale: 1.5, scheme, selector: "#shot" },
  );
  writeFileSync(join(work, `steps-${scheme}.png`), png);
  encode(join(work, `steps-${scheme}.png`), join(OUT, `steps-${scheme}.webp`));
  console.log('wrote', `steps-${scheme}.webp`);

  // The animation: every captured frame of the replay, then a hold on the last one.
  const dir = join(work, `anim-${scheme}`);
  mkdirSync(dir, { recursive: true });
  const used = frames;
  for (let i = 0; i < used.length; i++) {
    const png = await render(html(`a-${scheme}-${i}.html`, windowHtml(scheme, frame(scheme, `frame-${used[i]}-page`), frame(scheme, `frame-${used[i]}-panel`))), { width: 1250, height: 780, scale: 1, scheme, selector: '#shot' });
    writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.png`), png);
  }
  const last = used.length - 1;
  for (let i = 1; i <= 6; i++) writeFileSync(join(dir, `f${String(last + i).padStart(3, '0')}.png`), readFileSync(join(dir, `f${String(last).padStart(3, '0')}.png`)));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '3', '-i', join(dir, 'f%03d.png'), '-c:v', 'libwebp_anim', '-quality', '75', '-loop', '0', join(OUT, `replay-${scheme}.webp`)]);
  console.log('wrote', `replay-${scheme}.webp (animated)`);
}

// ---------- the website ----------
const dist = join(ROOT, 'apps/site/dist');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p.endsWith('/')) p += 'index.html';
  const f = join(dist, p);
  const file = existsSync(f) ? f : existsSync(`${f}.html`) ? `${f}.html` : undefined;
  if (!file) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;
// The home page's hero is dark in both schemes. Reduced motion shows the finished chart.
const png = await render(`${SITE}/`, { width: 1280, height: 800, scale: 1.5, still: true });
writeFileSync(join(work, 'site.png'), png);
encode(join(work, 'site.png'), join(OUT, 'site.webp'), 86);
console.log('wrote site.webp');
server.close();

copy(join(ROOT, 'design/icon.svg'), join(OUT, 'logo.svg'));
function copy(from, to) {
  writeFileSync(to, readFileSync(from));
}

ws.close();
chrome.kill();
rmSync(work, { recursive: true, force: true });
process.exit(0);
