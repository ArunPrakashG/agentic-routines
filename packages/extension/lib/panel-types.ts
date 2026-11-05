import type { RecordedEvent } from '@browser-routines/core';
import type { Account } from './auth';
import type { PublishCard } from './directory';

export interface PanelState {
  account?: Account;
  connected: boolean;
  agents: string[];
  routines: { name: string; owner: string; version: number; site: string; description: string; enabled: boolean; lastRun?: number; changed?: number[]; draftedBy?: string; published?: { as: string; version: number } }[];
  runs: { id: string; source: string; startedAt: number; updatedAt: number; events: RecordedEvent[] }[];
  recording?: string;
  publish?: PublishCard;
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
