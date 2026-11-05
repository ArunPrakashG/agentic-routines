// What a hook is allowed to be, as far as a file can say. The sandbox that runs one and the directives it
// may return live in the extension; this is the part every reader of a routine shares.

export const HOOK_EVENTS = [
  'run.start',
  'run.end',
  'step.before',
  'step.after',
  'action.click.before',
  'action.click.after',
  'action.type.before',
  'action.type.after',
  'action.select.before',
  'action.select.after',
  'action.upload.before',
  'action.upload.after',
  'action.navigate.before',
  'action.navigate.after',
  'action.press.before',
  'action.press.after',
  'action.read.before',
  'action.read.after',
  'page.load',
  'step.changed',
  'pause.reached',
  'pause.approved',
  'error',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_LIMITS = {
  /** Characters of code in one hook. */
  code: 8_000,
  /** Characters of code in all the hooks of one routine. */
  total: 32_000,
  /** Hooks on one routine: one per event. */
  count: HOOK_EVENTS.length,
  /** Milliseconds a hook may run before it is cut off. */
  ms: 500,
  /** Characters of context handed in and of output handed back. */
  context: 120_000,
  output: 16_000,
  /** Directives one hook may return, and what each may carry. */
  directives: 20,
  text: 500,
  value: 4_096,
  /** Longest single wait, and the most waiting one hook run may ask for. */
  wait: 5_000,
  waitTotal: 10_000,
  /** Hook runs in one replay, so a hook that fires on every event cannot hold a run for ever. */
  runs: 400,
};

export const isHookEvent = (s: string): s is HookEvent => (HOOK_EVENTS as readonly string[]).includes(s);

/** The hooks of a routine: event name to code. One hook per event; it can do as many things as it likes. */
export type Hooks = Partial<Record<HookEvent, string>>;

/** Why a set of hooks cannot be used, one line each. Empty when they are fine. */
export function checkHooks(h: unknown): string[] {
  if (h === undefined || h === null) return [];
  if (typeof h !== 'object' || Array.isArray(h)) return ['Hooks must be a set of events, each with the code to run.'];
  const out: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(h)) {
    if (!isHookEvent(k)) out.push(`“${k}” is not an event.`);
    else if (typeof v !== 'string' || !v.trim()) out.push(`The hook for ${k} must be code, as text.`);
    else if (v.length > HOOK_LIMITS.code) out.push(`The hook for ${k} is ${v.length} characters, at most ${HOOK_LIMITS.code}.`);
    else total += v.length;
  }
  if (total > HOOK_LIMITS.total) out.push(`All the hooks together are ${total} characters, at most ${HOOK_LIMITS.total}.`);
  return out;
}

/** The hooks as a file keeps them: only known events with text code, nothing else. */
export function readHooks(h: unknown): Hooks | undefined {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return undefined;
  const out: Hooks = {};
  for (const [k, v] of Object.entries(h)) if (isHookEvent(k) && typeof v === 'string' && v.trim()) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/**
 * A fingerprint of every hook a routine carries. Approval is pinned to it: if one character of one hook
 * changes, or an event is added, the hash is different and the person is asked again.
 */
export async function hookHash(h: Hooks | undefined): Promise<string> {
  const events = Object.keys(h ?? {}).sort();
  const text = JSON.stringify(events.map((e) => [e, (h as Record<string, string>)[e]]));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- what a hook sees ----------

/** One interactive element, as the hook may see it. A `ref` is how a directive points at it. */
export interface HookElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  /** The current value of a field. Blank for passwords and files. */
  value?: string;
  rect: { x: number; y: number; w: number; h: number };
  disabled?: boolean;
}

/** A read-only look at the page, taken in the page and trimmed. Passwords and files are blanked. */
export interface HookDom {
  title: string;
  /** The page’s markup without scripts, styles and images, cut at a size. */
  html: string;
  /** The interactive elements, with the refs a directive may use. */
  outline: HookElement[];
  /** The element the step is about, when it was found. */
  target?: HookElement & { html: string };
}

export interface HookContext {
  event: HookEvent;
  routine: { name: string; version: number; site: string; description: string };
  /** Values the person or agent gave. Secrets and typed passwords are never in here. */
  params: Record<string, string>;
  /** The step this is about, with secrets left as {{secret:name}}. */
  step?: { n: number; total: number; action: string; label: string; value?: string; url?: string; pause: boolean };
  url: string;
  dom?: HookDom;
  /** Event specific: the status and error at run.end and error, the reason at pause.reached, the old and new URL at page.load. */
  detail?: Record<string, string | number | boolean | undefined>;
}

// ---------- what a hook may ask for ----------

export type Directive =
  | { do: 'skip' }
  | { do: 'set'; value: string; param?: string }
  | { do: 'click'; ref: string }
  | { do: 'type'; ref: string; text: string }
  | { do: 'wait'; ms: number }
  | { do: 'goto'; url: string }
  | { do: 'note'; text: string }
  | { do: 'fail'; reason: string }
  | { do: 'pause'; reason: string };

export const DIRECTIVES = ['skip', 'set', 'click', 'type', 'wait', 'goto', 'note', 'fail', 'pause'] as const;

/** Where a directive makes sense. skip and set change the step that is about to run. */
const BEFORE = /^(step\.before|action\.[a-z]+\.before)$/;

export interface Refused {
  /** The directive as the hook wrote it, shortened. */
  directive: string;
  why: string;
}

const REF = /^ref_\d{1,6}$/;
const short = (v: unknown, n = 80) => {
  let t: string;
  try {
    t = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    t = String(v);
  }
  t = (t ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * Turns whatever a hook returned into the directives the extension will consider, and a list of what it
 * refused. Anything that is not on the list, anything with a field it does not know, and anything over a
 * limit is refused with a reason. A function or code in the output is never read as code.
 */
export function readDirectives(raw: unknown, event: HookEvent, site: { host: string; http: boolean }): { ok: Directive[]; refused: Refused[] } {
  const ok: Directive[] = [];
  const refused: Refused[] = [];
  const no = (d: unknown, why: string) => refused.push({ directive: short(d), why });
  if (raw === undefined || raw === null) return { ok, refused };
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > HOOK_LIMITS.directives) no(`${list.length} directives`, `At most ${HOOK_LIMITS.directives} directives; the rest were dropped.`);
  let waiting = 0;
  let went = false;
  for (const d of list.slice(0, HOOK_LIMITS.directives)) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      no(d, 'Not a directive. Return objects like { do: "note", text: "…" }.');
      continue;
    }
    const o = d as Record<string, unknown>;
    const kind = o.do;
    const str = (k: string, max: number): string | null => (typeof o[k] === 'string' && (o[k] as string).length <= max ? (o[k] as string) : null);
    const known = (keys: string[]) => Object.keys(o).every((k) => k === 'do' || keys.includes(k));
    switch (kind) {
      case 'skip':
        if (!BEFORE.test(event)) no(d, 'skip works only before a step or an action.');
        else if (!known([])) no(d, 'skip takes nothing else.');
        else ok.push({ do: 'skip' });
        break;
      case 'set': {
        const value = str('value', HOOK_LIMITS.value);
        const param = o.param === undefined ? undefined : str('param', 40);
        if (value === null) no(d, `set needs a value of text, at most ${HOOK_LIMITS.value} characters.`);
        else if (o.param !== undefined && (param === null || !/^[a-z0-9_]{1,40}$/.test(param ?? ''))) no(d, 'param must be the name of one of the routine’s parameters.');
        else if (param === undefined && !BEFORE.test(event)) no(d, 'set without a param works only before a step or an action.');
        else if (!known(['value', 'param'])) no(d, 'set takes value and, optionally, param.');
        else ok.push({ do: 'set', value, ...(param ? { param } : {}) });
        break;
      }
      case 'click': {
        const ref = str('ref', 12);
        if (!ref || !REF.test(ref)) no(d, 'click needs a ref from the page outline, like "ref_12".');
        else if (!known(['ref'])) no(d, 'click takes a ref only.');
        else ok.push({ do: 'click', ref });
        break;
      }
      case 'type': {
        const ref = str('ref', 12);
        const text = str('text', HOOK_LIMITS.value);
        if (!ref || !REF.test(ref) || text === null) no(d, 'type needs a ref from the page outline and the text to type.');
        else if (!known(['ref', 'text'])) no(d, 'type takes a ref and text only.');
        else ok.push({ do: 'type', ref, text });
        break;
      }
      case 'wait': {
        const ms = o.ms;
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) no(d, 'wait needs ms, a number of milliseconds.');
        else if (!known(['ms'])) no(d, 'wait takes ms only.');
        else {
          const cut = Math.min(Math.floor(ms), HOOK_LIMITS.wait, HOOK_LIMITS.waitTotal - waiting);
          if (cut <= 0) no(d, `A hook may wait ${HOOK_LIMITS.waitTotal / 1000} seconds in all.`);
          else {
            waiting += cut;
            ok.push({ do: 'wait', ms: cut });
            if (cut < ms) no(d, `Waited ${cut} ms, the most it may.`);
          }
        }
        break;
      }
      case 'goto': {
        const url = str('url', 2048);
        let why = '';
        if (!url) why = 'goto needs a url of text.';
        else if (went) why = 'One goto for each run of a hook.';
        else if (!known(['url'])) why = 'goto takes a url only.';
        else {
          try {
            const u = new URL(url);
            const h = u.hostname.toLowerCase();
            if (u.username || u.password) why = 'No credentials in an address.';
            else if (u.protocol !== 'https:' && !(u.protocol === 'http:' && site.http)) why = 'Only https addresses, or http where the routine’s own site is http.';
            else if (h !== site.host && !h.endsWith('.' + site.host)) why = `goto stays on ${site.host}.`;
          } catch {
            why = 'Not an address.';
          }
        }
        if (why) no(d, why);
        else {
          went = true;
          ok.push({ do: 'goto', url: url! });
        }
        break;
      }
      case 'note':
      case 'fail':
      case 'pause': {
        const key = kind === 'note' ? 'text' : 'reason';
        const t = str(key, HOOK_LIMITS.text);
        if (t === null || !t.trim()) no(d, `${kind} needs ${key}, text of at most ${HOOK_LIMITS.text} characters.`);
        else if (!known([key])) no(d, `${kind} takes ${key} only.`);
        else ok.push(kind === 'note' ? { do: 'note', text: t } : { do: kind, reason: t });
        break;
      }
      default:
        no(d, `“${short(kind, 30)}” is not a directive. They are: ${DIRECTIVES.join(', ')}.`);
    }
  }
  return { ok, refused };
}

/** One run of one hook, as the run result reports it. */
export interface HookLogEntry {
  event: HookEvent;
  step?: number;
  ms: number;
  /** What was done, in words. */
  done: string[];
  /** What was refused, with the reason. */
  refused: Refused[];
  /** The hook threw, ran out of time, or returned too much. */
  error?: string;
}

export type HookState = 'none' | 'on' | 'off' | 'unsupported';

/** What the run result says about hooks. Absent when the routine has none. */
export interface HookReport {
  state: Exclude<HookState, 'none'>;
  /** Why they are off, in words the person and the agent can read. */
  reason?: string;
  runs: number;
  log: HookLogEntry[];
  /** Text hooks asked to be shown. Written by the routine’s author; the agent sees it in the envelope. */
  notes: string[];
}
