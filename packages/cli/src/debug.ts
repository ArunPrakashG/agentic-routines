import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendHistory, toolEntry } from './history.ts';
import { paths } from './paths.ts';

// A record of what agents did through the tool server, for finding out why something went wrong.
// It is off unless AGENTIC_ROUTINES_DEBUG is set or `agentic-routines debug on` made the flag file, and the file
// is checked on every call, so turning it on needs no restart.

const MAX_BYTES = 5 * 1024 * 1024;
const SECRET = /pass|secret|token|key|otp|pin|cookie|auth|card|cvv|ssn/i;

export interface Entry {
  ts: string;
  kind: 'tool' | 'bridge';
  /** Ties a bridge call to the tool call that made it. */
  call?: number;
  agent?: string;
  name: string;
  args?: unknown;
  ms: number;
  ok: boolean;
  /** What came back, cut short. */
  out?: string;
}

export function debugOn(): boolean {
  const e = process.env.AGENTIC_ROUTINES_DEBUG;
  if (e) return !/^(0|false|off|no)$/i.test(e);
  return existsSync(paths.debugFlag());
}

export function setDebug(on: boolean): void {
  mkdirSync(paths.root(), { recursive: true });
  if (on) writeFileSync(paths.debugFlag(), `${new Date().toISOString()}\n`);
  else rmSync(paths.debugFlag(), { force: true });
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

/** Arguments as they are logged: typed text and anything that looks like a secret is left out, long values are cut. */
export function redact(v: unknown, key = '', tool = ''): unknown {
  if (typeof v === 'string') {
    if (SECRET.test(key) || (/(^|\.)type$/.test(tool) && key === 'text')) return `<${v.length} chars>`;
    return clip(v, 200);
  }
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, key, tool));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k, tool)]));
  return v;
}

/** What a tool returned, in a line: its text cut short, and the size of any picture. */
export function summarize(res: unknown): string {
  const r = res as { content?: { type: string; text?: string; data?: string }[]; isError?: boolean } | undefined;
  if (!r?.content) return '';
  return r.content
    .map((c) => (c.type === 'text' ? clip((c.text ?? '').replace(/\s+/g, ' '), 300) : c.type === 'image' ? `[image ${Math.round(((c.data?.length ?? 0) * 3) / 4 / 1024)} KB]` : `[${c.type}]`))
    .join(' ');
}

export const current = new AsyncLocalStorage<number>();

export function record(e: Omit<Entry, 'ts'>): void {
  if (!debugOn()) return;
  try {
    const file = paths.actions();
    mkdirSync(paths.logs(), { recursive: true });
    try {
      // A full log is put aside under the time it filled up, never written over: older ones stay readable.
      if (statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.jsonl$/, `-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
    } catch {
      // Nothing there yet.
    }
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`);
  } catch {
    // Logging must never break a tool call.
  }
}

let calls = 0;

/** This tool server process, so history can tell one agent's sitting from another's. */
const SESSION = `${process.pid}-${Date.now().toString(36)}`;

// A tool with no inputs is handed the request details in place of its arguments.
const isExtra = (a: unknown) => !!a && typeof a === 'object' && 'signal' in a && 'requestId' in a;

/** Wrap a tool's handler so every call is recorded with its arguments, time and outcome. */
export function logged<A, R>(name: string, agent: () => string | undefined, fn: (a: A, extra: unknown) => Promise<R>): (a: A, extra: unknown) => Promise<R> {
  return async (a, extra) => {
    const call = ++calls;
    const t = Date.now();
    const args = isExtra(a) ? undefined : a;
    // History is kept whether or not the debug log is on; the debug log adds what came back.
    const done = (ok: boolean, out: string) => {
      const ms = Date.now() - t;
      appendHistory(toolEntry({ session: SESSION, agent: agent(), name, args, ms, ok, out }));
      if (debugOn()) record({ kind: 'tool', call, agent: agent(), name, args: args === undefined ? undefined : redact(args, '', name), ms, ok, out });
    };
    try {
      const res = await current.run(call, () => fn(a, extra));
      done(!(res as { isError?: boolean })?.isError, summarize(res));
      return res;
    } catch (e) {
      done(false, clip((e as Error).message ?? String(e), 300));
      throw e;
    }
  };
}
