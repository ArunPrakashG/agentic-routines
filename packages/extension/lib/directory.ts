import { lintForPublish, type Routine } from '@agentic-routines/core';
import * as auth from './auth';

// Publishing to the directory. The extension holds the session, so every publish goes through here.

export interface PublishCard {
  /** owner/name of the saved routine. */
  id: string;
  name: string;
  site: string;
  steps: number;
  /** What the routine's own steps carry that becomes public, as lines to read. */
  shown: string[];
  more: number;
  needsHandle: boolean;
  handle?: string;
  /** The agent that asked, when one did. */
  by?: string;
  busy: boolean;
  error?: string;
  done?: { as: string; version: number };
}

const MESSAGES: Record<string, string> = {
  signed_out: 'You are signed out. Sign in again.',
  needs_handle: 'Pick a name first.',
  bad_handle: 'Use 3 to 30 lowercase letters, numbers or dashes.',
  handle_taken: 'That name is taken. Try another.',
  handle_set: 'Your name is already set.',
  bad_description: 'The description needs a “Use when …” sentence of at least 20 characters.',
  step_off_site: 'A step leaves the routine’s site, so it cannot be published.',
  body_too_long: 'The notes are too long.',
  bad_steps: 'The steps are not in a shape the directory takes.',
  too_many_routines: 'You have reached the limit of published routines. Take one down first.',
  blocked: 'This account cannot send routines to the directory.',
  too_many_waiting: 'You have ten waiting for review. Wait for a decision or withdraw one.',
  slow_down: 'You have sent a lot today. Try again tomorrow.',
  rate_limited: 'Too many tries. Wait a minute.',
};

const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Typed values and addresses with details in them: the parts of a routine that can be personal. */
export function publicValues(r: Routine): { shown: string[]; more: number } {
  const all: string[] = [];
  for (const s of r.steps) {
    if ((s.action === 'type' || s.action === 'select') && s.value && !/^\{\{/.test(s.value)) all.push(`Step ${s.n} types “${short(s.value)}”`);
    if (s.action === 'navigate' && s.url?.includes('?')) all.push(`Step ${s.n} opens ${short(s.url, 70)}`);
  }
  return { shown: all.slice(0, 6), more: Math.max(0, all.length - 6) };
}

export function problems(r: Routine): string[] {
  return lintForPublish(
    r.meta,
    r.steps.flatMap((s) => [s.url, s.page?.url].filter((u): u is string => !!u)),
  ).map((i) => i.message);
}

/** The routine as the directory takes it. Example values and the owner stay behind. */
function payload(r: Routine, agentRaw?: string) {
  const params = Object.fromEntries(Object.entries(r.meta.params).map(([k, p]) => [k, { type: p.type, description: p.description, accept: p.accept }]));
  const { name, site, description, secrets, pauses, returns, drafted_by } = r.meta;
  return { meta: { name, site, description, params, secrets, pauses, returns, drafted_by: drafted_by ?? agentRaw }, body: r.body, steps: r.steps };
}

/** Sends the routine for review. Nothing is public until a person approves it. */
export async function publish(r: Routine): Promise<{ id: string; owner: string; name: string; version: number; status: 'pending' }> {
  const res = await auth.api('PUT', `/routines/${r.meta.name}`, payload(r));
  if (res.ok) return res.json();
  const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '';
  throw new Error(MESSAGES[code] ?? 'Could not send it. Try again.');
}

export interface Submission {
  id: string;
  name: string;
  site: string;
  version: number;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  guideline: string | null;
  note: string | null;
  submitted_at: string;
  decided_at: string | null;
}
export interface LiveRoutine {
  name: string;
  site: string;
  version: number;
  installs: number;
  updated_at: string;
  disabled: boolean;
  disabled_reason: string | null;
}

/** What this account has live, and what it sent for review. Read only; an agent can ask for it but not change it. */
export async function mine(): Promise<{ routines: LiveRoutine[]; submissions: Submission[] }> {
  const [live, sent] = await Promise.all([auth.api('GET', '/me/routines'), auth.api('GET', '/me/submissions')]);
  if (!live.ok || !sent.ok) throw new Error('Could not load your submissions. Try again.');
  return { routines: ((await live.json()) as { routines: LiveRoutine[] }).routines, submissions: ((await sent.json()) as { submissions: Submission[] }).submissions };
}

export async function withdraw(id: string): Promise<void> {
  const res = await auth.api('DELETE', `/me/submissions/${id}`);
  if (!res.ok && res.status !== 404) throw new Error('Could not withdraw it. Try again.');
}

export async function claimHandle(handle: string): Promise<void> {
  const res = await auth.api('PUT', '/me/handle', { handle });
  if (!res.ok) {
    const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '';
    throw new Error(MESSAGES[code] ?? 'Could not set the name. Try again.');
  }
  await auth.setHandle(handle);
}
