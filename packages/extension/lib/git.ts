import type { Routine, SourceEntry } from '@browser-routines/core';
import * as native from './native';

// Installing from a Git source or a folder. The host does the fetching and every check; this side
// shows the person what was fetched and only installs after they click.

export interface GitCard {
  source: string;
  kind: 'github' | 'folder';
  path: string;
  ref?: string;
  name: string;
  description: string;
  site: string;
  version: number;
  steps: { n: number; action: string; label: string; value?: string; pause: boolean }[];
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
  routines?: number;
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
  const r = p.routine;
  return {
    source,
    kind: p.kind,
    path,
    ref: p.ref,
    name: r.meta.name,
    description: r.meta.description,
    site: r.meta.site,
    version: r.meta.version,
    steps: r.steps.map((s) => ({ n: s.n, action: s.action, label: s.label, value: s.value, pause: !!s.pause })),
    pauses: r.meta.pauses.length,
    params: Object.keys(r.meta.params),
    problems: p.problems,
    installed: p.installed,
    by,
    busy: false,
  };
}

/** Saves it at the commit the person was shown. */
export const install = (card: GitCard) => native.call<Routine>('sources.install', { id: card.source, path: card.path, ref: card.ref });
