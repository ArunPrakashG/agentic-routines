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

function targetLabel(t?: Locator): string {
  if (!t) return '';
  return (t.name || t.text || t.attrs.placeholder || t.tag).slice(0, 80);
}

function shortUrl(u: string): string {
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
  /** Param names the agent wants, mapped to the value it typed. Matched by value. */
  params?: Record<string, string>;
  /** Auto-detected params to keep as typed. */
  fixed?: string[];
  body?: string;
  returns?: string;
}

export interface Compiled {
  routine: Routine;
  recorded: number;
  dropped: number;
}

/** Was this event just getting to the page where the work happens? */
function isNavigation(e: RecordedEvent): boolean {
  return e.action === 'navigate' || (e.action === 'click' && !!e.navigatedTo && !isIrreversible(e));
}

export function compileRun(run: Run, opts: CompileOptions): Compiled {
  const events = run.events.filter((e) => e.action !== 'wait');
  if (events.length === 0) throw new Error('This run has no steps');

  // Navigation that a direct URL can replace: everything before the first real action.
  let k = events.findIndex((e) => !isNavigation(e));
  if (k === -1) k = events.length - 1;
  const workUrl = events[k].url;
  const rest = events.slice(k).filter((e, i) => !(i === 0 && e.action === 'navigate'));

  const steps: Step[] = [{ n: 1, action: 'navigate', label: shortUrl(workUrl), url: workUrl }];
  const params: Record<string, ParamSpec> = {};
  const secrets: string[] = [];
  const byValue = new Map(Object.entries(opts.params ?? {}).map(([name, v]) => [v, name]));
  const fixed = new Set(opts.fixed ?? []);

  const uniq = (base: string, taken: Record<string, unknown> | string[]) => {
    const has = (n: string) => (Array.isArray(taken) ? taken.includes(n) : n in taken);
    let n = base;
    for (let i = 2; has(n); i++) n = `${base}_${i}`;
    return n;
  };

  for (const e of rest) {
    const step: Step = {
      n: steps.length + 1,
      action: e.action,
      label: e.action === 'navigate' ? shortUrl(e.url) : e.fieldLabel || targetLabel(e.target),
      target: e.target,
      page: e.page,
      crop: e.crop,
    };
    if (e.action === 'navigate') step.url = e.url;

    if (e.field === 'password') {
      const name = uniq(snake(e.fieldLabel || 'password'), secrets);
      secrets.push(name);
      step.value = `{{secret:${name}}}`;
      delete step.crop;
    } else if ((e.action === 'type' || e.action === 'upload') && e.value !== undefined) {
      const named = byValue.get(e.value);
      const auto = snake(e.fieldLabel || targetLabel(e.target) || (e.action === 'upload' ? 'file' : 'text'));
      const name = named ?? uniq(auto, params);
      if (!named && fixed.has(auto)) {
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
    steps.push(step);
  }

  const routine: Routine = {
    meta: {
      name: opts.name,
      owner: opts.owner,
      version: 1,
      site: siteOf(workUrl),
      description: opts.description.trim(),
      params,
      secrets,
      pauses: steps.filter((s) => s.pause).map((s) => s.n),
      returns: opts.returns,
    },
    body: opts.body ?? '',
    steps,
  };
  return { routine, recorded: run.events.length, dropped: k };
}

/** Put values into a step: "{{version_name}}" -> "2.15.0 (215)". */
export function fill(value: string | undefined, params: Record<string, string>, secrets: Record<string, string> = {}): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\{\{(secret:)?([a-z0-9_]+)\}\}/g, (m, secret, name) => {
    const v = secret ? secrets[name] : params[name];
    if (v === undefined) throw new Error(secret ? `Missing secret ${name}` : `Missing param ${name}`);
    return v;
  });
}

export function missingParams(r: Routine, params: Record<string, string>): string[] {
  return Object.keys(r.meta.params).filter((p) => params[p] === undefined || params[p] === '');
}
