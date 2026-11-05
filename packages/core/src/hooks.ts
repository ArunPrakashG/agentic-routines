// What a hook is allowed to be, as far as a file can say. The sandbox that runs one and the directives it
// may return live in the extension; this is the part every reader of a routine shares.

export const HOOK_EVENTS = [
  'run.start',
  'run.end',
  'step.before',
  'step.after',
  'action.click.before',
  'action.click.after',
  'action.type.before',
  'action.type.after',
  'action.select.before',
  'action.select.after',
  'action.upload.before',
  'action.upload.after',
  'action.navigate.before',
  'action.navigate.after',
  'action.press.before',
  'action.press.after',
  'action.read.before',
  'action.read.after',
  'page.load',
  'step.changed',
  'pause.reached',
  'pause.approved',
  'error',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_LIMITS = {
  /** Characters of code in one hook. */
  code: 8_000,
  /** Characters of code in all the hooks of one routine. */
  total: 32_000,
  /** Hooks on one routine: one per event. */
  count: HOOK_EVENTS.length,
};

export const isHookEvent = (s: string): s is HookEvent => (HOOK_EVENTS as readonly string[]).includes(s);

/** The hooks of a routine: event name to code. One hook per event; it can do as many things as it likes. */
export type Hooks = Partial<Record<HookEvent, string>>;
