import { platform } from '../platform';
import { unlessDialog } from './dialogs';

// What a page says to its console and sends over the network, and running a script in it. All of it can hold what opens the
// person's accounts, so what looks like that is hidden before anything leaves here. It stops accidents, not someone who is trying.

const SECRET: [RegExp, string][] = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[hidden token]'],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 [hidden]'],
  [/\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[\w-]{16,}/g, '[hidden key]'],
  [/\b(ghp|gho|ghs|github_pat|xox[abprs]|AKIA|ASIA|AIza|ya29)[\w-]{12,}/g, '[hidden key]'],
  [/\b([\w-]*(?:cookie|authorization|password|passwd|secret|token|api[_-]?key|session[_-]?id|sid)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, '$1$2[hidden]'],
  // What document.cookie gives: name=value; name=value.
  [/(?:\b[\w.-]{1,64}=[^\s;]{1,4096};\s*){2,}\b[\w.-]{1,64}=[^\s;]{0,4096}/g, '[hidden, looks like cookies]'],
];

export function scrub(text: string): { text: string; hidden: number } {
  let hidden = 0;
  let out = text;
  for (const [re, to] of SECRET)
    out = out.replace(re, (...m) => {
      hidden++;
      // A replacement with its groups put back.
      return to.replace(/\$(\d)/g, (_, n) => String(m[Number(n)] ?? ''));
    });
  return { text: out, hidden };
}

/** An address with what only that person's session should have taken out: query values, logins, what follows the hash, long opaque parts of the path. */
export function scrubUrl(raw: string) {
  try {
    const u = new URL(raw);
    if (!/^https?:|^wss?:/.test(u.protocol)) return `${u.protocol}…`;
    const path = u.pathname.split('/').map((p) => (/^[\w.~-]{32,}$/.test(p) ? '…' : p)).join('/');
    const query = [...u.searchParams.keys()].map((k) => `${k}=…`).join('&');
    return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return '[an address that could not be read]';
  }
}

interface Line {
  level: string;
  text: string;
  at: number;
}
interface Request {
  method: string;
  url: string;
  type: string;
  status?: number;
  mime?: string;
  failed?: string;
  at: number;
}
interface Watch {
  on: boolean;
  /** The connection ended for a while, so there is a gap. */
  lapsed: boolean;
  lines: Line[];
  requests: Map<string, Request>;
  /** The network has been read here before, not only the console. */
  netRead?: boolean;
}

const MAX = 500;
const TEXT_MAX = 2000;
const watches = new Map<number, Watch>();

function push(w: Watch, line: Line) {
  w.lines.push(line);
  if (w.lines.length > MAX) w.lines.shift();
}

const arg = (a: any) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type ?? ''));

export function watchLogs() {
  platform.onEvent?.((tabId, method, p) => {
    const w = watches.get(tabId);
    if (!w) return;
    switch (method) {
      case 'detached':
        w.on = false;
        w.lapsed = true;
        break;
      case 'Runtime.consoleAPICalled':
        push(w, { level: p.type === 'warning' ? 'warn' : p.type, text: (p.args ?? []).map(arg).join(' '), at: p.timestamp ?? Date.now() });
        break;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        push(w, { level: 'error', text: d.exception?.description ?? d.text ?? 'An error', at: p.timestamp ?? Date.now() });
        break;
      }
      case 'Network.requestWillBeSent':
        w.requests.set(p.requestId, { method: p.request?.method ?? '', url: p.request?.url ?? '', type: p.type ?? '', at: Date.now() });
        if (w.requests.size > MAX) w.requests.delete(w.requests.keys().next().value!);
        break;
      case 'Network.responseReceived': {
        const r = w.requests.get(p.requestId);
        if (r) Object.assign(r, { status: p.response?.status, mime: p.response?.mimeType });
        break;
      }
      case 'Network.loadingFailed': {
        const r = w.requests.get(p.requestId);
        if (r) r.failed = p.canceled ? 'cancelled' : (p.errorText ?? 'failed');
        break;
      }
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => void watches.delete(tabId));
}

/** Starts listening the first time it is asked, not before: a page can tell, and some treat being listened to as a bot. */
async function listening(tabId: number) {
  if (!platform.cdp) throw new Error('This browser does not let an extension read this.');
  const w: Watch = watches.get(tabId) ?? { on: false, lapsed: false, lines: [], requests: new Map() };
  watches.set(tabId, w);
  const first = !w.on && !w.lapsed;
  if (!w.on) {
    // The console says again what it has kept, so what was here would come twice.
    w.lines = [];
    await platform.cdp(tabId, async (send) => {
      await send('Runtime.enable');
      await send('Network.enable');
    });
    w.on = true;
  }
  return { w, first };
}

const has = (pattern?: string) => {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, 'i');
    return (t: string) => re.test(t);
  } catch {
    return (t: string) => t.toLowerCase().includes(pattern.toLowerCase());
  }
};

export async function consoleOf(tabId: number, o: { pattern?: string; only_errors?: boolean; limit?: number; clear?: boolean }) {
  const { w } = await listening(tabId);
  const match = has(o.pattern);
  const lines = w.lines.filter((l) => (!o.only_errors || l.level === 'error') && match(l.text)).slice(-(o.limit ?? 100));
  let hidden = 0;
  const out = lines.map((l) => {
    const s = scrub(l.text.slice(0, TEXT_MAX));
    hidden += s.hidden;
    return `${l.level}: ${s.text}`;
  });
  if (o.clear) w.lines = [];
  return { lines: out, hidden, total: w.lines.length };
}

export async function networkOf(tabId: number, o: { url_contains?: string; limit?: number; clear?: boolean }) {
  const { w, first } = await listening(tabId);
  const lapsed = w.lapsed;
  w.lapsed = false;
  const shown = [...w.requests.values()].map((r) => ({ ...r, url: scrubUrl(r.url) })).filter((r) => !o.url_contains || r.url.includes(o.url_contains));
  const out = shown.slice(-(o.limit ?? 100)).map((r) => `${r.method} ${r.url} ${r.failed ?? r.status ?? 'pending'} ${r.type}${r.mime ? ` ${r.mime}` : ''}`);
  if (o.clear) w.requests.clear();
  const from = first
    ? 'Listening starts with this call, so what the page sent before is not here. Do what you want to see again, and call this after.'
    : !w.netRead
      ? 'Listening started when the console of this tab was first read, so what the page sent before that is not here.'
      : lapsed
        ? 'The connection to this tab lapsed for a while, so there is a gap.'
        : undefined;
  w.netRead = true;
  return { lines: out, note: from };
}

const SCRIPT_MS = 10_000;
const OUT_MAX = 20_000;

/** Run a script in the page itself, with everything the page can reach. Only after the person has said yes for this site. */
export async function runScript(tabId: number, code: string) {
  if (!platform.cdp) throw new Error('This browser does not let an extension run a script this way.');
  if (/document\s*\.\s*cookie|cookieStore/.test(code)) throw new Error('A script here cannot read cookies. They are what signs the person in.');
  const res = await unlessDialog(tabId, () =>
    platform.cdp!(tabId, (send) => send<any>('Runtime.evaluate', { expression: code, replMode: true, awaitPromise: true, returnByValue: true, timeout: SCRIPT_MS })),
  );
  if (res.exceptionDetails) throw new Error(`The script failed: ${scrub(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'an error').text.slice(0, TEXT_MAX)}`);
  const v = res.result;
  const raw = v.value !== undefined ? (typeof v.value === 'string' ? v.value : JSON.stringify(v.value)) : (v.description ?? v.type);
  const s = scrub(String(raw));
  return { text: s.text.slice(0, OUT_MAX), hidden: s.hidden, cut: s.text.length > OUT_MAX };
}
