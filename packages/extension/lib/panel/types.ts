import type { RecordedEvent } from '@agentic-routines/core';
import type { Account } from './auth';
import type { PublishCard } from './directory';
import type { Hooks, HookState } from '@agentic-routines/core';
import type { GitCard } from './git';

export interface PanelState {
  account?: Account;
  connected: boolean;
  agents: string[];
  routines: { name: string; owner: string; version: number; site: string; description: string; enabled: boolean; lastRun?: number; changed?: number[]; draftedBy?: string; published?: { as: string; version: number }; origin?: { kind: 'directory' | 'github' | 'folder'; source: string; ref?: string }; blocked?: string; hooks?: { count: number; state: HookState; reason?: string } }[];
  runs: { id: string; source: string; startedAt: number; updatedAt: number; events: RecordedEvent[] }[];
  recording?: string;
  publish?: PublishCard;
  install?: GitCard;
  /** Hook code the person is reading to decide whether it may run. */
  hooksReview?: { id: string; name: string; hooks: Hooks; state: HookState; busy?: boolean; error?: string };
  replay?: {
    id: string;
    name: string;
    version: number;
    status: string;
    i: number;
    steps: { n: number; action: string; label: string; value?: string; pause: boolean }[];
    modelCalls: number;
    start: number;
    by?: string;
    handedBack: boolean;
    /** Steps the model matched again on this run; saved as the next version. */
    fixed: number[];
    error?: string;
  };
}

export type PanelCommand =
  | { t: 'save'; runId: string; name: string; description: string; fixed?: string[]; publish?: boolean }
  | { t: 'publish'; id: string }
  | { t: 'publishDecide'; approve: boolean; handle?: string }
  | { t: 'sources' }
  | { t: 'sourceAdd'; address: string }
  | { t: 'sourceRemove'; id: string }
  | { t: 'sourceSet'; id: string; enabled: boolean }
  | { t: 'sourceEntries'; id: string; fresh?: boolean }
  | { t: 'gitPreview'; source: string; path: string }
  | { t: 'gitDecide'; approve: boolean; hooks?: boolean }
  | { t: 'hooksReview'; id: string }
  | { t: 'hooksDecide'; approve: boolean }
  | { t: 'enable'; id: string; enabled: boolean }
  | { t: 'submissions' }
  | { t: 'withdraw'; id: string }
  | { t: 'discard'; runId: string }
  | { t: 'run'; id: string; params: Record<string, string> }
  | { t: 'decide'; id: string; approve: boolean }
  | { t: 'stop'; id: string }
  | { t: 'dismiss' }
  | { t: 'inputs'; id: string }
  | { t: 'record'; on: boolean }
  | { t: 'remove'; id: string }
  | { t: 'refresh' }
  | { t: 'signIn' }
  | { t: 'signOut' };
