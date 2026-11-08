import '@fontsource/schibsted-grotesk/latin-400.css';
import '@fontsource/schibsted-grotesk/latin-500.css';
import '@fontsource/schibsted-grotesk/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/roboto/latin-500.css';
import './tokens.css';
import './panel.css';
import { addSavings, compileRun, HOW_ESTIMATED, noSavings, roughTime, savingsOf, savingsText, siteOf, type ParamSpec } from '@agentic-routines/core';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { onPrivateNetwork } from '../../lib/agent/link';
import type { Account as AccountInfo } from '../../lib/remote/auth';
import type { LiveRoutine, Submission } from '../../lib/remote/directory';
import type { GitCard, SourceEntries, SourcesData } from '../../lib/remote/git';
import type { PanelCommand, PanelState } from '../../lib/panel/types';

// ---------- connection to the background ----------

type Reply = { reqId: number; ok?: boolean; result?: unknown; err?: string };
const port = browser.runtime.connect({ name: 'panel' });
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
let nextReq = 1;
// The first state can arrive before the app mounts; keep it.
let latest: PanelState | undefined;
let onState: (s: PanelState) => void = (s) => (latest = s);
port.onMessage.addListener((m: PanelState | Reply) => {
  if ('reqId' in m) {
    const p = pending.get(m.reqId);
    pending.delete(m.reqId);
    if (m.err) p?.rej(new Error(m.err));
    else p?.res(m.result);
  } else onState(m);
});
function send<T = unknown>(c: PanelCommand): Promise<T> {
  const reqId = nextReq++;
  return new Promise((res, rej) => {
    pending.set(reqId, { res, rej });
    port.postMessage({ ...c, reqId });
  });
}

// ---------- helpers ----------

const AGENT_NAMES = ['Claude Code', 'Codex', 'GitHub Copilot', 'OpenCode'];

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  if (d < 30) return d < 11 ? 'last week' : `${Math.round(d / 7)} weeks ago`;
  return d < 60 ? 'last month' : `${Math.round(d / 30)} months ago`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "console.firebase.google.com" -> "firebase-console" style starting name. */
function suggestName(url: string): string {
  const host = siteOf(url).replace(/^(www|console|dash|dashboard|app)\./, '');
  const base = host.split('.').slice(0, -1).join('-') || host;
  return (base.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40) || 'routine').replace(/^-|-$/g, '');
}

const MAC = /Mac/.test(navigator.platform);
const NAME_OK = /^[a-z0-9][a-z0-9-]{1,62}$/;

// ---------- icons ----------

const Mark = ({ size = 20, stroke = 'var(--accent-ink)', cls }: { size?: number; stroke?: string; cls?: string }) => (
  <svg class={cls} width={size} height={size} viewBox="0 0 22 22" aria-hidden="true">
    <path d="M3 5.5h12L5 11h12L7 16.5h13" fill="none" style={{ stroke }} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const Dot = ({ cls }: { cls?: string }) => (
  <svg class={cls} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <circle cx="5" cy="5" r="4" fill="currentColor" />
  </svg>
);
const Play = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />
  </svg>
);
const Back = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M10 3L5 8l5 5" />
  </svg>
);
const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M3 8.5l3 3 7-7" />
  </svg>
);
const PauseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M6 4v8M10 4v8" />
  </svg>
);
const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
const Undo = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M8 3v10M3 8h10" />
  </svg>
);
const Copy = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
    <path d="M10.5 5V3.5A1.5 1.5 0 009 2H3.5A1.5 1.5 0 002 3.5V9a1.5 1.5 0 001.5 1.5H5" />
  </svg>
);
const Pips = ({ colors, label }: { colors?: string[]; label: string }) => (
  <span class={colors ? 'pips' : 'pips scan'} role="img" aria-label={label}>
    {[0, 1, 2].map((i) => (
      <i key={i} style={colors ? { background: colors[i] } : undefined} />
    ))}
  </span>
);

// ---------- views ----------

type View = { v: 'library' } | { v: 'save'; runId: string } | { v: 'inputs'; id: string; name: string } | { v: 'submissions' } | { v: 'sources' } | { v: 'settings' };

function RecordButton({ on }: { on: boolean }) {
  return (
    <button class="btn btn-primary sm" type="button" aria-keyshortcuts="R" aria-pressed={on} onClick={() => send({ t: 'record', on: !on })}>
      <Dot cls={on ? 'rec-dot' : undefined} />
      {on ? 'Stop recording' : 'Record'}
    </button>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function SignIn({ s }: { s: PanelState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function go() {
    setBusy(true);
    setError(false);
    try {
      await send({ t: 'signIn' });
    } catch {
      setError(true);
    }
    setBusy(false);
  }
  return (
    <div class="panel">
      <main class="center signin">
        <Mark size={48} cls="drift" />
        <div class="stack" style={{ gap: '8px', alignItems: 'center' }}>
          <h1>Agentic Routines</h1>
          <p>Sign in once. Your routines follow you to every browser you use.</p>
        </div>
        <button class="gbtn" type="button" disabled={busy} onClick={go}>
          <GoogleG />
          Continue with Google
        </button>
        {error && (
          <p class="signin-error" role="alert">
            That didn't work. Try again.
          </p>
        )}
        <details>
          <summary>My agent is on another computer</summary>
          <LinkSettings s={s} />
        </details>
      </main>
      <footer class="signin-foot">Passwords you type are never saved.</footer>
    </div>
  );
}

function Account({ account, go }: { account: AccountInfo; go?: (v: View) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('pointerdown', away);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div class="account" ref={ref}>
      <button class="icon-btn" type="button" aria-label={`Account, ${account.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="avatar">{(account.name || account.email).charAt(0).toUpperCase()}</span>
      </button>
      {open && (
        <div class="account-menu">
          <span class="email">{account.email}</span>
          {go && (
            <button class="btn btn-secondary sm" type="button" onClick={() => { setOpen(false); go({ v: 'sources' }); }}>
              Sources
            </button>
          )}
          {go && (
            <button class="btn btn-secondary sm" type="button" onClick={() => { setOpen(false); go({ v: 'settings' }); }}>
              Settings
            </button>
          )}
          {go && (
            <button class="btn btn-secondary sm" type="button" onClick={() => { setOpen(false); go({ v: 'submissions' }); }}>
              Your submissions
            </button>
          )}
          {account.admin && (
            <button class="btn btn-secondary sm" type="button" onClick={() => browser.tabs.create({ url: browser.runtime.getURL('/admin.html' as any) })}>
              Review submissions
            </button>
          )}
          <button class="btn btn-secondary sm" type="button" onClick={() => send({ t: 'signOut' })}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const repoName = (id: string) => id.replace(/^https:\/\/github\.com\//, '');

function Choice<T extends string | number>({ label, value, options, set }: { label: string; value: T; options: [T, string][]; set: (v: T) => void }) {
  return (
    <label class="stack" style={{ gap: '4px' }}>
      <span class="k">{label}</span>
      <select value={String(value)} onChange={(e) => set(options.find(([v]) => String(v) === e.currentTarget.value)![0])}>
        {options.map(([v, name]) => (
          <option value={String(v)} key={String(v)}>{name}</option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.currentTarget.checked)} style={{ width: '16px', height: '16px' }} />
      <span>{label}</span>
    </label>
  );
}

/** The way to an agent on another computer. Only the person, here, can make one. */
function LinkSettings({ s }: { s: PanelState }) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [anyway, setAnyway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = useMemo(() => {
    try {
      return !!address.trim() && !onPrivateNetwork(address);
    } catch {
      return false;
    }
  }, [address]);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    setError('');
    return p.then(() => setCode(''), (e) => setError(e.message)).finally(() => setBusy(false));
  };
  if (s.link) {
    return (
      <section class="stack" style={{ gap: '8px' }} aria-label="Another computer">
        <span class="label">Another computer</span>
        <p>{s.link.connected ? `Connected to ${s.link.computer}. Agents there can use this browser with your sign-ins.` : `Not connected to ${s.link.computer}. Trying again.`}</p>
        {s.link.error && !s.link.connected && <div class="warnbox bad" role="alert">{s.link.error}</div>}
        <button class="btn" type="button" disabled={busy} onClick={() => void run(send({ t: 'linkForget' }))}>
          Disconnect
        </button>
      </section>
    );
  }
  return (
    <form class="stack" style={{ gap: '8px' }} aria-label="Another computer" onSubmit={(e) => { e.preventDefault(); void run(send({ t: 'linkPair', address, code, acceptOpen: anyway })); }}>
      <span class="label">Another computer</span>
      <p>If your agent runs on another computer, ask it for an address and a code. It can then use this browser with your sign-ins, so connect only to a computer of your own.</p>
      <label class="field">
        <span class="label">Address</span>
        <input class="input" value={address} autocomplete="off" spellcheck={false} onInput={(e) => setAddress(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span class="label">Code</span>
        <input class="input" value={code} autocomplete="off" spellcheck={false} onInput={(e) => setCode(e.currentTarget.value)} />
      </label>
      {open && (
        <div class="warnbox" role="note">
          <p>This address is not on a private network. Pages, what you type and your agent's commands could be read and changed on the way. Use Tailscale or an SSH tunnel instead.</p>
          <Toggle label="Connect anyway" on={anyway} set={setAnyway} />
        </div>
      )}
      {error && <div class="warnbox bad" role="alert">{error}</div>}
      <button class="btn btn-primary" type="submit" disabled={busy || !address.trim() || !code.trim() || (open && !anyway)}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}

function SettingsView({ s, back }: { s: PanelState; back: () => void }) {
  const c = s.settings;
  const set = (change: Partial<PanelState['settings']>) => void send({ t: 'setting', change });
  return (
    <div class="panel">
      <header class="bar back">
        <button class="icon-btn" type="button" aria-label="Back to routines" onClick={back}>
          ←
        </button>
        <h1>Settings</h1>
      </header>
      <main class="stack" style={{ gap: '16px', padding: '16px' }}>
        <Choice label="Agent tabs open in" value={c.tabsWhere} set={(tabsWhere) => set({ tabsWhere })} options={[['auto', 'This window, or their own if another agent is working'], ['window', 'This window'], ['separate', 'A separate window']]} />
        <Choice label="Tab groups" value={c.grouping} set={(grouping) => set({ grouping })} options={[['session', 'One for each agent'], ['shared', 'One for all agents'], ['none', 'None']]} />
        <Choice label="Close tabs an agent has left after" value={c.idleMinutes} set={(idleMinutes) => set({ idleMinutes })} options={[[10, '10 minutes'], [30, '30 minutes'], [60, '1 hour'], [0, 'Never']]} />
        <Toggle label="Show the agent's cursor on the page" on={c.agentCursor} set={(agentCursor) => set({ agentCursor })} />
        <Toggle label="Notify me when an agent hands me a tab" on={c.handoffNotifications} set={(handoffNotifications) => set({ handoffNotifications })} />
        <Toggle label="Move and type at a person's pace" on={c.humanInput} set={(humanInput) => set({ humanInput })} />
        <LinkSettings s={s} />
      </main>
    </div>
  );
}

function Sources({ back }: { back: () => void }) {
  const [data, setData] = useState<SourcesData>();
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string>();
  const [found, setFound] = useState<SourceEntries>();
  const load = () => send<SourcesData>({ t: 'sources' }).then(setData, (e) => setError(e.message));
  useEffect(() => void load(), []);
  const act = (p: Promise<unknown>) => p.then(() => { setError(''); return load(); }, (e) => setError(e.message));
  const add = async () => {
    setBusy(true);
    await act(send({ t: 'sourceAdd', address }).then(() => setAddress('')));
    setBusy(false);
  };
  const expand = (id: string) => {
    if (open === id) return setOpen(undefined);
    setOpen(id);
    setFound(undefined);
    send<SourceEntries[]>({ t: 'sourceEntries', id }).then((r) => setFound(r[0]), (e) => setError(e.message));
  };
  return (
    <div class="panel">
      <header class="bar back">
        <button class="icon-btn" type="button" aria-label="Back to routines" onClick={back}>
          <Back />
        </button>
        <h1>Sources</h1>
      </header>
      <main class="form" style={{ gap: '24px' }}>
        <p class="meta" style={{ margin: 0, whiteSpace: 'normal', fontSize: '13px', lineHeight: '20px' }}>
          Where routines can come from. Turn a source off and its routines stop appearing in search and can’t be installed. Routines you already have stay.
        </p>
        {error && (
          <span class="err" role="alert">
            {error}
          </span>
        )}
        {data && (
          <section class="subs srcs" aria-label="Sources" style={{ borderTop: '1px solid var(--border)' }}>
            <div class="src">
              <div class="stack" style={{ flex: 1 }}>
                <span class="top">
                  <span class="name">Directory</span>
                  <span class="tag ok">Reviewed</span>
                </span>
                <span class="meta">Reviewed before it is listed</span>
              </div>
              <Switch on={data.directory} label="Directory" set={(on) => act(send({ t: 'sourceSet', id: 'directory', enabled: on }))} />
            </div>
            {data.sources.map((x) => (
              <div key={x.id}>
                <div class="src">
                  <button class="src-name" type="button" aria-expanded={open === x.id} disabled={!x.enabled} onClick={() => expand(x.id)}>
                    <span class="name">{x.kind === 'folder' ? x.id.replace(/^\/home\/[^/]+/, '~') : repoName(x.id)}</span>
                    <span class="meta">
                      {x.kind === 'folder' ? 'Local folder' : 'GitHub'} · {!x.enabled ? 'turned off' : x.error ? 'could not be read' : `${x.routines ?? 0} routines${x.checkedAt ? ` · checked ${ago(x.checkedAt)}` : ''}`}
                    </span>
                  </button>
                  <Switch on={x.enabled} label={repoName(x.id)} set={(on) => act(send({ t: 'sourceSet', id: x.id, enabled: on }))} />
                </div>
                {x.error && <span class="err">{x.error}</span>}
                {open === x.id && (
                  <div class="entries">
                    {!found && <span class="meta">Reading…</span>}
                    {found?.error && <span class="err">{found.error}</span>}
                    {found?.repo && (
                      <div class="stack" style={{ gap: '2px' }}>
                        <span class="name">{found.repo.name}</span>
                        <span class="meta" style={{ whiteSpace: 'normal' }}>{found.repo.description}</span>
                      </div>
                    )}
                    {found?.problems?.map((p) => (
                      <span class="err mono" key={p} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{p}</span>
                    ))}
                    {found?.entries.map((e) => (
                      <div class="entry" key={e.path}>
                        <div class="stack" style={{ flex: 1 }}>
                          <span class="name">{e.name}</span>
                          <span class="meta">{e.site}{e.hooks ? ` · ${e.hooks} ${e.hooks === 1 ? 'hook' : 'hooks'}` : ''}</span>
                        </div>
                        <button class="btn btn-secondary sm" type="button" onClick={() => send({ t: 'gitPreview', source: x.id, path: e.path }).then(back, (er) => setError(er.message))}>
                          Review
                        </button>
                      </div>
                    ))}
                    {!!found?.skipped && <span class="meta">{found.skipped} {found.skipped === 1 ? 'file was' : 'files were'} not a routine and left out.</span>}
                    <button class="btn btn-ghost sm" type="button" onClick={() => act(send({ t: 'sourceRemove', id: x.id }).then(() => setOpen(undefined)))}>
                      Remove this source
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}
        <section class="stack" style={{ gap: '10px' }} aria-label="Add a source">
          <h2 class="h3">Add a source</h2>
          <form class="addsrc" onSubmit={(e) => { e.preventDefault(); if (address.trim() && !busy) add(); }}>
            <input class="input" type="text" aria-label="GitHub address or folder" spellcheck={false} placeholder="github.com/owner/repository" value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
            <button class="btn btn-secondary" type="submit" disabled={busy || !address.trim()}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </form>
          <span class="meta" style={{ whiteSpace: 'normal', lineHeight: '18px' }}>
            A GitHub repository or a folder on this computer. A <code>config.routine</code> file in its root lists the routines, or they are <code>.md</code> files in a <code>routines</code> folder.
          </span>
          <span class="meta" style={{ whiteSpace: 'normal', lineHeight: '18px' }}>
            Only the Directory is reviewed by us. For anything else, you see every step before it installs.
          </span>
        </section>
      </main>
    </div>
  );
}

function Switch({ on, label, set }: { on: boolean; label: string; set: (on: boolean) => void }) {
  return <button class="sw" type="button" role="switch" aria-checked={on} aria-label={`${label} on`} onClick={() => set(!on)} />;
}

function HookCode({ hooks }: { hooks: Record<string, string> }) {
  return (
    <div class="hooks">
      {Object.entries(hooks).map(([event, code]) => (
        <div class="hook" key={event}>
          <span class="mono ev">{event}</span>
          <pre class="mono" tabIndex={0}>{code}</pre>
        </div>
      ))}
    </div>
  );
}

function HooksReview({ r }: { r: NonNullable<PanelState['hooksReview']> }) {
  return (
    <div class="panel">
      <header class="bar back">
        <button class="icon-btn" type="button" aria-label="Close" onClick={() => send({ t: 'hooksDecide', approve: r.state === 'on' })}>
          <Back />
        </button>
        <h1>Hooks</h1>
      </header>
      <main class="form install" style={{ gap: '16px' }}>
        <span class="title mono">{r.name}</span>
        <div class="warnbox" role="note">
          <span class="wt">Code written by someone else</span>
          <span class="meta">Hooks run on events while this routine replays. They run in a sandbox with no network, and can only ask the extension to skip a step, fill a value, click, type, wait, go to a page on this site, leave a note, stop or pause. They cannot approve a pause.</span>
        </div>
        {r.state === 'off' && <span class="meta" style={{ whiteSpace: 'normal' }}>Off until you allow them. If the code changes, you are asked again.</span>}
        <HookCode hooks={r.hooks} />
        <div class="foot2 sticky">
          <button class="btn btn-ghost" type="button" onClick={() => send({ t: 'hooksDecide', approve: false })}>
            {r.state === 'on' ? 'Turn off' : 'Keep off'}
          </button>
          <button class="btn btn-primary" type="button" disabled={r.state === 'on'} onClick={() => send({ t: 'hooksDecide', approve: true })}>
            {r.state === 'on' ? 'Allowed' : 'Allow these hooks'}
          </button>
        </div>
      </main>
    </div>
  );
}

function InstallGit({ card }: { card: GitCard }) {
  const [all, setAll] = useState(false);
  const [hooks, setHooks] = useState(false);
  const shown = all ? card.steps : card.steps.slice(0, 4);
  const blocked = card.problems.length > 0;
  return (
    <div class="panel">
      <header class="bar back">
        <button class="icon-btn" type="button" aria-label="Cancel" disabled={card.busy} onClick={() => send({ t: 'gitDecide', approve: false })}>
          <Back />
        </button>
        <h1>Install routine</h1>
      </header>
      <main class="form install" style={{ gap: '16px' }}>
        <div class="stack" style={{ gap: '2px' }}>
          <span class="mono" style={{ fontSize: '13px' }}>{card.kind === 'folder' ? card.source.replace(/^\/home\/[^/]+/, '~') : repoName(card.source)}</span>
          <span class="meta mono">{card.path}{card.ref ? ` · ${card.ref.slice(0, 7)}` : ''}</span>
        </div>
        <div class="warnbox" role="note">
          <span class="wt">Not reviewed by Agentic Routines</span>
          <span class="meta">{card.by ? `${card.by} asked for this. ` : ''}Anyone can put a routine in a repository. Read the steps before you install.</span>
        </div>
        <div class="stack" style={{ gap: '6px' }}>
          <span class="title mono">{card.name}</span>
          <span class="desc" style={{ fontSize: '13px', lineHeight: '19px', color: 'var(--text-2)', overflowWrap: 'anywhere' }}>{card.description}</span>
        </div>
        <div class="facts">
          <span><b>{card.steps.length}</b> steps</span>
          <span><b>{card.pauses}</b> {card.pauses === 1 ? 'pause' : 'pauses'}</span>
          <span><b>{card.params.length}</b> {card.params.length === 1 ? 'input' : 'inputs'}{card.params.length ? `: ${card.params.join(', ')}` : ''}</span>
        </div>
        <section class="gsteps" aria-label="Steps">
          {shown.map((x) => (
            <div class={x.pause ? 'gstep flag' : 'gstep'} key={x.n}>
              <span class="n">{x.n}</span>
              <span>{x.action}</span>
              <span class="t">{x.action === 'navigate' || x.action === 'type' || x.action === 'select' ? (x.value ?? x.label) : x.label}</span>
              {x.pause && <span class="tag warn">pause</span>}
            </div>
          ))}
          {card.steps.length > 4 && (
            <button class="btn btn-ghost sm" type="button" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `${card.steps.length - 4} more · Show all`}
            </button>
          )}
        </section>
        {(card.instructions || card.repoInstructions) && (
          <div class="stack" style={{ gap: '6px' }}>
            <span class="meta">Notes the author wrote for your agent</span>
            {card.repoInstructions && (
              <span class="desc" style={{ fontSize: '13px', lineHeight: '19px', color: 'var(--text-2)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                {card.repoName ? `${card.repoName}: ` : ''}{card.repoInstructions}
              </span>
            )}
            {card.instructions && (
              <span class="desc" style={{ fontSize: '13px', lineHeight: '19px', color: 'var(--text-2)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{card.instructions}</span>
            )}
            <span class="meta" style={{ whiteSpace: 'normal' }}>Your agent sees these marked as written by someone else.</span>
          </div>
        )}
        {card.hooks && (
          <div class="stack" style={{ gap: '8px' }}>
            <span class="meta">This routine has hooks: code that runs while it replays</span>
            <HookCode hooks={card.hooks} />
            <label class="allow">
              <Switch on={hooks} label="Allow these hooks to run" set={setHooks} />
              <span>Allow these hooks to run</span>
            </label>
            <span class="meta" style={{ whiteSpace: 'normal' }}>
              {hooks ? 'They run in a sandbox with no network.' : 'Off, the routine runs without them. You can read and allow them later from the library.'}
            </span>
          </div>
        )}
        {blocked ? (
          <div class="warnbox bad" role="alert">
            <span class="wt">It can’t be installed</span>
            {card.problems.map((p) => (
              <span class="meta" key={p}>{p}</span>
            ))}
          </div>
        ) : (
          <ul class="ticks">
            <li>Every step stays on <span class="mono">{card.site}</span></li>
            <li>No saved passwords or tokens</li>
            <li>It runs in your signed-in browser, so it can do anything you can on that site</li>
          </ul>
        )}
        {card.installed && <span class="meta" style={{ whiteSpace: 'normal' }}>You have v{card.installed.version}. This replaces it.</span>}
        {card.error && <span class="err" role="alert">{card.error}</span>}
        <div class="foot2">
          <button class="btn btn-ghost" type="button" disabled={card.busy} onClick={() => send({ t: 'gitDecide', approve: false })}>
            Cancel
          </button>
          <button class="btn btn-primary" type="button" disabled={card.busy || blocked} onClick={() => send({ t: 'gitDecide', approve: true, hooks })}>
            {card.busy ? 'Installing…' : 'Install'}
          </button>
        </div>
        {card.ref && (
          <span class="meta" style={{ whiteSpace: 'normal', lineHeight: '18px' }}>
            Pinned to commit <span class="mono">{card.ref.slice(0, 7)}</span>. Later changes are never applied on their own: you will see what changed first.
          </span>
        )}
      </main>
    </div>
  );
}

function Onboarding({ s, onDone }: { s: PanelState; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const cmd = 'npx agentic-routines setup';
  return (
    <div class="panel">
      <header class="bar">
        <div class="brand">
          <Mark />
          <h1>Routines</h1>
        </div>
        {s.account && <Account account={s.account} />}
      </header>
      <main class="onb">
        <div class="stack" style={{ gap: '6px' }}>
          <h2>Connect your agent</h2>
          <p>Run this once in a terminal. It sets up every agent it finds.</p>
        </div>
        <details>
          <summary>My agent is on another computer</summary>
          <LinkSettings s={s} />
        </details>
        <div class="cmd">
          <span>
            <span style={{ color: 'var(--text-3)' }}>$ </span>
            {cmd}
          </span>
          <button
            class="icon-btn"
            type="button"
            aria-label={copied ? 'Copied' : 'Copy command'}
            onClick={() => navigator.clipboard.writeText(cmd).then(() => setCopied(true))}
          >
            {copied ? <Check /> : <Copy />}
          </button>
        </div>
        <div class="list" role="list" aria-label="Agents">
          {AGENT_NAMES.map((name) => {
            const on = s.agents.includes(name);
            return (
              <div class="agent" role="listitem" key={name}>
                <span>{name}</span>
                {on ? (
                  <span class="st settle" style={{ color: 'var(--accent-ink)' }}>
                    <Check />
                    Connected
                  </span>
                ) : (
                  <span class="st" style={{ color: 'var(--text-3)' }}>
                    <Pips label="Waiting" />
                    Waiting
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </main>
      <footer>
        <button class="btn btn-primary" type="button" style={{ width: '100%' }} disabled={!s.connected} onClick={onDone}>
          Done
        </button>
      </footer>
    </div>
  );
}

function ScriptCard({ card }: { card: NonNullable<PanelState['script']> }) {
  return (
    <section class="pubcard" aria-label="Allow a script">
      <div class="stack" style={{ gap: '6px' }}>
        <span class="k">{card.by} wants to run a script</span>
        <span class="title mono">{card.site}</span>
        <span class="meta">It can do anything you can do on this site, as you.</span>
      </div>
      <pre class="script-code">{card.code}</pre>
      <div class="foot2">
        <button class="btn btn-ghost" type="button" onClick={() => send({ t: 'scriptDecide', answer: 'no' })}>
          No
        </button>
        <button class="btn btn-secondary" type="button" onClick={() => send({ t: 'scriptDecide', answer: 'once' })}>
          This once
        </button>
        <button class="btn btn-primary" type="button" onClick={() => send({ t: 'scriptDecide', answer: 'always' })}>
          Always on this site
        </button>
      </div>
    </section>
  );
}

function LentTabs({ tabs }: { tabs: PanelState['lent'] }) {
  return (
    <section class="stack" aria-label="Tabs you have lent" style={{ gap: '6px' }}>
      <span class="k">Lent to agents</span>
      {tabs.map((t) => (
        <div class="script-site" key={t.id}>
          <span class="mono">{t.site}{t.by ? ` · ${t.by}` : ''}</span>
          <button class="btn btn-ghost sm" type="button" aria-label={`Take back ${t.title || t.site}`} onClick={() => send({ t: 'takeBack', tabId: t.id })}>
            Take back
          </button>
        </div>
      ))}
    </section>
  );
}

function ScriptSites({ sites }: { sites: string[] }) {
  return (
    <section class="stack" aria-label="Sites that allow scripts" style={{ gap: '6px' }}>
      <span class="k">Agents can run scripts on</span>
      {sites.map((site) => (
        <div class="script-site" key={site}>
          <span class="mono">{site}</span>
          <button class="btn btn-ghost sm" type="button" aria-label={`Stop allowing scripts on ${site}`} onClick={() => send({ t: 'scriptForget', site })}>
            Stop
          </button>
        </div>
      ))}
    </section>
  );
}

function PublishCard({ card }: { card: NonNullable<PanelState['publish']> }) {
  const [handle, setHandle] = useState('');
  const bad = card.needsHandle && !/^[a-z0-9][a-z0-9-]{2,29}$/.test(handle.trim().toLowerCase());
  if (card.done) {
    return (
      <section class="pubcard" aria-label="Sent for review">
        <div class="stack" style={{ gap: '6px' }}>
          <span class="title">Sent for review</span>
          <span class="meta">
            {card.done.as} v{card.done.version} is private until it is approved. You will see the decision under Your submissions.
          </span>
        </div>
        <button class="btn btn-secondary sm" type="button" onClick={() => send({ t: 'publishDecide', approve: false })}>
          Done
        </button>
      </section>
    );
  }
  return (
    <section class="pubcard" aria-label="Submit for review">
      <div class="stack" style={{ gap: '6px' }}>
        <span class="k">{card.by ? `${card.by} wants to submit` : 'Submit for review'}</span>
        <span class="title mono">{card.name}</span>
        <span class="meta">
          {card.site} · {card.steps} steps. We read every submission against the guidelines before it is listed. Until then it stays private.
        </span>
      </div>
      {card.shown.length > 0 ? (
        <div class="stack" style={{ gap: '4px' }}>
          <span class="label">These values become public</span>
          {card.shown.map((l) => (
            <span class="publine mono" key={l}>
              {l}
            </span>
          ))}
          {card.more > 0 && <span class="meta">and {card.more} more</span>}
        </div>
      ) : (
        <span class="meta">No typed values or addresses with details in it. Your own example values stay on this machine.</span>
      )}
      {card.needsHandle && (
        <label class="field">
          <span>Your name in the directory. You pick it once.</span>
          <input class="input" type="text" value={handle} spellcheck={false} placeholder="arun" aria-invalid={!!handle && bad} onInput={(e) => setHandle(e.currentTarget.value.toLowerCase())} />
        </label>
      )}
      {card.error && (
        <span class="err" role="alert">
          {card.error}
        </span>
      )}
      <div class="foot2">
        <button class="btn btn-ghost" type="button" disabled={card.busy} onClick={() => send({ t: 'publishDecide', approve: false })}>
          Not now
        </button>
        <button class="btn btn-primary" type="button" disabled={card.busy || bad} onClick={() => send({ t: 'publishDecide', approve: true, handle })}>
          {card.busy ? 'Sending…' : 'Submit for review'}
        </button>
      </div>
    </section>
  );
}

const GUIDELINES: Record<string, string> = {
  G1: 'One clear job',
  G2: 'Stay on one site',
  G3: 'Nothing personal or secret',
  G4: 'Pause before what cannot be undone',
  G5: 'No harm or deception',
  G6: 'Respect the site and the person',
  G7: 'Be honest about who made it',
  G8: 'Keep it working',
  G9: 'Hooks and notes stay honest',
};

function Submissions({ s, back }: { s: PanelState; back: () => void }) {
  const [data, setData] = useState<{ routines: LiveRoutine[]; submissions: Submission[] }>();
  const [error, setError] = useState('');
  const load = () => send<{ routines: LiveRoutine[]; submissions: Submission[] }>({ t: 'submissions' }).then(setData, (e) => setError(e.message));
  useEffect(() => void load(), []);
  const mine = new Set(s.routines.filter((r) => r.owner === 'local').map((r) => r.name));
  const fix = (name: string) => {
    send({ t: 'publish', id: `local/${name}` }).catch(() => {});
    back();
  };

  // What is waiting or was turned down, newest per routine, and only if it is newer than what is live.
  const latest = new Map<string, Submission>();
  for (const x of data?.submissions ?? []) if (!latest.has(x.name) && x.status !== 'withdrawn') latest.set(x.name, x);
  const live = new Map((data?.routines ?? []).map((r) => [r.name, r]));
  const open = [...latest.values()].filter((x) => x.status === 'pending' || (x.status === 'rejected' && x.version > (live.get(x.name)?.version ?? 0)));
  const rows = (data?.routines ?? []).filter((r) => !latest.get(r.name) || !open.includes(latest.get(r.name)!));

  return (
    <div class="panel">
      <header class="bar back">
        <button class="icon-btn" type="button" aria-label="Back to routines" onClick={back}>
          <Back />
        </button>
        <h1>Your submissions</h1>
      </header>
      <main class="form">
        <p class="meta" style={{ margin: 0, whiteSpace: 'normal' }}>
          What you sent to the directory, and where each one stands. A rejection names the guideline and says what to change.
        </p>
        {error && (
          <span class="err" role="alert">
            {error}
          </span>
        )}
        {data && open.length + rows.length === 0 && <span class="meta">Nothing sent yet. Submit a saved routine from the library.</span>}
        <section class="subs" aria-label="Submissions">
          {open.map((x) => {
            const waiting = x.status === 'pending';
            return (
              <div class="sub" key={x.id}>
                <span class="top">
                  <span class="name">{x.name} <small>v{x.version}</small></span>
                  <span class={waiting ? 'tag warn' : 'tag bad'}>{waiting ? 'Waiting for review' : 'Rejected'}</span>
                </span>
                <span class="meta">
                  {waiting
                    ? `Submitted ${ago(Date.parse(x.submitted_at))}${live.has(x.name) ? ` · v${live.get(x.name)!.version} stays listed` : ''}`
                    : `${x.guideline} ${GUIDELINES[x.guideline ?? ''] ?? ''} · ${ago(Date.parse(x.decided_at ?? x.submitted_at))}`}
                </span>
                <span class="desc">{waiting ? 'We read every submission before it is listed.' : x.note}</span>
                {waiting ? (
                  <button class="btn btn-secondary sm" type="button" onClick={() => send({ t: 'withdraw', id: x.id }).then(load, (e) => setError(e.message))}>
                    Withdraw
                  </button>
                ) : (
                  mine.has(x.name) && (
                    <button class="btn btn-secondary sm" type="button" onClick={() => fix(x.name)}>
                      Fix and resubmit
                    </button>
                  )
                )}
              </div>
            );
          })}
          {rows.map((r) => (
            <div class="sub" key={r.name}>
              <span class="top">
                <span class="name">{r.name} <small>v{r.version}</small></span>
                <span class={r.disabled ? 'tag bad' : 'tag ok'}>{r.disabled ? 'Turned off' : 'Live'}</span>
              </span>
              <span class="meta">{r.disabled ? 'Not listed, and it stopped installing.' : `${r.installs} installs`}</span>
              {r.disabled && <span class="desc">{r.disabled_reason}</span>}
              {r.disabled && mine.has(r.name) && (
                <button class="btn btn-secondary sm" type="button" onClick={() => fix(r.name)}>
                  Fix and resubmit
                </button>
              )}
            </div>
          ))}
        </section>
        <span class="meta" style={{ whiteSpace: 'normal' }}>
          Every submission is read against the directory guidelines before it is listed.
        </span>
      </main>
    </div>
  );
}

/** The week's replays: what was measured, then what was estimated from them. */
function Saved({ s }: { s: PanelState }) {
  const week = s.routines.map((r) => savingsOf(r.stats, Date.now() - 7 * 24 * 60 * 60_000)).reduce(addSavings, noSavings());
  if (!week.runs) return null;
  return (
    <section class="saved" aria-label="What routines saved this week">
      <span class="name">This week</span>
      <span class="meta">
        {week.runs} replay{week.runs === 1 ? '' : 's'} took {roughTime(week.replayMs)} with {week.calls} model call{week.calls === 1 ? '' : 's'} (measured)
      </span>
      <span class="meta">{savingsText(week)} (estimated)</span>
      <details>
        <summary class="meta">How this is worked out</summary>
        <p class="meta">{HOW_ESTIMATED}</p>
      </details>
    </section>
  );
}

function Library({ s, go }: { s: PanelState; go: (v: View) => void }) {
  const recording = !!s.recording;
  const empty = !s.routines.length && !s.runs.length;
  return (
    <div class="panel">
      <header class="bar">
        <div class="brand">
          <Mark />
          <h1>Routines</h1>
        </div>
        <div class="bar-end">
          {(!empty || recording) && <RecordButton on={recording} />}
          {s.account && <Account account={s.account} go={go} />}
        </div>
      </header>
      {empty && !recording && !s.script && !s.publish ? (
        <main class="center">
          <Mark size={56} stroke="var(--border-strong)" cls="drift" />
          <div class="stack" style={{ gap: '8px', alignItems: 'center' }}>
            <h2>No routines yet</h2>
            <p>Runs from Claude Code, Codex, Copilot and OpenCode show up here. Or record one yourself.</p>
          </div>
          <button class="btn btn-primary" type="button" aria-keyshortcuts="R" onClick={() => send({ t: 'record', on: true })}>
            <Dot />
            Record a demo <kbd>R</kbd>
          </button>
        </main>
      ) : (
        <main class="lib">
          {s.script && <ScriptCard card={s.script} />}
          {s.publish && <PublishCard card={s.publish} />}
          {s.runs.map((r) => {
            const live = r.id === s.recording;
            const site = r.events[0] ? siteOf(r.events[0].url) : 'New run';
            return (
              <section class="unsaved" aria-label="Unsaved run" key={r.id}>
                <div class="stack">
                  <span class="title">
                    {site} · {r.events.length} {r.events.length === 1 ? 'step' : 'steps'}
                  </span>
                  <span class="meta">
                    {r.source} · {live ? 'recording' : ago(r.updatedAt)} · not saved
                  </span>
                </div>
                <button class="btn btn-secondary sm" type="button" disabled={live} onClick={() => go({ v: 'save', runId: r.id })}>
                  Save
                </button>
              </section>
            );
          })}
          <Saved s={s} />
          {s.routines.length > 0 && (
            <section aria-label="Saved routines" style={{ display: 'flex', flexDirection: 'column' }}>
              {s.routines.map((r) => (
                <div class={r.enabled ? 'row' : 'row off'} key={r.owner + '/' + r.name}>
                  <div class="stack" style={{ flex: 1 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span class="name">{r.name}</span>
                      {r.owner !== 'local' && <span class="badge">by {r.owner.replace(/^(gh|folder)_/, '')}</span>}
                      {r.origin && r.origin.kind !== 'directory' && <span class="tag warn">Not reviewed</span>}
                    </span>
                    <span class="desc">{r.description.split(/\bUse when\b/i)[0].trim() || r.description}</span>
                    <span class="meta">
                      {r.site} · v{r.version}
                      {r.draftedBy ? ` · drafted by ${r.draftedBy}` : ''}
                      {r.published ? ` · sent for review v${r.published.version}` : ''}
                      {r.lastRun ? ` · ran ${ago(r.lastRun)}` : ''}
                    </span>
                    {!!r.stats?.recent.length && <span class="meta">{savingsText(savingsOf(r.stats))} over {r.stats.recent.length} run{r.stats.recent.length === 1 ? '' : 's'} (estimated)</span>}
                    {r.blocked && <span class="changed">Turned off: {r.blocked}</span>}
                    {r.hooks?.state === 'unsupported' && <span class="changed">Hooks need Chromium and are off here</span>}
                    {r.hooks && r.hooks.state !== 'unsupported' && (
                      <button
                        class={r.hooks.state === 'on' ? 'hooklink' : 'hooklink off'}
                        type="button"
                        aria-label={`${r.hooks.state === 'on' ? 'See hooks of' : 'Review hooks of'} ${r.name}`}
                        onClick={() => send({ t: 'hooksReview', id: `${r.owner}/${r.name}` })}
                      >
                        {r.hooks.state === 'on' ? 'Hooks allowed · see the code' : r.hooks.reason?.startsWith('They changed') ? 'Hooks changed, off until you read them' : 'Hooks are off until you read them'}
                      </button>
                    )}
                    {!!r.changed?.length && (
                      <span class="changed">
                        {r.changed.length === 1 ? 'Step' : 'Steps'} {r.changed.join(', ')} changed on the last run
                      </span>
                    )}
                  </div>
                  {!r.enabled && !r.blocked && (
                    <button class="btn btn-ghost sm" type="button" aria-label={`Turn ${r.name} on`} onClick={() => send({ t: 'enable', id: `${r.owner}/${r.name}`, enabled: true })}>
                      Turn on
                    </button>
                  )}
                  {r.owner === 'local' && !s.publish && (
                    <button class="btn btn-ghost sm" type="button" aria-label={`Submit ${r.name} for review`} onClick={() => send({ t: 'publish', id: `local/${r.name}` })}>
                      Submit
                    </button>
                  )}
                  <button
                    class="icon-btn"
                    type="button"
                    aria-label={`Run ${r.name}`}
                    disabled={!!s.replay || !r.enabled}
                    onClick={() => go({ v: 'inputs', id: `${r.owner}/${r.name}`, name: r.name })}
                  >
                    <Play />
                  </button>
                </div>
              ))}
            </section>
          )}
          {s.lent.length > 0 && <LentTabs tabs={s.lent} />}
          {s.scriptSites.length > 0 && <ScriptSites sites={s.scriptSites} />}
        </main>
      )}
    </div>
  );
}

function Save({ s, runId, back }: { s: PanelState; runId: string; back: () => void }) {
  const run = s.runs.find((r) => r.id === runId);
  const [name, setName] = useState(() => (run?.events[0] ? suggestName(run.events.find((e) => e.action !== 'navigate')?.url ?? run.events[0].url) : ''));
  const [desc, setDesc] = useState('');
  const [fixed, setFixed] = useState<string[]>([]);
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const preview = useMemo(() => {
    if (!run) return undefined;
    try {
      const all = compileRun(run, { name: name || 'x', description: desc });
      const kept = compileRun(run, { name: name || 'x', description: desc, fixed });
      return { params: all.routine.meta.params, kept };
    } catch {
      return undefined;
    }
  }, [run, fixed]);

  if (!run) {
    back();
    return null;
  }
  const nameBad = !!name && !NAME_OK.test(name);
  const descBad = !!desc && !/\buse when\b/i.test(desc);
  const ok = NAME_OK.test(name) && /\buse when\b/i.test(desc) && desc.trim().length >= 20 && !!preview;
  const steps = preview?.kept.routine.steps ?? [];
  const pauses = steps.filter((x) => x.pause);

  async function save() {
    setBusy(true);
    setErr('');
    try {
      await send({ t: 'save', runId, name, description: desc.trim(), fixed, publish });
      back();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div class="panel">
      <header class="bar back">
        <button class="icon-btn" type="button" aria-label="Back to routines" onClick={back}>
          <Back />
        </button>
        <h1>Save routine</h1>
      </header>
      <main class="form">
        <label class="field">
          <span>Name</span>
          <input class="input" type="text" value={name} aria-invalid={nameBad} spellcheck={false} onInput={(e) => setName(e.currentTarget.value.toLowerCase())} />
          {nameBad && <span class="err">Lowercase letters, numbers and dashes.</span>}
        </label>
        <label class="field">
          <span>When to use</span>
          <textarea
            class="input"
            rows={3}
            value={desc}
            aria-invalid={descBad}
            placeholder="What it does. Use when the user asks to …"
            onInput={(e) => setDesc(e.currentTarget.value)}
          />
          {descBad && <span class="err">Add “Use when …” so agents know when to pick it.</span>}
        </label>

        {preview && Object.keys(preview.params).length > 0 && (
          <section aria-labelledby="vals" class="field">
            <h2 id="vals" class="label">
              Asked each run
            </h2>
            <div class="list">
              {Object.entries(preview.params).map(([p, spec]) => {
                const off = fixed.includes(p);
                return (
                  <div class="prow" key={p}>
                    <span class={off ? 'chip off' : 'chip'}>{`{{${p}}}`}</span>
                    <span class="ex">{spec.example}</span>
                    <button
                      class="icon-btn sm"
                      type="button"
                      aria-label={off ? `Ask for ${p} each run` : `Keep ${p} fixed`}
                      onClick={() => setFixed(off ? fixed.filter((x) => x !== p) : [...fixed, p])}
                    >
                      {off ? <Undo /> : <Cross />}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section aria-labelledby="steps" class="field">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 id="steps" class="label">
              Steps
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>
              {preview && steps.length < preview.kept.recorded ? (
                <>
                  <span style={{ color: 'var(--text-1)' }}>{steps.length}</span> of {preview.kept.recorded} recorded
                </>
              ) : (
                `${steps.length} recorded`
              )}
            </span>
          </div>
          <div class="steps-box">
            {steps.map((st) => (
              <div class="step" key={st.n}>
                <span class="n">{st.n}</span>
                <span class="v">{st.action === 'navigate' ? 'open' : st.action}</span>
                <span class="t">
                  {st.value && /^\{\{/.test(st.value) ? <span class="chip">{st.value.replace('secret:', '')}</span> : st.label}
                </span>
                {st.n === 1 && steps.length < preview!.kept.recorded ? <span class="tag">direct URL</span> : <span />}
              </div>
            ))}
          </div>
          {pauses.map((p) => (
            <div class="note" key={p.n}>
              <PauseIcon />
              Pauses before step {p.n}, {p.label}
            </div>
          ))}
        </section>
        {err && <span class="err">{err}</span>}
      </main>
      <footer class="foot2">
        <label class="check" style={{ gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.currentTarget.checked)} style={{ width: '16px', height: '16px', margin: 0, accentColor: 'var(--accent)' }} />
          Submit to the directory for review
        </label>
        <button class="btn btn-ghost" type="button" onClick={() => send({ t: 'discard', runId }).then(back)}>
          Discard
        </button>
        <button class="btn btn-primary" type="button" disabled={!ok || busy || !s.connected} onClick={save}>
          Save routine
        </button>
      </footer>
    </div>
  );
}

function Inputs({ id, name, back }: { id: string; name: string; back: () => void }) {
  const [spec, setSpec] = useState<{ params: Record<string, ParamSpec>; secrets: string[] }>();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const started = useRef(false);

  useEffect(() => {
    send<{ params: Record<string, ParamSpec>; secrets: string[] }>({ t: 'inputs', id })
      .then((r) => {
        setSpec(r);
        // Nothing to ask: start right away.
        if (!Object.keys(r.params).length && !r.secrets.length && !started.current) {
          started.current = true;
          send({ t: 'run', id, params: {} }).catch((e) => setErr(e.message));
        }
      })
      .catch((e) => setErr(e.message));
  }, [id]);

  const keys = spec ? [...Object.keys(spec.params), ...spec.secrets.map((x) => `secret:${x}`)] : [];
  const ok = keys.every((k) => vals[k]?.trim());
  const run = () => send({ t: 'run', id, params: vals }).catch((e) => setErr(e.message));

  return (
    <div class="panel">
      <header class="bar back">
        <button class="icon-btn" type="button" aria-label="Back to routines" onClick={back}>
          <Back />
        </button>
        <h1 class="mono">{name}</h1>
      </header>
      <main class="form">
        {spec &&
          Object.entries(spec.params).map(([p, sp]) => (
            <label class="field" key={p}>
              <span>
                <span>{p}</span>
                <span>{sp.type === 'file' ? 'File path' : sp.description}</span>
              </span>
              <input class="input" type="text" spellcheck={false} value={vals[p] ?? ''} onInput={(e) => setVals({ ...vals, [p]: e.currentTarget.value })} />
            </label>
          ))}
        {spec?.secrets.map((x) => (
          <label class="field" key={x}>
            <span>
              <span>{x}</span>
              <span>Not saved</span>
            </span>
            <input
              class="input"
              type="password"
              autocomplete="off"
              value={vals[`secret:${x}`] ?? ''}
              onInput={(e) => setVals({ ...vals, [`secret:${x}`]: e.currentTarget.value })}
            />
          </label>
        ))}
        {err && <span class="err">{err}</span>}
      </main>
      <footer>
        <button class="btn btn-primary" type="button" style={{ width: '100%' }} disabled={!spec || !ok} onClick={run}>
          Run
        </button>
      </footer>
    </div>
  );
}

function Replay({ r, done }: { r: NonNullable<PanelState['replay']>; done: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const total = r.steps.length;
  const cur = r.steps[r.i];
  const finished = r.status === 'done' || r.status === 'failed';
  const broken = r.status === 'needs_choice' || r.status === 'failed';
  const paused = r.status === 'paused';
  const waitingOnAgent = (r.status === 'needs_choice' || (paused && r.handedBack)) && !!r.by;
  const progress = finished && r.status === 'done' ? 1 : r.i / total;
  const lastFix = r.fixed.length ? Math.max(...r.fixed) : 0;

  let status: string;
  if (r.status === 'done') status = `Done · ${r.modelCalls} model ${r.modelCalls === 1 ? 'call' : 'calls'}`;
  else if (broken) status = `Stopped at step ${cur?.n ?? r.i + 1} of ${total}`;
  else if (paused) status = `Paused at step ${cur.n} · ${r.modelCalls} model ${r.modelCalls === 1 ? 'call' : 'calls'}`;
  else status = `Step ${Math.min(r.i + 1, total)} of ${total}${lastFix ? ` · no model calls since step ${lastFix}` : ' · no model calls'}`;

  const doneRows = r.steps.slice(0, r.i);
  const fixedRows = doneRows.filter((x) => r.fixed.includes(x.n));

  // Esc stops, Cmd/Ctrl+Enter approves.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (paused && !r.handedBack && (e.metaKey || e.ctrlKey) && e.key === 'Enter') send({ t: 'decide', id: r.id, approve: true });
      else if (e.key === 'Escape' && !finished) send(paused && !r.handedBack ? { t: 'decide', id: r.id, approve: false } : { t: 'stop', id: r.id });
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [r.id, paused, r.handedBack, finished]);

  // "Start rollout to Internal testing" -> "Start rollout".
  const approveLabel = !cur ? 'Continue' : cur.label.length <= 24 ? cur.label : cur.label.split(/\s+/).slice(0, 2).join(' ');

  return (
    <div class="panel" style={{ position: 'relative' }}>
      <header class="rhead">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h1>
            {r.name} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>v{r.version}</span>
          </h1>
          <span class="mono" style={{ fontSize: '12px', color: 'var(--text-2)' }}>
            {clock(now - r.start)}
          </span>
        </div>
        <div
          class={broken ? 'progress bad' : 'progress'}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={r.i}
          aria-label="Replay progress"
        >
          <div style={{ transform: `scaleX(${Math.max(progress, 0.02)})` }} />
        </div>
        <span style={{ fontSize: '12px', color: broken ? 'var(--danger)' : 'var(--text-2)' }}>{status}</span>
        {r.viewportNote && (
          <span role="status" style={{ fontSize: '12px', color: 'var(--warn)' }}>
            {r.viewportNote}
          </span>
        )}
      </header>

      <main class={paused && !r.handedBack ? 'rmain pad' : 'rmain'} aria-live="polite">
        {doneRows.length > 1 && (
          <div class="step" style={{ color: 'var(--text-2)' }}>
            <span class="n" />
            <span class="v" />
            <span class="t" style={{ fontSize: '12px' }}>
              Steps 1 to {doneRows.length} done
            </span>
            <span class="s" style={{ color: 'var(--accent-ink)' }}>
              <Check />
            </span>
          </div>
        )}
        {fixedRows.map((st) => (
          <div class="box" key={st.n}>
            <div class="step">
              <span class="n">{st.n}</span>
              <span class="v">{st.action}</span>
              <span class="t">{st.label}</span>
              <span class="s" style={{ color: 'var(--warn)' }}>
                <Pips colors={['var(--accent)', 'var(--warn)', 'var(--warn)']} label="Page passed, element changed" />
                changed
              </span>
            </div>
            <div class="why">Matched again with one model call. Saved as v{r.version + 1}.</div>
          </div>
        ))}
        {doneRows.length === 1 && !fixedRows.length && (
          <div class="step">
            <span class="n">{doneRows[0].n}</span>
            <span class="v">{doneRows[0].action}</span>
            <span class="t">{doneRows[0].label}</span>
            <span class="s" style={{ color: 'var(--accent-ink)' }}>
              <Check />
              done
            </span>
          </div>
        )}
        {cur && !finished && r.status !== 'needs_choice' && (
          <div class="step cur" key={cur.n}>
            <span class="n">{cur.n}</span>
            <span class="v">{cur.action}</span>
            <span class="t">{cur.label}</span>
            {paused ? (
              <span class="s" style={{ color: 'var(--warn)' }}>
                <PauseIcon />
                paused
              </span>
            ) : (
              <span class="s" style={{ color: 'var(--text-2)' }}>
                <Pips label="Checking page, element and crop" />
                checking
              </span>
            )}
          </div>
        )}
        {cur && broken && (
          <div class="box">
            <div class="step">
              <span class="n">{cur.n}</span>
              <span class="v">{cur.action}</span>
              <span class="t">{cur.label}</span>
              <span class="s" style={{ color: 'var(--danger)' }}>
                <Pips colors={['var(--accent)', 'var(--danger)', 'var(--danger)']} label="Page passed, element failed" />
                broken
              </span>
            </div>
            <div class="why">{r.error ?? 'The element is gone or too different to match without asking.'}</div>
          </div>
        )}
        {waitingOnAgent && (
          <div class="handoff">
            <span class="h">{r.by} has the page</span>
            <span class="b">
              {paused ? `It decides on step ${cur.n}.` : `It finishes from step ${cur.n}. The fix is saved as v${r.version + 1}.`}
            </span>
            <div class="work" role="status" aria-label="Agent working">
              <div />
            </div>
          </div>
        )}
        {r.status === 'needs_choice' && !r.by && (
          <div class="handoff">
            <span class="h">The page changed</span>
            <span class="b">Run it from your agent and it picks the new element. The fix is saved as v{r.version + 1}.</span>
          </div>
        )}
      </main>

      {paused && !r.handedBack && (
        <div class="pause">
          <section aria-live="polite" aria-label="Paused before an irreversible step">
            <div class="stack" style={{ gap: '6px' }}>
              <span class="k">
                <PauseIcon />
                Paused before step {cur.n}
              </span>
              <span class="h">{cur.label}</span>
              <span class="b">{r.pauseKind === 'forced' ? 'This routine is from someone else and this step looks irreversible, so only you can approve it. Nothing has been sent yet.' : 'Nothing has been sent yet.'}</span>
            </div>
            <div class="foot2">
              <button class="btn btn-stop" type="button" aria-keyshortcuts="Escape" onClick={() => send({ t: 'decide', id: r.id, approve: false })}>
                Stop
              </button>
              <button class="btn btn-primary" type="button" aria-keyshortcuts={MAC ? 'Meta+Enter' : 'Control+Enter'} onClick={() => send({ t: 'decide', id: r.id, approve: true })}>
                {approveLabel} <kbd>{MAC ? '⌘↵' : 'Ctrl ↵'}</kbd>
              </button>
            </div>
          </section>
        </div>
      )}

      {(finished || r.status === 'needs_choice' || (paused && r.handedBack)) && (
        <footer style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {finished ? (
            <button class="btn btn-secondary" type="button" onClick={done}>
              Back to routines
            </button>
          ) : (
            <button class="btn btn-stop" type="button" aria-keyshortcuts="Escape" onClick={() => send({ t: 'stop', id: r.id })}>
              Stop
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

// ---------- app ----------

const ONBOARDED = 'onboarded';

function App() {
  const [s, setS] = useState<PanelState>();
  const [view, setView] = useState<View>({ v: 'library' });
  const [onboarded, setOnboarded] = useState<boolean>();

  useEffect(() => {
    onState = setS;
    if (latest) setS(latest);
    browser.storage.local.get(ONBOARDED).then((v) => setOnboarded(!!v[ONBOARDED]));
  }, []);

  // R records, from anywhere outside a text field.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key.toLowerCase() !== 'r' || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(el.tagName)) return;
      if (view.v === 'library' && s?.connected && !s.replay) send({ t: 'record', on: !s.recording });
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [view, s]);

  if (!s || onboarded === undefined) return null;

  const back = () => setView({ v: 'library' });
  // The result of a finished replay can wait. A request for the person cannot.
  const asking = !!(s.script || s.install || s.hooksReview);
  if (s.replay && !(asking && (s.replay.status === 'done' || s.replay.status === 'failed'))) {
    return (
      <Replay
        r={s.replay}
        done={() => {
          send({ t: 'dismiss' });
          back();
        }}
      />
    );
  }

  // A request for the person is answered on this computer and needs no account, so signing in does not hide it.
  if (s.install) return <InstallGit card={s.install} />;
  if (s.hooksReview) return <HooksReview r={s.hooksReview} />;
  if (!s.account && s.script) {
    return (
      <div class="panel">
        <main class="lib">
          <ScriptCard card={s.script} />
        </main>
      </div>
    );
  }
  if (!s.account) return <SignIn s={s} />;

  if (!s.connected || (!onboarded && !s.agents.length && !s.routines.length && !s.runs.length)) {
    return (
      <Onboarding
        s={s}
        onDone={() => {
          browser.storage.local.set({ [ONBOARDED]: true });
          setOnboarded(true);
        }}
      />
    );
  }

  if (view.v === 'save') return <Save s={s} runId={view.runId} back={back} />;
  if (view.v === 'inputs') return <Inputs id={view.id} name={view.name} back={back} />;
  if (view.v === 'submissions') return <Submissions s={s} back={back} />;
  if (view.v === 'sources') return <Sources back={back} />;
  if (view.v === 'settings') return <SettingsView s={s} back={back} />;
  return <Library s={s} go={setView} />;
}

render(<App />, document.getElementById('app')!);
