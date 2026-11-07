import { isIrreversible, isItemUrl, isNavigation, shortUrl, siteOf, stepBuilder, targetLabel } from './compile.ts';
import { checkHooks } from './hooks.ts';
import { onSite } from './routine-md.ts';
import { deriveUrls } from './urls.ts';
import { pageSimilarity, SAME_PAGE, urlPattern } from './match.ts';
import type { ParamSpec, RecordedEvent, Routine, RoutineMeta, Run, Step } from './types.ts';

// A draft is a run on its way to becoming a routine: every recorded step, numbered, nothing dropped
// until the agent says so. The hints say what could go; the edits are checked here, not trusted.

export interface DraftStep extends Step {
  /** The page the step was done on. */
  at?: string;
  /** Where the step took the tab, when it did. */
  navigatedTo?: string;
  /** What changed on the page after it, in words. */
  effect?: string;
}

interface Snapshot {
  name: string;
  description: string;
  doNotUse?: string;
  steps: DraftStep[];
  params: Record<string, ParamSpec>;
  secrets: string[];
}

export interface Draft extends Snapshot {
  id: string;
  rev: number;
  /** The site the routine works on. */
  site: string;
  /** Registrable domains of every page that was recorded. A navigate stays inside them. */
  domains: string[];
  /** Hosts that were opened over plain http while recording, which is how a local site looks. */
  httpHosts: string[];
  runId?: string;
  /** The window the steps were recorded in, so a run can tell when the page is laid out differently. */
  viewport?: RoutineMeta['viewport'];
  /** Set when this refines a routine that is already saved. */
  base?: { owner: string; name: string; version: number };
  /** What the person’s own routine carries that edits do not touch: notes for the agent, hooks. Never taken from someone else’s routine. */
  keep?: Pick<RoutineMeta, 'instructions' | 'hooks' | 'requires' | 'returns' | 'urls' | 'surface'>;
  history: Snapshot[];
  /** The proposal as first made, for reset. */
  initial: Snapshot;
  /** The latest test of the draft as it stands. */
  tested?: { rev: number; ok: boolean; summary: string; at: number };
  createdAt: number;
}

export class EditError extends Error {}

// ---------- addresses ----------

const MULTI_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'co.jp', 'co.nz', 'com.br', 'com.mx', 'co.za', 'com.cn', 'com.sg', 'com.hk', 'co.kr', 'com.tr', 'com.ar']);

/** example.com for a.b.example.com. Without the public suffix list this is a close guess, and only ever used to say no. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const labels = h.split('.');
  const take = MULTI_PART.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).host : '';
  } catch {
    return '';
  }
};

const safeDecode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

const PLACEHOLDER = /\{\{[a-z0-9_]+\}\}/g;
const SESSION_KEYS = /^(sid|sessionid|session|session_id|token|access_token|id_token|state|nonce|csrf|csrf_token|xsrf|code|ticket|otp|auth|jsessionid|phpsessid|requestid|request_id|_ga|gclid)$/i;
const RANDOM = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{16,}$/i;
const TOKENISH = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{20,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What in an address belongs to one session, and what names one item. */
export function urlIds(raw: string): { session: string[]; items: string[] } {
  const session: string[] = [];
  const items: string[] = [];
  let u: URL;
  try {
    u = new URL(raw.replace(PLACEHOLDER, 'x'));
  } catch {
    return { session, items };
  }
  const check = (v: string, key?: string) => {
    if (!v) return;
    if (v === 'x') return;
    if ((key && SESSION_KEYS.test(key) && v.length >= 6) || UUID.test(v) || RANDOM.test(v) || TOKENISH.test(v)) session.push(key ? `${key}=${v.slice(0, 24)}` : v.slice(0, 24));
    else if (/^\d{4,}$/.test(v)) items.push(key ? `${key}=${v}` : v);
  };
  for (const seg of u.pathname.split('/')) check(safeDecode(seg));
  for (const [k, v] of u.searchParams) check(v, k);
  const frag = u.hash.replace(/^#/, '');
  if (frag) for (const seg of frag.split(/[/?&=]/)) check(seg);
  return { session, items };
}

/** Why this address cannot be a step's address, or null. */
export function addressProblem(d: Pick<Draft, 'site' | 'domains' | 'httpHosts' | 'params'>, raw: string): string | null {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return `“${url.slice(0, 80)}” is not a full address. Use https://...`;
  if (/^https?:\/\/[^/?#]*\{\{/i.test(url)) return 'The host of an address cannot be a parameter.';
  for (const m of url.matchAll(PLACEHOLDER)) {
    const name = m[0].slice(2, -2);
    if (!d.params[name]) return `The address uses {{${name}}} but no parameter has that name. Declare it with { "op": "param", "name": "${name}" }.`;
  }
  let u: URL;
  try {
    u = new URL(url.replace(PLACEHOLDER, 'x'));
  } catch {
    return `“${url.slice(0, 80)}” is not an address.`;
  }
  if (u.username || u.password) return 'An address with a user name or password in it is not allowed.';
  if (!onSite(u.href, d.site) || !d.domains.includes(registrableDomain(u.host))) return `${u.host} is not on ${d.site}. A routine stays on its own site.`;
  if (u.protocol === 'http:' && !d.httpHosts.includes(u.host)) return 'Use https. Plain http is only allowed for a page that was recorded over http.';
  const ids = urlIds(url);
  if (ids.session.length) return `The address carries what looks like a per-session value (${ids.session.join(', ')}), which will not be there next time. Write it as {{name}} and declare a parameter, or keep the clicks that lead there.`;
  return null;
}

// ---------- making a draft ----------

const MAX_HISTORY = 20;
const now = () => Date.now();

function domainsOf(urls: (string | undefined)[]) {
  const domains = new Set<string>();
  const http = new Set<string>();
  for (const u of urls) {
    const h = hostOf(u);
    if (!h) continue;
    domains.add(registrableDomain(h));
    if (u!.startsWith('http:')) http.add(h);
  }
  return { domains: [...domains], httpHosts: [...http] };
}

const newId = () => 'd-' + Math.random().toString(36).slice(2, 6);

function newLandmarks(before?: Step['page'], after?: Step['page']) {
  if (!before || !after) return [];
  const had = new Set(before.landmarks.map((l) => l.toLowerCase()));
  return after.landmarks.filter((l) => !had.has(l.toLowerCase()));
}

/** A draft of everything the run did, one step per event. */
export function draftFromRun(run: Run, meta: { name: string; description: string; doNotUse?: string }): Draft {
  return withInitial(buildFromRun(run, meta));
}

function withInitial(d: Draft): Draft {
  d.initial = snapshot(d);
  return d;
}

function buildFromRun(run: Run, meta: { name: string; description: string; doNotUse?: string }): Draft {
  const events = run.events.filter((e) => e.action !== 'wait');
  if (!events.length) throw new EditError('This run has no steps.');
  const b = stepBuilder({});
  const steps: DraftStep[] = [];
  // A run that began on whatever tab was open still has to say where to start.
  if (events[0].action !== 'navigate') steps.push({ n: 1, action: 'navigate', label: shortUrl(events[0].url), url: events[0].url, at: events[0].url });
  const firstReal = events.find((e) => !isNavigation(e)) ?? events[events.length - 1];
  events.forEach((e, i) => {
    const step: DraftStep = b.build(e, steps.length + 1, false);
    step.at = e.url;
    step.navigatedTo = e.action === 'navigate' ? undefined : e.navigatedTo;
    const next = events[i + 1];
    const parts: string[] = [];
    if (e.navigatedTo) parts.push(`navigated to ${shortUrl(e.navigatedTo)}`);
    else if (next && next.action !== 'navigate') {
      const added = newLandmarks(e.page, next.page);
      if (added.length) parts.push(`new on the page: ${added.slice(0, 3).map((a) => `“${a}”`).join(', ')}`);
      else if (e.page && next.page && urlPattern(e.page.url) === urlPattern(next.page.url) && pageSimilarity(e.page, next.page) < SAME_PAGE) parts.push('the page changed');
    }
    if (parts.length) step.effect = parts.join('; ');
    steps.push(step);
  });
  const urls = events.flatMap((e) => [e.url, e.navigatedTo, e.page?.url]);
  const { domains, httpHosts } = domainsOf(urls);
  return {
    id: newId(),
    rev: 1,
    name: meta.name,
    description: meta.description,
    doNotUse: meta.doNotUse,
    site: siteOf(firstReal.url),
    domains,
    httpHosts,
    runId: run.id,
    viewport: events.find((e) => e.target && e.view)?.view,
    steps,
    params: b.params,
    secrets: b.secrets,
    history: [],
    initial: undefined as unknown as Snapshot,
    createdAt: now(),
  };
}

/** A draft of a routine that is already saved, to refine it. What each step did is read from the page the next one began on. */
/** Urls the author wrote, as opposed to the ones worked out from the steps, which are worked out again. */
function declaredUrls(r: Routine): string[] | undefined {
  const worked = deriveUrls(r.steps, r.meta.site).join('\n');
  return r.meta.urls && r.meta.urls.join('\n') !== worked ? r.meta.urls : undefined;
}

export function draftFromRoutine(r: Routine & { owner?: string }, meta: { name?: string; description?: string; doNotUse?: string }): Draft {
  return withInitial(buildFromRoutine(r, meta));
}

function buildFromRoutine(r: Routine & { owner?: string }, meta: { name?: string; description?: string; doNotUse?: string }): Draft {
  const steps: DraftStep[] = r.steps.map((s) => ({ ...s, at: s.action === 'navigate' ? s.url : s.page?.url }));
  steps.forEach((s, i) => {
    const next = steps[i + 1];
    if (s.action !== 'navigate' && next?.at && s.at && next.action !== 'navigate' && urlPattern(next.at) !== urlPattern(s.at)) {
      s.navigatedTo = next.at;
      s.effect = `navigated to ${shortUrl(next.at)}`;
    }
  });
  const { domains, httpHosts } = domainsOf(steps.flatMap((s) => [s.url, s.page?.url]).concat(`https://${r.meta.site}/`));
  return {
    id: newId(),
    rev: 1,
    name: meta.name ?? r.meta.name,
    description: meta.description ?? r.meta.description,
    doNotUse: meta.doNotUse,
    site: r.meta.site,
    domains,
    httpHosts: httpHosts.concat(/^[\d.]+(:\d+)?$/.test(r.meta.site) ? [r.meta.site] : []),
    viewport: r.meta.viewport,
    base: { owner: r.owner ?? r.meta.owner ?? 'local', name: r.meta.name, version: r.meta.version },
    // Notes and hooks somebody else wrote are not carried into a routine that then reads as the person's own.
    ...((r.owner ?? r.meta.owner ?? 'local') === 'local' ? { keep: { instructions: r.meta.instructions, hooks: r.meta.hooks, requires: r.meta.requires, returns: r.meta.returns, urls: declaredUrls(r), surface: r.meta.surface } } : {}),
    steps,
    params: structuredClone(r.meta.params),
    secrets: [...r.meta.secrets],
    history: [],
    initial: undefined as unknown as Snapshot,
    createdAt: now(),
  };
}

// ---------- reading a draft ----------

export const isProtected = (s: Step) => s.pause === 'auto' || isIrreversible(s);

const modalOf = (s: Step) => s.target?.modal;

export interface Hint {
  kind: 'navigation' | 'modal' | 'retry' | 'side-effect' | 'off-site' | 'ids';
  steps: [number, number];
  text: string;
  /** The edit that applies it, when there is one. */
  edit?: Op;
}

/** Steps whose only effect was getting somewhere, answering a dialog or going back. */
function navigationOnly(s: DraftStep): boolean {
  if (isProtected(s)) return false;
  if (s.action === 'navigate') return true;
  if (s.action !== 'click') return false;
  return !!s.navigatedTo || !!modalOf(s);
}

export function hints(d: Draft): Hint[] {
  const out: Hint[] = [];
  const steps = d.steps;
  const range = (a: number, b: number) => (a === b ? `step ${a}` : `steps ${a}–${b}`);

  // Runs of steps that only get from one page to another.
  for (let i = 0; i < steps.length; ) {
    if (!navigationOnly(steps[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < steps.length && navigationOnly(steps[j + 1])) j++;
    const a = i + 1;
    const z = j + 1;
    const modal = steps.slice(i, j + 1).find((s) => modalOf(s));
    const next = steps[j + 1];
    const alreadyDirect = j === i && steps[i].action === 'navigate';
    if (next && !alreadyDirect) {
      const target = next.at ?? next.page?.url;
      if (target) {
        const problem = addressProblem(d, target);
        const earlierWork = i > 0 && !navigationOnly(steps[i - 1]) ? steps[i - 1] : undefined;
        const committed = !earlierWork || isProtected(earlierWork);
        if (problem) {
          out.push({ kind: 'ids', steps: [a, z], text: `${range(a, z)} only ${modal ? 'answer a dialog and ' : ''}get to ${shortUrl(target)}, where step ${z + 1} happens, but that address cannot be used directly. ${problem}` });
        } else {
          const items = urlIds(target).items;
          const caution = committed ? '' : ` Earlier steps filled in the page, so check with routine_test that nothing is lost by opening it fresh.`;
          const pinned = items.length ? ` The address names a specific item (${items.join(', ')}); the routine would stay on it. Use {{name}} with a parameter if it should change.` : '';
          out.push({
            kind: modal ? 'modal' : 'navigation',
            steps: [a, z],
            text: `${range(a, z)} only ${modal ? `answer a dialog (“${modalOf(modal)}”) and ` : ''}get to ${shortUrl(target)}, where step ${z + 1} happens. Replace ${j === i ? 'it' : 'them'} with a direct address.${pinned}${caution}`,
            edit: { op: 'navigate', from: a, to: z, url: target },
          });
        }
      }
    } else if (!next && !alreadyDirect) {
      out.push({ kind: 'navigation', steps: [a, z], text: `${range(a, z)} only ${modal ? 'answer a dialog and ' : ''}navigate after the work is done. They can go.`, edit: { op: 'remove', steps: [`${a}-${z}`] } });
    }
    i = j + 1;
  }

  // The same field typed twice, the same click twice.
  const typed = new Map<string, number>();
  steps.forEach((s, i) => {
    const key = s.target ? `${s.at && urlPattern(s.at)}|${s.target.css}|${targetLabel(s.target)}` : '';
    if (s.action === 'type' && key) {
      const earlier = typed.get(key);
      if (earlier !== undefined) out.push({ kind: 'retry', steps: [earlier + 1, i + 1], text: `Step ${earlier + 1} and step ${i + 1} both type into “${targetLabel(s.target)}”. The first is replaced by the second.`, edit: { op: 'remove', steps: [earlier + 1] } });
      typed.set(key, i);
    }
    const p = steps[i - 1];
    if (s.action === 'click' && p?.action === 'click' && !s.pointer?.spot && key && key === `${p.at && urlPattern(p.at)}|${p.target?.css}|${targetLabel(p.target)}` && !s.navigatedTo && !p.navigatedTo && !isProtected(s))
      out.push({ kind: 'retry', steps: [i, i + 1], text: `Steps ${i} and ${i + 1} click “${targetLabel(s.target)}” twice in a row.` });
  });

  for (const s of steps) {
    if (s.action === 'scroll') out.push({ kind: 'retry', steps: [s.n, s.n], text: `Step ${s.n} only scrolls. A replay scrolls to whatever it clicks by itself, so this can go unless the page loads more as it scrolls.`, edit: { op: 'remove', steps: [s.n] } });
    if (isProtected(s)) out.push({ kind: 'side-effect', steps: [s.n, s.n], text: `Step ${s.n} “${s.label}” submits, publishes, pays or deletes. It stays, and the routine pauses before it every run.` });
    const leaves = [s.url, s.at, s.page?.url].find((u) => u && !onSite(u, d.site));
    if (leaves) out.push({ kind: 'off-site', steps: [s.n, s.n], text: `Step ${s.n} is on ${hostOf(leaves)}, which is not ${d.site}. A routine stays on one site; the save will be refused while this step is in.` });
  }
  return out.sort((x, y) => x.steps[0] - y.steps[0]);
}

const CAP = 140;
const clip = (s: string, n = CAP) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function renderStep(s: DraftStep, d?: Draft): string {
  const value = s.value !== undefined ? `: ${s.value.startsWith('{{') ? s.value : clip(s.value, 60)}` : '';
  const what = s.action === 'navigate' ? clip(s.url ?? s.label, 100) : `“${clip(s.label, 60)}”`;
  const where = s.action === 'navigate' || !s.at ? '' : ` on ${shortUrl(s.at).replace(/^[^/]*/, '') || '/'}`;
  const flags = [s.pause ? 'pauses' : '', s.pick ? 'first in list' : '', s.target?.modal ? `in dialog “${clip(s.target.modal, 40)}”` : '', s.instructions ? 'has note' : ''].filter(Boolean);
  void d;
  return `${s.n}. ${s.action} ${what}${value}${where}${s.effect ? ` → ${s.effect}` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

export function renderDraft(d: Draft, opts: { hints?: boolean } = {}): string {
  const lines = [`Draft ${d.id} · ${d.name} · ${d.steps.length} steps on ${d.site}${d.base ? ` · refines v${d.base.version}` : ''}`, ''];
  for (const s of d.steps) lines.push(renderStep(s, d));
  const params = Object.entries(d.params).filter(([k]) => d.steps.some((s) => s.value?.includes(`{{${k}}}`) || s.url?.includes(`{{${k}}}`)));
  if (params.length) lines.push('', 'Asks each run for: ' + params.map(([k, p]) => `${k}${p.example ? ` (recorded: ${clip(p.example, 40)})` : ''}`).join(', '));
  if (d.secrets.length) lines.push(`Secrets (never kept): ${d.secrets.join(', ')}`);
  if (opts.hints !== false) {
    const hs = hints(d);
    if (hs.length) {
      lines.push('', 'Hints (suggestions, nothing was changed):');
      for (const h of hs) lines.push(`- ${h.text}${h.edit ? `\n  apply: ${JSON.stringify(h.edit)}` : ''}`);
    }
  }
  return lines.join('\n');
}

// ---------- editing ----------

export type StepRef = number | string;

export type Op =
  | { op: 'remove'; steps: StepRef[] }
  | { op: 'navigate'; from: number; to: number; url: string }
  | { op: 'open'; before: number; url: string }
  | { op: 'param'; name: string; step?: number; value?: string; description?: string; example?: string }
  | { op: 'fixed'; step: number }
  | { op: 'pause'; step: number; on: boolean }
  | { op: 'note'; step: number; text: string }
  | { op: 'first_in_list'; step: number }
  | { op: 'describe'; name?: string; description?: string; do_not_use_for?: string }
  | { op: 'undo' }
  | { op: 'reset' };

const MAX_NOTE = 1000;

function snapshot(d: Draft): Snapshot {
  return structuredClone({ name: d.name, description: d.description, doNotUse: d.doNotUse, steps: d.steps, params: d.params, secrets: d.secrets });
}

function renumber(d: Draft) {
  d.steps.forEach((s, i) => (s.n = i + 1));
}

function expand(d: Draft, refs: StepRef[]): number[] {
  const out = new Set<number>();
  for (const r of refs) {
    const m = typeof r === 'string' ? /^(\d+)-(\d+)$/.exec(r.trim()) : null;
    const [a, b] = m ? [Number(m[1]), Number(m[2])] : [Number(r), Number(r)];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) throw new EditError(`“${r}” is not a step number or a range like 3-5.`);
    for (let n = a; n <= b; n++) out.add(n);
  }
  for (const n of out) if (n < 1 || n > d.steps.length) throw new EditError(`There is no step ${n}. The draft has ${d.steps.length}.`);
  return [...out].sort((x, y) => x - y);
}

function guard(steps: DraftStep[], what: string) {
  const hit = steps.find(isProtected);
  if (hit) throw new EditError(`Step ${hit.n} “${hit.label}” submits, publishes, pays or deletes, so it cannot be ${what}. Its pause stays. Edit the steps around it instead.`);
}

function navStep(url: string): DraftStep {
  return { n: 0, action: 'navigate', label: shortUrl(url.replace(PLACEHOLDER, 'x')).replace(/\/x(?=\/|$)/g, '/{…}'), url, at: url };
}

/** The value a step was recorded with: its own, or the example of the parameter it already asks for. */
function recorded(d: Draft, s: Step): string | undefined {
  const name = /^\{\{([a-z0-9_]+)\}\}$/.exec(s.value ?? '')?.[1];
  return name && d.params[name]?.example !== undefined ? d.params[name].example : s.value;
}

/** Applies one edit to the draft in place. Throws EditError and leaves the caller to discard the copy. */
function applyOne(d: Draft, op: Op): string {
  switch (op.op) {
    case 'remove': {
      const ns = expand(d, op.steps);
      if (ns.length >= d.steps.length) throw new EditError('That removes every step.');
      guard(ns.map((n) => d.steps[n - 1]), 'removed');
      d.steps = d.steps.filter((s) => !ns.includes(s.n));
      renumber(d);
      return `Removed ${ns.length === 1 ? `step ${ns[0]}` : `${ns.length} steps`}.`;
    }
    case 'navigate': {
      const ns = expand(d, [`${op.from}-${op.to}`]);
      guard(ns.map((n) => d.steps[n - 1]), 'replaced');
      const bad = addressProblem(d, op.url);
      if (bad) throw new EditError(bad);
      const at = ns[0] - 1;
      d.steps.splice(at, ns.length, navStep(op.url));
      renumber(d);
      const items = urlIds(op.url).items;
      return `Replaced ${ns.length === 1 ? `step ${ns[0]}` : `steps ${ns[0]}–${ns[ns.length - 1]}`} with step ${at + 1}: navigate ${clip(op.url, 100)}.${items.length ? ` It names a specific item (${items.join(', ')}), so the routine stays on it.` : ''}`;
    }
    case 'open': {
      if (!Number.isInteger(op.before) || op.before < 1 || op.before > d.steps.length + 1) throw new EditError(`There is no step ${op.before} to open a page before.`);
      const bad = addressProblem(d, op.url);
      if (bad) throw new EditError(bad);
      d.steps.splice(op.before - 1, 0, navStep(op.url));
      renumber(d);
      return `Added step ${op.before}: navigate ${clip(op.url, 100)}.`;
    }
    case 'param': {
      if (!/^[a-z0-9_]{1,40}$/.test(op.name)) throw new EditError(`“${op.name}” is not a parameter name. Use lowercase letters, digits and underscores.`);
      if (d.secrets.includes(op.name)) throw new EditError(`${op.name} is a secret, which is never a parameter.`);
      const tied: DraftStep[] = [];
      if (op.step !== undefined) {
        const s = d.steps[op.step - 1];
        if (!s) throw new EditError(`There is no step ${op.step}.`);
        tied.push(s);
      } else if (op.value !== undefined) {
        tied.push(...d.steps.filter((s) => (s.action === 'type' || s.action === 'upload' || s.action === 'select') && recorded(d, s) === op.value));
        if (!tied.length) throw new EditError(`No typed value equals “${clip(op.value, 40)}”. Name the step with step: N instead.`);
      }
      for (const s of tied) {
        if (!['type', 'upload', 'select', 'press'].includes(s.action) || s.value === undefined) throw new EditError(`Step ${s.n} does not take a value, so it cannot be a parameter.`);
        if (s.value.startsWith('{{secret:')) throw new EditError(`Step ${s.n} types a secret, which is never a parameter.`);
      }
      const spec: ParamSpec = d.params[op.name] ?? { type: tied[0]?.action === 'upload' ? 'file' : 'string' };
      if (op.description) spec.description = op.description.slice(0, 300);
      const seen = tied[0] ? recorded(d, tied[0]) : undefined;
      const example = op.example ?? (seen?.startsWith('{{') ? undefined : seen);
      if (example !== undefined) spec.example = example;
      d.params[op.name] = spec;
      for (const s of tied) {
        const old = /^\{\{([a-z0-9_]+)\}\}$/.exec(s.value!)?.[1];
        // The value this step had stays as the parameter's example when it was a literal.
        s.value = `{{${op.name}}}`;
        if (old && old !== op.name && !d.steps.some((x) => x.value?.includes(`{{${old}}}`))) delete d.params[old];
      }
      return tied.length ? `${op.name} is now asked for each run${tied.length > 1 ? `, in steps ${tied.map((s) => s.n).join(', ')}` : `, in step ${tied[0].n}`}.` : `Declared parameter ${op.name}. Use {{${op.name}}} in an address.`;
    }
    case 'fixed': {
      const s = d.steps[op.step - 1];
      if (!s) throw new EditError(`There is no step ${op.step}.`);
      const name = /^\{\{([a-z0-9_]+)\}\}$/.exec(s.value ?? '')?.[1];
      if (!name || !d.params[name]) throw new EditError(`Step ${op.step} does not use a parameter.`);
      const ex = d.params[name].example;
      if (ex === undefined) throw new EditError(`${name} has no recorded value to keep. Edit it with param and example.`);
      s.value = ex;
      if (!d.steps.some((x) => x.value?.includes(`{{${name}}}`))) delete d.params[name];
      return `Step ${op.step} keeps “${clip(ex, 40)}” as typed.`;
    }
    case 'pause': {
      const s = d.steps[op.step - 1];
      if (!s) throw new EditError(`There is no step ${op.step}.`);
      if (!op.on && isProtected(s)) throw new EditError(`Step ${s.n} “${s.label}” submits, publishes, pays or deletes. Its pause cannot be switched off.`);
      if (op.on) s.pause ??= 'author';
      else delete s.pause;
      return op.on ? `The routine pauses before step ${s.n}.` : `Step ${s.n} no longer pauses.`;
    }
    case 'note': {
      const s = d.steps[op.step - 1];
      if (!s) throw new EditError(`There is no step ${op.step}.`);
      const t = op.text.trim();
      if (t.length > MAX_NOTE) throw new EditError(`A note is at most ${MAX_NOTE} characters.`);
      if (t) s.instructions = t;
      else delete s.instructions;
      return t ? `Step ${s.n} has a note.` : `Step ${s.n} has no note.`;
    }
    case 'first_in_list': {
      const s = d.steps[op.step - 1];
      if (!s) throw new EditError(`There is no step ${op.step}.`);
      if (s.action !== 'click') throw new EditError(`Step ${s.n} is not a click.`);
      s.pick = 'first';
      s.label = 'First in the list';
      delete s.crop;
      return `Step ${s.n} clicks whatever is first in the list.`;
    }
    case 'describe': {
      if (op.name !== undefined) {
        if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(op.name)) throw new EditError('A name is lowercase letters, digits and dashes.');
        d.name = op.name;
      }
      if (op.description !== undefined) d.description = op.description.trim();
      if (op.do_not_use_for !== undefined) d.doNotUse = op.do_not_use_for.trim() || undefined;
      return 'Updated the description.';
    }
    case 'reset': {
      Object.assign(d, structuredClone(d.initial));
      return 'Back to the proposal.';
    }
    case 'undo':
      throw new EditError('undo goes on its own.');
  }
}

/** Applies the edits in order, all or none. Returns the new draft and a line for each edit. */
export function applyOps(draft: Draft, ops: Op[]): { draft: Draft; notes: string[] } {
  if (!ops.length) throw new EditError('No edits given.');
  const d = structuredClone(draft);
  const notes: string[] = [];
  for (const [i, op] of ops.entries()) {
    try {
      if (op.op === 'undo') {
        const prev = d.history.pop();
        if (!prev) throw new EditError('Nothing to undo.');
        Object.assign(d, prev);
        notes.push('Undid the last edit.');
        continue;
      }
      d.history.push(snapshot(d));
      if (d.history.length > MAX_HISTORY) d.history.shift();
      notes.push(applyOne(d, op));
      if (op.op === 'reset') d.history = [];
    } catch (e) {
      if (e instanceof EditError) throw new EditError(`Edit ${i + 1} (${op.op}) was refused, and none of them were applied. ${e.message}`);
      throw e;
    }
  }
  d.rev = draft.rev + 1;
  return { draft: d, notes };
}

// ---------- saving ----------

/** The rules the directory applies at publish, so a routine that would be turned away is caught before it is saved. */
export function validateRoutine(r: Routine): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const m = r.meta;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(m.name)) problems.push('The name is lowercase letters, digits and dashes, 2 to 63 characters.');
  if (m.description.length < 20 || m.description.length > 1024 || !/\buse when\b/i.test(m.description)) problems.push('The description is 20 to 1024 characters and has a "Use when ..." clause.');
  if (!m.site) problems.push('No site.');
  else if (!m.site.includes('.') || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(m.site)) warnings.push(`The directory would not accept the site “${m.site}”.`);
  if (r.body.length > 20 << 10) problems.push('The notes are over 20 KB.');
  if ((m.instructions?.length ?? 0) > 4000) problems.push('The notes for the agent are over 4000 characters.');
  problems.push(...checkHooks(m.hooks));
  if (!r.steps.length || r.steps.length > 300) problems.push('A routine has 1 to 300 steps.');
  if (Object.keys(m.params).length > 30 || m.secrets.length > 10 || (m.returns?.length ?? 0) > 512) problems.push('Too many parameters or secrets.');
  for (const [k, p] of Object.entries(m.params)) if (!/^[a-z0-9_]{1,40}$/.test(k) || (p.type !== 'string' && p.type !== 'file') || (p.description?.length ?? 0) > 300 || (p.accept?.length ?? 0) > 100) problems.push(`Parameter ${k} is not valid.`);
  if (r.steps[0] && r.steps[0].action !== 'navigate') problems.push('Step 1 must open a page. Add one with { "op": "open", "before": 1, "url": "..." }.');
  r.steps.forEach((s, i) => {
    if (s.n !== i + 1) problems.push(`Step numbers are out of order at ${i + 1}.`);
    if (s.label.length > 300 || (s.value?.length ?? 0) > 4096) problems.push(`Step ${s.n} is too long.`);
    if ((s.instructions?.length ?? 0) > MAX_NOTE) problems.push(`Step ${s.n} has a note over ${MAX_NOTE} characters.`);
    if (s.action === 'navigate' && !s.url) problems.push(`Step ${s.n} navigates nowhere.`);
    for (const u of [s.url, s.page?.url]) if (u && m.site && !onSite(u.replace(PLACEHOLDER, 'x'), m.site)) problems.push(`Step ${s.n} leaves ${m.site}.`);
    if (s.target && (Object.keys(s.target.attrs).length > 20 || s.target.css.length > 600)) problems.push(`Step ${s.n} has an element description that is too large.`);
    for (const ref of `${s.value ?? ''} ${s.url ?? ''}`.matchAll(/\{\{(secret:)?([a-z0-9_]+)\}\}/g)) {
      if (ref[1] ? !m.secrets.includes(ref[2]) : !m.params[ref[2]]) problems.push(`Step ${s.n} uses {{${ref[1] ?? ''}${ref[2]}}}, which is not declared.`);
    }
  });
  for (const p of m.pauses) if (p < 1 || p > r.steps.length) problems.push('A pause points at a step that is not there.');
  return { problems: [...new Set(problems)], warnings };
}

/** The routine this draft would save. */
export function finalize(d: Draft, draftedBy?: string): { routine: Routine; pinned: string[] } {
  const steps: Step[] = d.steps.map((s, i) => {
    const { at: _a, navigatedTo: _n, effect: _e, ...rest } = s;
    return { ...rest, n: i + 1 };
  });
  const used = (k: string) => steps.some((s) => s.value?.includes(`{{${k}}}`) || s.url?.includes(`{{${k}}}`));
  const params = Object.fromEntries(Object.entries(d.params).filter(([k]) => used(k)));
  const secrets = d.secrets.filter((k) => steps.some((s) => s.value?.includes(`{{secret:${k}}}`)));
  const routine: Routine = {
    meta: {
      name: d.name,
      version: d.base ? d.base.version + 1 : 1,
      site: d.site,
      description: d.description.trim(),
      params,
      secrets,
      pauses: steps.filter((s) => s.pause).map((s) => s.n),
      urls: d.keep?.urls ?? deriveUrls(steps, d.site),
      ...(d.viewport ? { viewport: d.viewport } : {}),
      drafted_by: draftedBy,
      ...Object.fromEntries(Object.entries(d.keep ?? {}).filter(([, v]) => v !== undefined)),
    },
    body: d.doNotUse ? `## Do not use for\n${d.doNotUse}` : '',
    steps,
  };
  const pinned: string[] = [];
  const first = steps[0]?.url;
  if (first && isItemUrl(first.replace(PLACEHOLDER, 'x'))) pinned.push(`it starts at ${shortUrl(first)}`);
  d.steps.forEach((s, i) => {
    if (s.action === 'click' && !s.pick && isItemUrl(s.navigatedTo)) pinned.push(`step ${i + 1} opens “${s.label}”`);
  });
  return { routine, pinned };
}
