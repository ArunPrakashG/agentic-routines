import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.ts';

// A lasting record of every tool call and every browser step, kept so that past work can be looked over later
// (finding tasks done more than once, steps that keep failing, routines that do the same thing). Unlike the debug
// log it is on unless turned off, and nothing is rotated away: one file per day, kept until the person removes it.
//
// What is kept is the shape of the work, not its content: an address without its query or fragment, what an
// element is called, which action was taken. Typed values are never written; a short hash says whether two runs
// typed the same thing. Tool results are not kept, apart from a clipped line when a call failed.

/** Each line is written whole in one append; kept well under what an append writes at once. */
const MAX_LINE = 3500;

export interface HistoryTool {
  ts: string;
  kind: 'tool';
  /** One tool server process: calls with the same session were one agent's sitting. */
  session: string;
  agent?: string;
  name: string;
  args?: unknown;
  ms: number;
  ok: boolean;
  /** Only when the call failed, or ended a routine run: the first line of what came back. */
  out?: string;
}

export interface HistoryStep {
  ts: string;
  kind: 'step';
  /** The recorded run in the browser this step belongs to. */
  run?: string;
  /** Who did it: the agent's name, or "You" for a person recording in the panel. */
  source: string;
  session?: string;
  action: string;
  url: string;
  target?: { tag?: string; role?: string; name?: string; text?: string; near?: string; modal?: string };
  field?: string;
  fieldLabel?: string;
  /** Says whether two steps typed the same thing, without saying what. */
  valueHash?: string;
  navigatedTo?: string;
  dismiss?: boolean;
}

export type HistoryEntry = HistoryTool | HistoryStep;

export function historyOn(): boolean {
  const e = process.env.AGENTIC_ROUTINES_HISTORY;
  if (e) return !/^(0|false|off|no)$/i.test(e);
  return !existsSync(paths.historyOffFlag());
}

export function setHistory(on: boolean): void {
  mkdirSync(paths.root(), { recursive: true });
  if (on) rmSync(paths.historyOffFlag(), { force: true });
  else writeFileSync(paths.historyOffFlag(), `${new Date().toISOString()}\n`);
}

export const historyFile = (day: string) => join(paths.history(), `${day}.jsonl`);

/** The days that have a history file, oldest first, as YYYY-MM-DD. */
export function historyDays(): string[] {
  try {
    return readdirSync(paths.history())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

const clip = (s: unknown, n: number) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined);

/** An address as it is kept: scheme, host and path. A query or fragment can carry a session, a token or a search. */
export function bareUrl(u: unknown): string {
  if (typeof u !== 'string' || !u) return '';
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return x.protocol;
    return clip(`${x.origin}${x.pathname}`, 300) ?? '';
  } catch {
    return '';
  }
}

const SECRET_LABEL = /pass|secret|token|otp|pin\b|cvv|card|ssn/i;

/**
 * A step as the browser sent it, cut down to what history keeps. Done here, on this computer, whatever the browser
 * sent: the value is hashed, never kept, and nothing is kept at all for a password field or a field labelled as one.
 */
export function stepEntry(raw: unknown): HistoryStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const e = (d.event ?? {}) as Record<string, unknown>;
  if (typeof e.action !== 'string') return null;
  const t = e.target as Record<string, unknown> | undefined;
  const secret = e.field === 'password' || SECRET_LABEL.test(String(e.fieldLabel ?? '')) || SECRET_LABEL.test(String(t?.name ?? ''));
  // The browser sends a hash; a value sent anyway (an older extension) is hashed here and not kept.
  const given = typeof e.valueHash === 'string' && /^[0-9a-f]{6,16}$/.test(e.valueHash) ? e.valueHash : undefined;
  const value = secret || e.field === 'file' ? undefined : (given ?? (typeof e.value === 'string' && e.value ? createHash('sha256').update(e.value).digest('hex').slice(0, 12) : undefined));
  const out: HistoryStep = {
    ts: new Date(typeof e.ts === 'number' ? e.ts : Date.now()).toISOString(),
    kind: 'step',
    run: clip(d.run, 40),
    source: clip(d.source, 60) ?? '?',
    session: clip(d.session, 60),
    action: e.action.slice(0, 30),
    url: bareUrl(e.url),
    target: t
      ? { tag: clip(t.tag, 20), role: clip(t.role, 30), name: secret ? undefined : clip(t.name, 120), text: secret ? undefined : clip(t.text, 80), near: clip(t.near, 80), modal: clip(t.modal, 80) }
      : undefined,
    field: clip(e.field, 10),
    fieldLabel: clip(e.fieldLabel, 80),
    valueHash: value,
    navigatedTo: e.navigatedTo ? bareUrl(e.navigatedTo) : undefined,
    dismiss: e.dismiss === true ? true : undefined,
  };
  return out;
}

/** A tool call as history keeps it: arguments with typed text and secrets left out, no result unless it failed. */
export function toolEntry(e: { session: string; agent?: string; name: string; args?: unknown; ms: number; ok: boolean; out?: string }): HistoryTool {
  const routine = e.name.startsWith('rt_') || e.name === 'routine_run' || e.name === 'routine_resume' || e.name === 'routine_test';
  return {
    ts: new Date().toISOString(),
    kind: 'tool',
    session: e.session,
    agent: e.agent,
    name: e.name,
    // A routine's own parameters are named by its author, so none of their names says the value is safe to keep.
    args: e.args === undefined ? undefined : shapeArgs(e.args, '', e.name.startsWith('rt_')),
    ms: e.ms,
    ok: e.ok,
    out: !e.ok || routine ? clip(e.out?.split('\n')[0], 200) : undefined,
  };
}

/**
 * Keys whose text says how the work went and not what was in it. Any other text in the arguments, typed values,
 * parameters, script code, search words, becomes its length: the steps the browser records say what was done.
 */
const SAFE_KEYS = new Set(['url', 'op', 'name', 'draft_id', 'run_id', 'routine', 'from_routine', 'ref', 'action', 'direction', 'filter', 'kind', 'session', 'agent', 'mode', 'by', 'tab', 'tabId', 'format']);

function shapeArgs(v: unknown, key = '', content = false): unknown {
  if (typeof v === 'string') {
    if (content || !SAFE_KEYS.has(key)) return `<${v.length} chars>`;
    return key === 'url' || /^https?:\/\//i.test(v) ? bareUrl(v) : clip(v, 120);
  }
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => shapeArgs(x, key, content));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shapeArgs(x, k, content || k === 'params')]));
  return v;
}

/** Add one entry to today's file. Never throws: keeping history must not break the work it records. */
export function appendHistory(entry: HistoryEntry | null): void {
  if (!entry || !historyOn()) return;
  try {
    let line = JSON.stringify(entry);
    if (line.length > MAX_LINE && entry.kind === 'tool') line = JSON.stringify({ ...entry, args: '<too long>' });
    if (line.length > MAX_LINE) return;
    mkdirSync(paths.history(), { recursive: true, mode: 0o700 });
    appendFileSync(historyFile(entry.ts.slice(0, 10)), `${line}\n`, { mode: 0o600 });
  } catch {
    // Nothing to do: the work goes on without this line.
  }
}
