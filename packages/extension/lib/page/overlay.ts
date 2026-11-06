import { accessibleName } from './dom';

// What a page shows while a routine or an agent drives it: a glow along the edges, a cursor that glides to
// each element, and an outline on the element itself. It lives in a closed shadow root, ignores the mouse, and
// is hidden for every screenshot so the replay checks never see it.

export type GlowMode = 'run' | 'paused';

const ACCENT = '#6B66FF';
const VERBS: Record<string, string> = { click: 'Click', type: 'Type', clear: 'Clear', select: 'Select', upload: 'Upload' };

// A constructed stylesheet is not subject to the page's style-src, which an inline <style> would be.
const CSS = `
:host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict}
*{box-sizing:border-box}
.edge{position:absolute;inset:0;opacity:0;transition:opacity .4s cubic-bezier(.2,.8,.2,1);--glow:rgba(107,102,255,.5)}
.edge.on{opacity:1;animation:breathe 3.2s ease-in-out infinite}
.edge.paused{--glow:rgba(240,176,74,.55)}
.edge i{position:absolute;display:block}
.t{left:0;right:0;top:0;height:56px;background:linear-gradient(var(--glow),transparent)}
.b{left:0;right:0;bottom:0;height:56px;background:linear-gradient(0deg,var(--glow),transparent)}
.l{top:0;bottom:0;left:0;width:56px;background:linear-gradient(90deg,var(--glow),transparent)}
.r{top:0;bottom:0;right:0;width:56px;background:linear-gradient(270deg,var(--glow),transparent)}
@keyframes breathe{50%{opacity:.62}}
.ring{position:absolute;left:0;top:0;border-radius:6px;border:2px solid ${ACCENT};background:rgba(107,102,255,.1);box-shadow:0 0 0 1px rgba(255,255,255,.55),0 0 0 5px rgba(107,102,255,.16);opacity:0;transition:opacity .15s ease-out}
.ring.on{opacity:1}
.ring.off{transition-duration:.3s}
.cur{position:absolute;left:0;top:0;opacity:0;transition:opacity .2s ease-out;will-change:transform}
.cur.on{opacity:1}
.cur svg{display:block;filter:drop-shadow(0 2px 4px rgba(20,19,31,.4))}
.chip{position:absolute;left:18px;top:14px;white-space:nowrap;padding:3px 8px;border-radius:6px;background:${ACCENT};color:#fff;font:500 11px/16px system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 2px 6px rgba(20,19,31,.25)}
.pulse{position:absolute;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid ${ACCENT};opacity:0}
@media (prefers-reduced-motion:reduce){.edge.on{animation:none}.edge,.ring,.cur{transition:none}}
`;

interface Parts {
  host: HTMLElement;
  edge: HTMLElement;
  ring: HTMLElement;
  cur: HTMLElement;
  chip: HTMLElement;
  pulse: HTMLElement;
}

let parts: Parts | undefined;
let mode: GlowMode | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let linger: ReturnType<typeof setTimeout> | undefined;
let at: { x: number; y: number } | undefined;
let veiled = false;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function div(cls: string, ...kids: Node[]) {
  const d = document.createElement('div');
  d.className = cls;
  d.append(...kids);
  return d;
}

function build(): Parts {
  const host = document.createElement('div');
  host.id = 'agentic-routines-overlay';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];

  const edge = div('edge', ...['t', 'b', 'l', 'r'].map((c) => Object.assign(document.createElement('i'), { className: c })));
  const ring = div('ring');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('viewBox', '0 0 22 22');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3 2l15 7.2-6.4 1.6L9 17.5z');
  path.setAttribute('fill', ACCENT);
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  const chip = div('chip');
  const cur = div('cur', svg, chip);
  const pulse = div('pulse');
  root.append(edge, ring, pulse, cur);
  host.style.display = veiled ? 'none' : '';
  document.documentElement.append(host);
  return { host, edge, ring, cur, chip, pulse };
}

function ensure(): Parts {
  if (parts && !parts.host.isConnected) parts = undefined;
  return (parts ??= build());
}

function teardown() {
  parts?.host.remove();
  parts = undefined;
  at = undefined;
}

export const active = () => mode !== undefined;

/** Turn the glow on, change its colour, or off. It also ends by itself after ttl, so a page left behind does not glow for ever. */
export function glow(next: GlowMode | 'off', ttl = 8000) {
  clearTimeout(expiry);
  if (next === 'off') {
    mode = undefined;
    if (!parts) return;
    const p = parts;
    p.edge.classList.remove('on');
    p.cur.classList.remove('on');
    p.ring.classList.remove('on');
    setTimeout(() => {
      if (!mode && parts === p) teardown();
    }, 450);
    return;
  }
  mode = next;
  const p = ensure();
  p.edge.classList.toggle('paused', next === 'paused');
  p.edge.classList.add('on');
  // A pause waits for a person, so nothing moves.
  if (next === 'paused') {
    p.cur.classList.remove('on');
    p.ring.classList.remove('on');
  }
  expiry = setTimeout(() => glow('off'), ttl);
}

/** Hide everything while the browser takes a picture of the page. */
export function veil(on: boolean) {
  veiled = on;
  if (parts) parts.host.style.display = on ? 'none' : '';
}

/** Move the cursor onto an element and outline it. Resolves when the cursor has arrived, so the action lands with it. */
export async function aim(el: Element, action: string) {
  if (mode !== 'run') return;
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return;
  const p = ensure();
  clearTimeout(linger);

  const x = Math.round(r.x + Math.min(r.width / 2, 140));
  const y = Math.round(r.y + r.height / 2);
  const label = accessibleName(el).replace(/\s+/g, ' ').trim();
  p.chip.textContent = [VERBS[action] ?? action, label.length > 28 ? label.slice(0, 27) + '…' : label].filter(Boolean).join(' · ');

  Object.assign(p.ring.style, { transform: `translate(${r.x - 3}px, ${r.y - 3}px)`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  p.ring.classList.remove('off');
  p.ring.classList.add('on');

  const from = at ?? { x: Math.max(24, innerWidth - 120), y: 48 };
  const dist = Math.hypot(x - from.x, y - from.y);
  const ms = reduced() ? 0 : Math.min(600, Math.max(250, 220 + dist * 0.35));
  p.cur.classList.add('on');
  // Nobody sees a page that is behind another tab, and its timers run slowly: place the cursor and go.
  if (document.hidden) {
    at = { x, y };
    p.cur.style.transform = `translate(${x}px, ${y}px)`;
    return;
  }
  const move = p.cur.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${x}px, ${y}px)` }], {
    duration: ms,
    easing: 'cubic-bezier(.65,0,.35,1)',
    fill: 'forwards',
  });
  at = { x, y };
  // The cursor stays where it landed for the next step to start from.
  // A page that is not being drawn (a window on another workspace, a background tab) never finishes an animation, so
  // the cursor may not hold the action up for longer than its own trip. Timers still run there.
  await Promise.race([move.finished.catch(() => {}), new Promise((r) => setTimeout(r, ms + 80))]);
  try {
    move.commitStyles?.();
  } catch {
    // The cursor is not rendered (hidden for a picture, or the page is not drawing): the line below places it.
  }
  move.cancel();
  p.cur.style.transform = `translate(${x}px, ${y}px)`;

  if (!reduced() && action !== 'type' && action !== 'select') {
    Object.assign(p.pulse.style, { left: `${x}px`, top: `${y}px` });
    p.pulse.animate([{ opacity: 0.9, transform: 'scale(.5)' }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  // The outline outlasts the action a moment, then fades.
  linger = setTimeout(() => {
    p.ring.classList.add('off');
    p.ring.classList.remove('on');
  }, 600);
}
