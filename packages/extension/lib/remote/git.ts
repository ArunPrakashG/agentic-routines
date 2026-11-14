import { checkFetched, hookHash, type Hooks, type Routine, type SourceEntry } from '@agentic-routines/core';
import * as native from '../agent/native';
import { API } from './auth';

// Installing from a Git source or a folder. The host does the fetching and every check; this side
// shows the person what was fetched and only installs after they click.

export interface GitCard {
  source: string;
  kind: 'github' | 'folder' | 'directory';
  path: string;
  ref?: string;
  name: string;
  description: string;
  site: string;
  version: number;
  /** The author's notes for the agent, and the repository's. Shown to the person before they install. */
  instructions?: string;
  repoName?: string;
  repoInstructions?: string;
  /** The routine's own notes, the Markdown under its front matter. */
  body?: string;
  steps: { n: number; action: string; label: string; value?: string; url?: string; pause: boolean }[];
  /** The code of its hooks, shown in full. Off unless the person turns them on here. */
  hooks?: Hooks;
  hookHash?: string;
  pauses: number;
  params: string[];
  /** Why it cannot be installed. Empty when it can. */
  problems: string[];
  installed?: { version: number };
  /** The agent that asked, when one did. */
  by?: string;
  busy: boolean;
  error?: string;
}

export interface SourceInfo {
  id: string;
  kind: 'github' | 'folder';
  enabled: boolean;
  /** The shared routines of a repository an agent was started in. */
  project?: boolean;
  routines?: number;
  /** What is wrong with config.routine or a file it lists, with file, line and field. */
  problems?: string[];
  checkedAt?: number;
  error?: string;
}
export interface SourcesData {
  directory: boolean;
  sources: SourceInfo[];
}
export interface SourceEntries {
  source: string;
  kind: 'github' | 'folder';
  entries: SourceEntry[];
  skipped: number;
  /** From the repository's config.routine. */
  repo?: { name: string; description: string; instructions?: string };
  problems?: string[];
  error?: string;
}

export const list = () => native.call<SourcesData>('sources.list');
export const add = (address: string) => native.call('sources.add', { address });
export const remove = (id: string) => native.call('sources.remove', { id });
export const setEnabled = (id: string, enabled: boolean) => native.call('sources.setEnabled', { id, enabled });
export const entries = (id: string, fresh = false) => native.call<SourceEntries[]>('sources.entries', { id, fresh });

interface Preview {
  source: string;
  kind: 'github' | 'folder';
  path: string;
  ref?: string;
  routine: Routine;
  problems: string[];
  installed?: { version: number };
}

export async function preview(source: string, path: string, by?: string): Promise<GitCard> {
  const p = await native.call<Preview>('sources.preview', { id: source, path });
  return card(p.routine, { source, kind: p.kind, path, ref: p.ref, problems: p.problems, installed: p.installed, by });
}

async function card(r: Routine, o: Pick<GitCard, 'source' | 'kind' | 'path' | 'ref' | 'problems' | 'installed' | 'by'>): Promise<GitCard> {
  const hooks = r.meta.hooks && Object.keys(r.meta.hooks).length ? r.meta.hooks : undefined;
  return {
    ...o,
    name: r.meta.name,
    description: r.meta.description,
    site: r.meta.site,
    version: r.meta.version,
    instructions: r.meta.instructions,
    repoName: r.meta.repo?.name,
    repoInstructions: r.meta.repo?.instructions,
    body: r.body?.trim() || undefined,
    steps: r.steps.map((s) => ({ n: s.n, action: s.action, label: s.label, value: s.value, url: s.url, pause: !!s.pause })),
    hooks,
    hookHash: hooks ? await hookHash(hooks) : undefined,
    pauses: r.meta.pauses.length,
    params: Object.keys(r.meta.params),
    busy: false,
  };
}

/** A routine from the directory, fetched here so what the person reads is what gets saved, whatever the agent sent. */
export async function directoryPreview(id: string, by?: string): Promise<{ card: GitCard; routine: Routine }> {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Not a directory routine id.');
  const [owner, name] = id.split('/');
  if (owner === 'local') throw new Error('Not a directory routine id.');
  let res: Response;
  try {
    res = await fetch(`${API}/api/v1/routines/${owner}/${name}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('Could not reach the directory. Check the connection and try again.');
  }
  if (res.status === 404) throw new Error('Not in the directory.');
  if (!res.ok) throw new Error(`The directory answered ${res.status}.`);
  const f = (await res.json()) as { version: number; meta: Routine['meta']; body: string; steps: Routine['steps'] };
  const routine: Routine = { meta: { ...f.meta, name, owner, version: f.version }, body: f.body, steps: f.steps };
  let problems: string[];
  try {
    problems = checkFetched(routine);
  } catch {
    problems = ['The directory sent something that is not a routine.'];
  }
  const installed = await native
    .call<Routine>('store.read', { id })
    .then((r) => ({ version: r.meta.version }))
    .catch(() => undefined);
  return { routine, card: await card(routine, { source: owner, kind: 'directory', path: id, problems, installed, by }) };
}

/** Saves it at the commit the person was shown. */
export const install = (card: GitCard) => native.call<Routine>('sources.install', { id: card.source, path: card.path, ref: card.ref });
