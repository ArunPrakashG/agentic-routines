// How agent tabs behave. The person's to choose. An agent can read these and change them when asked to, and none of them
// loosens a limit: what guards the person lives elsewhere and is not reachable from here.

export interface Settings {
  /** Where a new agent tab goes. auto: this window, or a window of its own while another agent is working. */
  tabsWhere: 'auto' | 'window' | 'separate';
  grouping: 'session' | 'shared' | 'none';
  /** Minutes before an untouched tab an agent opened closes by itself. 0: never. */
  idleMinutes: 0 | 10 | 30 | 60;
  agentCursor: boolean;
  handoffNotifications: boolean;
}

export const DEFAULTS: Settings = { tabsWhere: 'auto', grouping: 'session', idleMinutes: 30, agentCursor: true, handoffNotifications: true };

let now: Settings = { ...DEFAULTS };
const listeners = new Set<() => void>();
export const onSettingsChanged = (fn: () => void) => void listeners.add(fn);
export const settings = () => now;

const CHOICES: { [K in keyof Settings]: readonly Settings[K][] } = {
  tabsWhere: ['auto', 'window', 'separate'],
  grouping: ['session', 'shared', 'none'],
  idleMinutes: [0, 10, 30, 60],
  agentCursor: [true, false],
  handoffNotifications: [true, false],
};

/** Only what is listed above, with a value it allows. Anything else is refused rather than stored. */
export async function changeSettings(change: Partial<Settings>) {
  for (const [k, v] of Object.entries(change)) {
    const allowed = CHOICES[k as keyof Settings] as readonly unknown[] | undefined;
    if (!allowed) throw new Error(`There is no setting called ${k} that can be changed from here.`);
    if (!allowed.includes(v)) throw new Error(`${k} can be ${allowed.join(', ')}.`);
  }
  now = { ...now, ...change };
  await browser.storage.local.set({ settings: now });
  for (const fn of listeners) fn();
  return now;
}

export function watchSettings() {
  void browser.storage.local.get('settings').then((s) => {
    now = { ...DEFAULTS, ...(s.settings as Partial<Settings> | undefined) };
    for (const fn of listeners) fn();
  });
}
