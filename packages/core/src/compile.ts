import { urlPattern } from './match.ts';
import { deriveUrls } from './urls.ts';
import type { Locator, ParamSpec, RecordedEvent, Routine, Run, Step } from './types.ts';

const IRREVERSIBLE =
  /\b(start rollout|roll ?out|publish|submit|send|pay|purchase|buy|place order|checkout|delete|remove|destroy|revoke|transfer|withdraw|confirm|deploy|go live|refund)\b/i;
const CLICKABLE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'option']);

/** Would a person stop and think before clicking this? */
export function isIrreversible(e: Pick<RecordedEvent, 'action' | 'target'>): boolean {
  if (e.action !== 'click' && e.action !== 'press') return false;
  const t = e.target;
  if (!t) return false;
  if (t.role && !CLICKABLE_ROLES.has(t.role)) return false;
  if (t.tag === 'input' && !['submit', 'button'].includes(t.attrs.type ?? '')) return false;
  const label = `${t.name ?? ''} ${t.text ?? ''}`.trim();
  return IRREVERSIBLE.test(label);
}

export function snake(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return out || 'value';
}

export function siteOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function targetLabel(t?: Locator): string {
  if (!t) return '';
  return (t.name || t.text || t.attrs.placeholder || t.tag).slice(0, 80);
}

export function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.host + url.pathname + url.search;
  } catch {
    return u;
  }
}

export interface CompileOptions {
  name: string;
  description: string;
  owner?: string;
  /** Param names mapped to the value typed. Given at all, these are the only params. */
  params?: Record<string, string>;
  /** Auto-detected params to keep as typed. */
  fixed?: string[];
  /** Recorded step numbers that are not part of the task, like retries and checks. */
  leaveOut?: number[];
  /** Recorded step numbers that should click whatever is first in the list. */
  firstInList?: number[];
  body?: string;
  returns?: string;
  /** The agent that wrote the description. */
  draftedBy?: string;
}

export interface Compiled {
  routine: Routine;
  recorded: number;
  dropped: number;
  /** Values in opts.params that were never typed in this run. */
  unmatched: string[];
  /** Steps that only work on the item they were recorded on. */
  pinned: string[];
}

export function eventLabel(e: RecordedEvent): string {
  return e.action === 'navigate' ? shortUrl(e.url) : e.fieldLabel || targetLabel(e.target);
}

export const isItemUrl = (u?: string) => !!u && urlPattern(u).includes(':id');

/** Was this event just getting to the page where the work happens? */
export function isNavigation(e: RecordedEvent): boolean {
  return e.action === 'navigate' || (e.action === 'click' && !!e.navigatedTo && !isIrreversible(e));
}

/** Turns recorded events into steps one at a time, naming params and secrets as it goes. */
export function stepBuilder(opts: Pick<CompileOptions, 'params' | 'fixed'>) {
  const params: Record<string, ParamSpec> = {};
  const secrets: string[] = [];
  const byValue = new Map(Object.entries(opts.params ?? {}).map(([name, v]) => [v, snake(name)]));
  const fixed = new Set(opts.fixed ?? []);
  const used = new Set<string>();

  const uniq = (base: string, taken: Record<string, unknown> | string[]) => {
    const has = (n: string) => (Array.isArray(taken) ? taken.includes(n) : n in taken);
    let n = base;
    for (let i = 2; has(n); i++) n = `${base}_${i}`;
    return n;
  };

  function build(e: RecordedEvent, n: number, firstInList: boolean): Step {
    const step: Step = { n, action: e.action, label: eventLabel(e), target: e.target, page: e.page, crop: e.crop };
    if (e.action === 'navigate') step.url = e.url;
    if (firstInList) {
      step.pick = 'first';
      step.label = 'First in the list';
      // A crop of the recorded row says nothing about the row that is first next time.
      delete step.crop;
    }
    if (e.field === 'password') {
      const name = uniq(snake(e.fieldLabel || 'password'), secrets);
      secrets.push(name);
      step.value = `{{secret:${name}}}`;
      delete step.crop;
    } else if ((e.action === 'type' || e.action === 'upload') && e.value !== undefined) {
      const named = byValue.get(e.value);
      const auto = snake(e.fieldLabel || targetLabel(e.target) || (e.action === 'upload' ? 'file' : 'text'));
      const name = named ?? uniq(auto, params);
      if (named) used.add(e.value);
      if (!named && (opts.params || fixed.has(auto))) {
        step.value = e.value;
      } else {
        const spec: ParamSpec = { type: e.action === 'upload' ? 'file' : 'string', example: e.value };
        if (e.action === 'upload') {
          const ext = /\.[a-z0-9]+$/i.exec(e.value)?.[0];
          if (ext) spec.accept = ext.toLowerCase();
          spec.description = 'Path to the file on this machine';
        }
        if (e.fieldLabel) spec.description ??= e.fieldLabel;
        params[name] = spec;
        step.value = `{{${name}}}`;
      }
    } else if (e.value !== undefined) {
      step.value = e.value;
    }
    if (isIrreversible(e)) step.pause = 'auto';
    return step;
  }
  return { build, params, secrets, used };
}

export function compileRun(run: Run, opts: CompileOptions): Compiled {
  const numberOf = new Map(run.events.map((e, i) => [e, i + 1]));
  const leaveOut = new Set(opts.leaveOut ?? []);
  const first = new Set(opts.firstInList ?? []);
  const events = run.events.filter((e) => e.action !== 'wait' && !leaveOut.has(numberOf.get(e)!));
  if (events.length === 0) throw new Error('This run has no steps');
  for (const n of first) {
    const e = run.events[n - 1];
    if (e?.action !== 'click' || leaveOut.has(n)) throw new Error(`first_in_list: step ${n} is not a click in this routine`);
  }

  // Navigation that a direct URL can replace: everything before the first real action.
  let k = events.findIndex((e) => !isNavigation(e) || first.has(numberOf.get(e)!));
  if (k === -1) k = events.length - 1;
  const workUrl = events[k].url;
  const rest = events.slice(k).filter((e, i) => !(i === 0 && e.action === 'navigate'));

  const steps: Step[] = [{ n: 1, action: 'navigate', label: shortUrl(workUrl), url: workUrl }];
  const b = stepBuilder(opts);
  const pinned: string[] = isItemUrl(workUrl) ? [`it starts at ${shortUrl(workUrl)}`] : [];

  for (const e of rest) {
    const number = numberOf.get(e)!;
    const step = b.build(e, steps.length + 1, first.has(number));
    if (!first.has(number) && e.action === 'click' && isItemUrl(e.navigatedTo)) pinned.push(`step ${number} opens “${step.label}”`);
    steps.push(step);
  }

  const routine: Routine = {
    meta: {
      name: opts.name,
      owner: opts.owner,
      version: 1,
      site: siteOf(workUrl),
      description: opts.description.trim(),
      params: b.params,
      secrets: b.secrets,
      pauses: steps.filter((s) => s.pause).map((s) => s.n),
      urls: deriveUrls(steps, siteOf(workUrl)),
      returns: opts.returns,
      drafted_by: opts.draftedBy,
      // Where the pictures and the layout were seen, from the first step that has an element.
      viewport: rest.find((e) => e.target && e.view)?.view,
    },
    body: opts.body ?? '',
    steps,
  };
  const unmatched = Object.entries(opts.params ?? {}).filter(([, v]) => !b.used.has(v)).map(([name]) => name);
  return { routine, recorded: run.events.length, dropped: k, unmatched, pinned };
}

/** Put values into a step: "{{version_name}}" -> "2.15.0 (215)". */
export function fill(value: string | undefined, params: Record<string, string>, secrets: Record<string, string> = {}, encode = false): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\{\{(secret:)?([a-z0-9_]+)\}\}/g, (m, secret, name) => {
    const v = secret ? secrets[name] : params[name];
    if (v === undefined) throw new Error(secret ? `Missing secret ${name}` : `Missing param ${name}`);
    // In an address a value is one piece of it, never more path or another host.
    return encode ? encodeURIComponent(v) : v;
  });
}

export function missingParams(r: Routine, params: Record<string, string>): string[] {
  return Object.keys(r.meta.params).filter((p) => params[p] === undefined || params[p] === '');
}
