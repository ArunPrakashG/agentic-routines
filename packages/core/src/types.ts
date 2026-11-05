import type { Viewport } from './viewport.ts';

// Shared shapes for recording, compiling and replaying routines.

export type Action =
  | 'navigate'
  | 'click'
  | 'type'
  | 'clear'
  | 'select'
  | 'upload'
  | 'press'
  | 'wait'
  | 'read';

/** Everything we know about an element, captured when it was used. */
export interface Locator {
  tag: string;
  role?: string;
  /** Accessible name: aria-label, label text, alt, title or own text. */
  name?: string;
  /** Visible text, trimmed to 80 chars. */
  text?: string;
  /** Stable attributes: id, name, data-testid, placeholder, type, href path. */
  attrs: Record<string, string>;
  /** Short CSS path from the nearest element with an id. */
  css: string;
  /** Nearest heading or section label above the element. */
  near?: string;
}

/** A cheap description of the page, used before every step. */
export interface PageFingerprint {
  url: string;
  title?: string;
  /** Headings, form labels and landmark names, in document order, max 40. */
  landmarks: string[];
}

export interface Step {
  n: number;
  action: Action;
  /** What a person reads in the panel: "Upload", "“Create internal testing release”". */
  label: string;
  /** navigate: target URL. */
  url?: string;
  /** type/select/upload/press: a literal, "{{param}}" or "{{secret:name}}". */
  value?: string;
  target?: Locator;
  page?: PageFingerprint;
  /** 64-bit dHash of the area around the element, hex. Absent for password fields. */
  crop?: string;
  /** Replay stops here and waits for approval. */
  pause?: 'auto' | 'author';
  /** Click whatever is first in the list now, not the item that was recorded. */
  pick?: 'first';
}

export interface ParamSpec {
  type: 'string' | 'file';
  description?: string;
  accept?: string;
  /** The value seen when it was recorded, shown as the example. Never published. */
  example?: string;
}

export interface RoutineMeta {
  name: string;
  owner?: string;
  version: number;
  site: string;
  /** What it does and when to use it. Must contain a "Use when" clause to publish. */
  description: string;
  params: Record<string, ParamSpec>;
  secrets: string[];
  pauses: number[];
  requires?: { signed_in?: string };
  returns?: string;
  /** The agent that wrote the description, e.g. "claude-code". */
  drafted_by?: string;
  /** The page size when its first element step was recorded. Absent in routines saved before this was kept. */
  viewport?: Viewport;
}

export interface Routine {
  meta: RoutineMeta;
  /** Markdown body of ROUTINE.md: "Before running", "Do not use for", notes. */
  body: string;
  steps: Step[];
}

/** One action as the recorder saw it, agent or human. */
export interface RecordedEvent {
  action: Action;
  url: string;
  ts: number;
  target?: Locator;
  value?: string;
  /** Field kind, so passwords are never kept and files become params. */
  field?: 'text' | 'password' | 'file' | 'select' | 'other';
  /** Field label, used to name params. */
  fieldLabel?: string;
  /** URL after the action settled, when the action caused a navigation. */
  navigatedTo?: string;
  page?: PageFingerprint;
  crop?: string;
  /** The page size at that moment. */
  view?: Viewport;
}

export interface Run {
  id: string;
  source: string;
  startedAt: number;
  events: RecordedEvent[];
}

export type RunStatus = 'done' | 'paused' | 'needs_choice' | 'failed';

export interface Candidate {
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  score: number;
}

export interface RunResult {
  run_id: string;
  status: RunStatus;
  routine: string;
  version: number;
  steps_run: number;
  steps_total: number;
  model_calls: number;
  ms: number;
  /** Set when paused or needs_choice. */
  at_step?: number;
  step_label?: string;
  candidates?: Candidate[];
  error?: string;
  /** Text read by "read" steps, keyed by label. */
  read?: Record<string, string>;
  updated_to?: number;
  /** Pauses the user approved in the side panel, which the agent otherwise cannot see. */
  approved_in_panel?: string[];
  /** Set when the page is a very different size from the one the routine was recorded at. */
  viewport_note?: string;
  /** Steps that paused because they look irreversible, though the routine did not ask for it. */
  forced_pauses?: number[];
}
