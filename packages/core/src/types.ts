import type { Viewport } from './viewport.ts';

// Shared shapes for recording, compiling and replaying routines.

import type { HookReport, Hooks } from './hooks.ts';

export type Action =
  | 'navigate'
  | 'click'
  | 'type'
  | 'clear'
  | 'select'
  | 'upload'
  | 'press'
  | 'wait'
  | 'read'
  | 'hover'
  | 'drag'
  | 'scroll'
  | 'set'
  | 'dialog'
  | 'handoff'
  | 'each'
  | 'if';

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
  /** The dialog the element sat in, by its name, when it sat in one. */
  modal?: string;
  /** The address of the frame it was in, when it was in one. */
  frame?: string;
}

/** A place on an element, as fractions of its box. For what has no finer name: a canvas, a map, a slider's track. */
export interface Spot {
  x: number;
  y: number;
}

/** How a pointer step was done, beyond the element it was done to. */
export interface Pointer {
  spot?: Spot;
  button?: 'left' | 'right' | 'middle';
  /** 2 is a double click. */
  count?: number;
  /** Keys held: "ctrl", "ctrl+shift". */
  mods?: string;
  /** drag: where it was let go. */
  to?: { target: Locator; spot?: Spot };
  /** scroll: pixels. */
  by?: { x: number; y: number };
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
  /** type/select/set/upload/press/dialog: a literal, "{{param}}" or "{{secret:name}}". handoff: what the person is asked to do. */
  value?: string;
  target?: Locator;
  page?: PageFingerprint;
  /** 64-bit dHash of the area around the element, hex. Absent for password fields. */
  crop?: string;
  /** Replay stops here and waits for approval. */
  pause?: 'auto' | 'author';
  /** Click whatever is first in the list now, not the item that was recorded, or in a loop over elements the one this pass is on. */
  pick?: 'first' | 'each';
  /** each: the next steps repeat. */
  each?: {
    /** One pass per value of this parameter, and in those steps {{param}} is that value. */
    param?: string;
    /** One pass per element like this one on the page. */
    matching?: Locator;
    /** How many steps repeat. */
    count: number;
    limit: number;
  };
  /** if: the next `then` steps run when the page has this, and the `else` steps after those when it does not. */
  when?: {
    /** Text on the page. Can use {{params}}. */
    text?: string;
    /** An element on the page. */
    has?: Locator;
    /** The other way round. */
    not?: boolean;
    then: number;
    else: number;
  };
  /** Text for the agent about this step: what to check, what a good result looks like. */
  instructions?: string;
  pointer?: Pointer;
  /** dialog: answer no. Its value is what to type in one that asks for text. */
  dismiss?: boolean;
}

export interface ParamSpec {
  type: 'string' | 'file';
  description?: string;
  accept?: string;
  /** The value seen when it was recorded, shown as the example. Never published. */
  example?: string;
}

/** Where a routine acts. Only the browser is implemented; the other value is reserved so the format does not break when it is. */
export type Surface = 'browser' | 'desktop';
export const SURFACES: Surface[] = ['browser', 'desktop'];

/** The longest a routine's check on its result can be, each part. */
export const MAX_EXPECT = 300;

export interface Expect {
  text?: string;
  url?: string;
}

export interface RoutineMeta {
  name: string;
  owner?: string;
  version: number;
  site: string;
  /** The pages it applies to, as globs (host and path, with * for an id). Worked out from the recorded pages unless the author sets them. */
  urls?: string[];
  /** Where it acts. Absent means browser. */
  surface?: Surface;
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
  /** Text for the agent from the routine's author: what to check, what to avoid. Untrusted when the author is someone else. */
  instructions?: string;
  /** How the page looks when the task worked. Every step can run and the task still not have happened. Text the page shows, part of the address; both can use {{params}}. */
  expect?: Expect;
  /** The repository the routine came from and what its config.routine tells the agent about the repository as a whole. */
  repo?: { name: string; instructions?: string };
  /** Code that runs on events during a replay, in a sandbox, and answers with directives. Off until the person approves it. */
  hooks?: Hooks;
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
  pointer?: Pointer;
  /** dialog: it was answered no. */
  dismiss?: boolean;
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
  /** A failed run with the flight recorder on: the video of its last minute. */
  flight_recording?: string;
  updated_to?: number;
  /** Pauses the user approved in the side panel, which the agent otherwise cannot see. */
  approved_in_panel?: string[];
  /** Set when the page is a very different size from the one the routine was recorded at. */
  viewport_note?: string;
  /** Set when a step did not match in a tab behind another: some pages only finish drawing in front. */
  hidden_note?: string;
  /** Where the tab went to the person and came back. */
  handoffs?: { n: number; reason: string }[];
  /** Steps that paused because they look irreversible, though the routine did not ask for it. */
  forced_pauses?: number[];
  /** A test of a draft: it stops at the first pause without approving it. */
  test?: boolean;
  /** Test only: steps that pause in a real run, which a test does not perform. */
  skipped?: number[];
  /** Test only: what each step did, in order. */
  trace?: string[];
  /** Test only: where the tab ended up. */
  final_url?: string;
  /** Present when the routine has hooks: whether they ran, and what they did. */
  hooks?: HookReport;
  /** The routine's own check on how a finished run looks. Absent when it has none or steps were skipped. */
  outcome?: { ok: boolean; wanted: string };
  /** How long each step took, by step number. */
  step_ms?: Record<number, number>;
  /** Every loop that ran: its step, how many passes, and why it stopped early when it did. */
  loops?: { n: number; passes: number; note?: string }[];
  /** Every branch that ran: its step, and which way it went each time. */
  branches?: { n: number; took: ('then' | 'else')[] }[];
  /** Notes the author left on the steps the run stopped at or changed, for the agent. */
  step_notes?: { n: number; label: string; text: string }[];
}
