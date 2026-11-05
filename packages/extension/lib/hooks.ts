import { HOOK_EVENTS, HOOK_LIMITS, hookHash, readDirectives, type Directive, type HookContext, type HookEvent, type HookLogEntry, type HookReport, type HookState, type Hooks, type Routine } from '@agentic-routines/core';

// Hooks: code a routine's author wrote, run in a sandbox that can reach nothing, answering with directives
// this side validates and performs. The sandbox page is framed by an offscreen document, because a service
// worker cannot hold a frame. Firefox has neither, so there hooks are not supported and the routine runs without them.

export const supported = () => !!(browser as unknown as { offscreen?: unknown }).offscreen;

/** The id approvals are kept under: the same one the routine is found by. */
export const idOf = (r: Routine & { owner?: string }) => `${r.owner ?? r.meta.owner ?? 'local'}/${r.meta.name}`;

// ---------- approval ----------

interface Approvals {
  [id: string]: { hash: string; at: number };
}

const KEY = 'hookApprovals';
const load = async () => ((await browser.storage.local.get(KEY)) as { [KEY]?: Approvals })[KEY] ?? {};

/**
 * Whether a routine's hooks may run. Approval is pinned to a hash of all the hook code, so a routine that
 * changed (a new version, an edited file, one more event) is off until the person has read it again.
 */
export async function stateOf(id: string, hooks: Hooks | undefined): Promise<{ state: HookState; reason?: string; hash?: string }> {
  if (!hooks || !Object.keys(hooks).length) return { state: 'none' };
  return stateFor(id, await hookHash(hooks));
}

/** The same, for a hash already worked out (the library list carries one per routine). */
export async function stateFor(id: string, hash: string): Promise<{ state: HookState; reason?: string; hash: string }> {
  if (!supported()) return { state: 'unsupported', reason: 'This browser cannot run hooks (they need Chromium). The routine runs without them.', hash };
  const a = (await load())[id];
  if (!a) return { state: 'off', reason: 'They have not been approved. The person can read them and approve them in the side panel.', hash };
  if (a.hash !== hash) return { state: 'off', reason: 'They changed since the person approved them, so they are off until the person reads them again in the side panel.', hash };
  return { state: 'on', hash };
}

/** Only ever called for a click in the side panel. */
export async function approve(id: string, hash: string) {
  const all = await load();
  all[id] = { hash, at: Date.now() };
  await browser.storage.local.set({ [KEY]: all });
}

export async function revoke(id: string) {
  const all = await load();
  delete all[id];
  await browser.storage.local.set({ [KEY]: all });
}

// ---------- running one ----------

let seq = 0;

async function ensureHost() {
  const off = (browser as unknown as { offscreen: { hasDocument?: () => Promise<boolean>; createDocument: (o: object) => Promise<void> } }).offscreen;
  if (await off.hasDocument?.()) return;
  try {
    await off.createDocument({ url: 'offscreen.html', reasons: ['IFRAME_SCRIPTING'], justification: 'Runs the hooks of a routine in a sandbox that cannot reach the network.' });
  } catch (e) {
    if (!/single|already/i.test((e as Error).message)) throw e;
  }
}

export type Ran = { ok: true; value: unknown; ms: number } | { ok: false; error: string; ms: number };

/** Runs hook code on a context. Never throws; a hook that fails is a result, not an error. */
export async function execute(code: string, ctx: HookContext): Promise<Ran> {
  const start = Date.now();
  try {
    await ensureHost();
    // The context is cut to size here, the page markup first.
    let json = JSON.stringify(ctx);
    if (json.length > HOOK_LIMITS.context && ctx.dom) {
      const over = json.length - HOOK_LIMITS.context;
      ctx = { ...ctx, dom: { ...ctx.dom, html: ctx.dom.html.slice(0, Math.max(0, ctx.dom.html.length - over - 20)) + ' …cut' } };
      json = JSON.stringify(ctx);
    }
    const res = (await browser.runtime.sendMessage({ t: 'hook.run', id: ++seq, code, ctx: JSON.parse(json), ms: HOOK_LIMITS.ms, max: HOOK_LIMITS.output })) as { json?: string; error?: string; ms: number } | undefined;
    if (!res) return { ok: false, error: 'the sandbox did not answer', ms: Date.now() - start };
    if (res.error) return { ok: false, error: res.error, ms: res.ms };
    let value: unknown;
    try {
      value = JSON.parse(res.json ?? 'null');
    } catch {
      return { ok: false, error: 'returned something that is not data', ms: res.ms };
    }
    return { ok: true, value, ms: res.ms };
  } catch (e) {
    return { ok: false, error: (e as Error).message, ms: Date.now() - start };
  }
}

// ---------- one replay's hooks ----------

export class HookRun {
  readonly log: HookLogEntry[] = [];
  readonly notes: string[] = [];
  runs = 0;
  /** A hook asked for the person to look before the next step. */
  pause?: string;
  /** The log entry of the hook that ran last, for the caller to add what it did. */
  last?: HookLogEntry;

  constructor(
    readonly state: Exclude<HookState, 'none'>,
    readonly reason: string | undefined,
    readonly hooks: Hooks,
    readonly site: { host: string; http: boolean },
  ) {}

  has(event: HookEvent): boolean {
    return this.state === 'on' && !!this.hooks[event] && this.runs < HOOK_LIMITS.runs;
  }

  /** Runs the hook for an event and returns the directives that passed validation. Everything is logged. */
  async fire(event: HookEvent, ctx: HookContext): Promise<Directive[]> {
    const code = this.hooks[event];
    if (!code) return [];
    this.runs++;
    const entry: HookLogEntry = { event, ...(ctx.step ? { step: ctx.step.n } : {}), ms: 0, done: [], refused: [] };
    this.log.push(entry);
    this.last = entry;
    const res = await execute(code, ctx);
    entry.ms = res.ms;
    if (!res.ok) {
      entry.error = res.error;
      return [];
    }
    const { ok, refused } = readDirectives(res.value, event, this.site);
    entry.refused.push(...refused);
    return ok;
  }

  report(): HookReport {
    return { state: this.state, ...(this.reason ? { reason: this.reason } : {}), runs: this.runs, log: this.log.slice(-60), notes: this.notes.slice(0, 20) };
  }
}

/** The hooks of this replay: off, unsupported or on. Undefined when the routine has none. */
export async function forRoutine(r: Routine & { owner?: string }): Promise<HookRun | undefined> {
  if (!r.meta.hooks || !Object.keys(r.meta.hooks).length) return undefined;
  const st = await stateOf(idOf(r), r.meta.hooks);
  if (st.state === 'none') return undefined;
  let u: URL | undefined;
  try {
    u = new URL(`https://${r.meta.site}/`);
  } catch {
    // A site that is not a host is refused by the checks at publish; here it just means goto has nowhere to go.
  }
  const http = /^[\d.]+(:\d+)?$/.test(r.meta.site) || r.meta.site.startsWith('localhost') || r.meta.site.startsWith('127.');
  return new HookRun(st.state as Exclude<HookState, 'none'>, st.reason, st.state === 'on' ? r.meta.hooks : {}, { host: (u?.hostname ?? r.meta.site).toLowerCase(), http });
}

export const EVENTS = HOOK_EVENTS;
