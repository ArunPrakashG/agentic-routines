import '@fontsource/schibsted-grotesk/latin-400.css';
import '@fontsource/schibsted-grotesk/latin-500.css';
import '@fontsource/schibsted-grotesk/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/roboto/latin-500.css';
import './tokens.css';
import './panel.css';
import { compileRun, siteOf, type ParamSpec } from '@browser-routines/core';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Account as AccountInfo } from '../../lib/auth';
import type { PanelCommand, PanelState } from '../../lib/panel-types';

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

type View = { v: 'library' } | { v: 'save'; runId: string } | { v: 'inputs'; id: string; name: string };

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

function SignIn() {
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
          <h1>Browser Routines</h1>
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
      </main>
      <footer class="signin-foot">Passwords you type are never saved.</footer>
    </div>
  );
}

function Account({ account }: { account: AccountInfo }) {
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

function Onboarding({ s, onDone }: { s: PanelState; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const cmd = 'npx browser-routines setup';
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

function PublishCard({ card }: { card: NonNullable<PanelState['publish']> }) {
  const [handle, setHandle] = useState('');
  const bad = card.needsHandle && !/^[a-z0-9][a-z0-9-]{2,29}$/.test(handle.trim().toLowerCase());
  if (card.done) {
    return (
      <section class="pubcard" aria-label="Published">
        <div class="stack" style={{ gap: '6px' }}>
          <span class="title">Published as {card.done.as}</span>
          <span class="meta">Version {card.done.version}. Anyone can find it in the directory and install it.</span>
        </div>
        <button class="btn btn-secondary sm" type="button" onClick={() => send({ t: 'publishDecide', approve: false })}>
          Done
        </button>
      </section>
    );
  }
  return (
    <section class="pubcard" aria-label="Publish to the directory">
      <div class="stack" style={{ gap: '6px' }}>
        <span class="k">{card.by ? `${card.by} wants to publish` : 'Publish to the directory'}</span>
        <span class="title mono">{card.name}</span>
        <span class="meta">
          {card.site} · {card.steps} steps. Anyone can see and install it.
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
          {card.busy ? 'Publishing…' : 'Publish'}
        </button>
      </div>
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
          {s.account && <Account account={s.account} />}
        </div>
      </header>
      {empty && !recording ? (
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
          {s.routines.length > 0 && (
            <section aria-label="Saved routines" style={{ display: 'flex', flexDirection: 'column' }}>
              {s.routines.map((r) => (
                <div class={r.enabled ? 'row' : 'row off'} key={r.owner + '/' + r.name}>
                  <div class="stack" style={{ flex: 1 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span class="name">{r.name}</span>
                      {r.owner !== 'local' && <span class="badge">by {r.owner}</span>}
                    </span>
                    <span class="desc">{r.description.split(/\bUse when\b/i)[0].trim() || r.description}</span>
                    <span class="meta">
                      {r.site} · v{r.version}
                      {r.draftedBy ? ` · drafted by ${r.draftedBy}` : ''}
                      {r.published ? ` · published v${r.published.version}` : ''}
                      {r.lastRun ? ` · ran ${ago(r.lastRun)}` : ''}
                    </span>
                    {!!r.changed?.length && (
                      <span class="changed">
                        {r.changed.length === 1 ? 'Step' : 'Steps'} {r.changed.join(', ')} changed on the last run
                      </span>
                    )}
                  </div>
                  {r.owner === 'local' && !s.publish && (
                    <button class="btn btn-ghost sm" type="button" aria-label={`Publish ${r.name}`} onClick={() => send({ t: 'publish', id: `local/${r.name}` })}>
                      Publish
                    </button>
                  )}
                  <button
                    class="icon-btn"
                    type="button"
                    aria-label={`Run ${r.name}`}
                    disabled={!!s.replay}
                    onClick={() => go({ v: 'inputs', id: `${r.owner}/${r.name}`, name: r.name })}
                  >
                    <Play />
                  </button>
                </div>
              ))}
            </section>
          )}
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
          Publish to the directory
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
              <span class="b">Nothing has been sent yet.</span>
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
  if (s.replay) {
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

  if (!s.account) return <SignIn />;

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
  return <Library s={s} go={setView} />;
}

render(<App />, document.getElementById('app')!);
