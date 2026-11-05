import '@fontsource/schibsted-grotesk/latin-400.css';
import '@fontsource/schibsted-grotesk/latin-500.css';
import '@fontsource/schibsted-grotesk/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '../sidepanel/tokens.css';
import './admin.css';
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as auth from '../../lib/auth';

// The reviewer's page. Every submission is read by a person before it goes live; this is where they do it.
// It talks to /admin on the API as the signed-in account, which the API only answers for its allow-list.

interface Check { id: string; level: 'pass' | 'warn' | 'fail'; text: string; tag?: string }
interface Row {
  id: string; owner: string; name: string; site: string; description: string; version: number; status: string;
  guideline: string | null; note: string | null; submitted_at: string; steps: number;
  live_version: number | null; new_publisher: boolean; tags: Check[];
}
interface Step { n: number; action: string; label: string; url?: string; value?: string; pause?: string }
interface Detail extends Omit<Row, 'steps' | 'tags'> {
  steps: Step[]; meta: { pauses: number[] }; checks: Check[];
  live: { version: number; steps: Step[] } | null;
  publisher: { handle: string; joined: string; live: number; approved: number; rejected: number; blocked: boolean };
}
interface Live { owner: string; name: string; version: number; installs: number; disabled: boolean; disabled_reason: string | null; publisher_blocked: boolean }
interface Block { kind: 'user' | 'repo' | 'routine'; value: string; reason: string; created_at: string }
interface Entry { admin: string; action: string; target: string; detail: Record<string, unknown>; at: string }

const REJECT = [
  ['G1', 'Unclear job'], ['G2', 'Leaves its site'], ['G3', 'Personal or secret'], ['G4', 'No pause'], ['G5', 'Harmful or deceptive'], ['G7', 'Imitates someone'],
] as const;
const KIND: Record<Block['kind'], string> = { user: 'Publisher', repo: 'Repository', routine: 'Routine' };

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await auth.api(method, path, body);
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
  return json as T;
}

const ago = (iso: string) => {
  const m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${Math.floor(m)} min ago`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ago`;
  const d = Math.floor(m / 60 / 24);
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : `${Math.floor(d / 30)} months ago`;
};
const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const stepText = (s: Step) => (s.action === 'navigate' ? (s.url ?? '').replace(/^https?:\/\//, '') : s.value ? `${s.label} → ${s.value}` : s.label);
const isPublicValue = (s: Step) => (s.action === 'type' || s.action === 'select') && !!s.value && !/^\{\{[a-z0-9_:]+\}\}$/.test(s.value);
const key = (s: Step) => [s.action, s.label, s.url ?? '', s.value ?? ''].join('|');

const Tick = ({ level }: { level: Check['level'] }) =>
  level === 'pass' ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={level === 'warn' ? 'var(--warn)' : 'var(--danger)'} stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v5.5M8 12v.5" /></svg>
  );

// ---------- review ----------

function Review({ onCount }: { onCount: (n: number) => void }) {
  const [filter, setFilter] = useState<'waiting' | 'new' | 'updates' | 'rejected'>('waiting');
  const [pending, setPending] = useState<Row[]>([]);
  const [rejected, setRejected] = useState<Row[]>([]);
  const [open, setOpen] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [compare, setCompare] = useState(false);
  const [guideline, setGuideline] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sure, setSure] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([call<{ submissions: Row[]; waiting: number }>('GET', '/admin/submissions?status=pending'), call<{ submissions: Row[] }>('GET', '/admin/submissions?status=rejected&limit=30')]);
    setPending(p.submissions);
    setRejected(r.submissions);
    onCount(p.waiting);
  }, [onCount]);
  useEffect(() => void load().catch((e) => setError(e.message)), [load]);

  const shown = filter === 'rejected' ? rejected : filter === 'new' ? pending.filter((x) => x.live_version === null) : filter === 'updates' ? pending.filter((x) => x.live_version !== null) : pending;
  useEffect(() => {
    if (!shown.some((x) => x.id === open)) setOpen(shown[0]?.id);
  }, [filter, pending, rejected]);
  useEffect(() => {
    setDetail(undefined);
    setCompare(false);
    setGuideline('');
    setNote('');
    setSure(false);
    setError('');
    if (open) call<Detail>('GET', `/admin/submissions/${open}`).then(setDetail, (e) => setError(e.message));
  }, [open]);

  const decide = async (what: 'approve' | 'reject') => {
    if (!detail || busy || detail.status !== 'pending') return;
    if (what === 'reject' && (!guideline || !note.trim())) return void noteRef.current?.focus();
    setBusy(true);
    setError('');
    try {
      await call('POST', `/admin/submissions/${detail.id}/${what}`, what === 'reject' ? { guideline, note: note.trim() } : undefined);
      await load();
    } catch (e) {
      setError(messages[(e as Error).message] ?? (e as Error).message);
    }
    setBusy(false);
  };
  const block = async () => {
    if (!detail) return;
    if (!sure) return setSure(true);
    setBusy(true);
    try {
      await call('PUT', '/admin/blocks', { kind: 'user', value: detail.publisher.handle, reason: note.trim() || 'Blocked during review.' });
      await load();
      setSure(false);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = shown.findIndex((x) => x.id === open);
      if (e.key === 'j' && shown[i + 1]) setOpen(shown[i + 1].id);
      else if (e.key === 'k' && shown[i - 1]) setOpen(shown[i - 1].id);
      else if (e.key === 'a') void decide('approve');
      else if (e.key === 'r') {
        e.preventDefault();
        void decide('reject');
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const news = pending.filter((x) => x.live_version === null).length;
  const flagged = useMemo(() => new Set(detail?.steps.filter(isPublicValue).map((s) => s.n)), [detail]);
  const liveKeys = useMemo(() => new Set(detail?.live?.steps.map(key)), [detail]);
  const nowKeys = useMemo(() => new Set(detail?.steps.map(key)), [detail]);

  return (
    <div class="ad-split">
      <section class="ad-col" aria-label="Waiting for review">
        <div style="display:flex;flex-direction:column;gap:6px">
          <h1>Review</h1>
          <p class="sub">{pending.length} waiting. Every submission is reviewed, and nothing goes public until you approve it.</p>
        </div>
        <div role="group" aria-label="Filter" style="display:flex;gap:8px;flex-wrap:wrap">
          {([['waiting', `Waiting ${pending.length}`], ['new', `New ${news}`], ['updates', `Updates ${pending.length - news}`], ['rejected', 'Rejected']] as const).map(([k, label]) => (
            <button key={k} class="chip" type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <div class="ad-q" role="list">
          {shown.length === 0 && <div class="ad-empty">{filter === 'rejected' ? 'Nothing rejected yet.' : 'Nothing waiting. New submissions show up here.'}</div>}
          {shown.map((x) => (
            <button key={x.id} class="q" type="button" role="listitem" aria-current={x.id === open} onClick={() => setOpen(x.id)}>
              <span class="q-top">
                <span class="q-name mono"><span>{x.owner}/</span>{x.name}</span>
                <span class="tag">{x.live_version === null ? 'New' : `Update v${x.version}`}</span>
              </span>
              <span class="q-meta">{x.site} · {x.steps} steps · {ago(x.submitted_at)}</span>
              <span class="tags">
                {x.status === 'rejected' && <span class="tag bad">{x.guideline}</span>}
                {x.status === 'pending' && x.new_publisher && <span class="tag warn">New publisher</span>}
                {x.status === 'pending' && x.tags.map((t) => <span key={t.id} class={`tag ${t.level === 'fail' ? 'bad' : 'warn'}`}>{t.tag}</span>)}
                {x.status === 'pending' && x.tags.length === 0 && <span class="tag ok">Clean</span>}
              </span>
            </button>
          ))}
        </div>
        <span class="dim" style="font-size:12px;color:var(--text-3)"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>A</kbd> approve · <kbd>R</kbd> reject</span>
      </section>

      {detail && (
        <article class="ad-card" aria-label={`${detail.owner}/${detail.name}`}>
          <div class="ad-sec head">
            <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap">
              <h2 class="mono"><span class="dim">{detail.owner}/</span>{detail.name}</h2>
              <span style="font-size:13px;color:var(--text-3)">
                {detail.live ? `v${detail.version}, replaces live v${detail.live.version}` : `v${detail.version}, new`} · {ago(detail.submitted_at)}
              </span>
            </div>
            <p class="sub" style="font-size:15px;line-height:24px;max-width:720px">{detail.description}</p>
          </div>
          <div class="ad-two">
            <div style="display:flex;flex-direction:column;gap:14px">
              <h3 class="h3">Checks</h3>
              <ul>
                {detail.checks.map((c) => (
                  <li key={c.id} class="chk"><Tick level={c.level} /><span>{c.text}</span></li>
                ))}
              </ul>
            </div>
            <div style="display:flex;flex-direction:column;gap:14px">
              <h3 class="h3">Publisher</h3>
              <div style="display:flex;flex-direction:column;gap:4px">
                <span class="mono" style="font-size:14px;font-weight:500">{detail.publisher.handle}{detail.publisher.blocked && ' (blocked)'}</span>
                <span style="font-size:13px;line-height:20px;color:var(--text-2)">
                  Joined {ago(detail.publisher.joined)}<br />{detail.publisher.live} live, {detail.publisher.rejected} rejected
                </span>
              </div>
            </div>
          </div>
          <div class="ad-sec">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <h3 class="h3">Steps · what the public will see</h3>
              {detail.live && <button class="link" type="button" onClick={() => setCompare(!compare)}>{compare ? 'Hide comparison' : `Compare with v${detail.live.version}`}</button>}
            </div>
            <div class="steps">
              {detail.steps.map((s) => (
                <div key={s.n} class={`step${flagged.has(s.n) || (compare && !liveKeys.has(key(s))) ? ' flag' : ''}`}>
                  <span class="n">{s.n}</span><span>{s.action}</span><span class="t">{stepText(s)}</span>
                  <span>{flagged.has(s.n) ? <span class="tag warn">public</span> : compare && !liveKeys.has(key(s)) ? <span class="tag warn">changed</span> : detail.meta.pauses.includes(s.n) ? <span class="tag ok">pause</span> : null}</span>
                </div>
              ))}
              {compare && detail.live?.steps.filter((s) => !nowKeys.has(key(s))).map((s) => (
                <div key={`gone${s.n}`} class="step gone"><span class="n">{s.n}</span><span>{s.action}</span><span class="t">{stepText(s)}</span><span class="tag bad">removed</span></div>
              ))}
            </div>
          </div>
          {detail.status === 'pending' ? (
            <>
              <div class="ad-reject">
                <h3 class="h3">If you reject, pick the guideline. The publisher sees it.</h3>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  {REJECT.map(([g, label]) => <button key={g} class="chip" type="button" aria-pressed={guideline === g} onClick={() => setGuideline(guideline === g ? '' : g)}>{g} {label}</button>)}
                </div>
                <textarea ref={noteRef} class="field" rows={2} style="resize:vertical" placeholder="Add a line the publisher can act on" value={note} onInput={(e) => setNote(e.currentTarget.value)} maxLength={1000} />
              </div>
              <div class="ad-actions">
                <div style="display:flex;gap:8px">
                  <button class="btn btn-primary" type="button" disabled={busy} onClick={() => decide('approve')}>Approve and publish</button>
                  <button class="btn btn-secondary" type="button" disabled={busy || !guideline || !note.trim()} onClick={() => decide('reject')}>Reject</button>
                </div>
                <button class="danger-btn" type="button" disabled={busy || detail.publisher.blocked} onClick={block}>{sure ? 'Click again to block' : 'Block this publisher'}</button>
              </div>
            </>
          ) : (
            <div class="ad-actions"><span class="sub">{detail.status === 'rejected' ? `Rejected under ${detail.guideline}: ${detail.note}` : `This submission was ${detail.status}.`}</span></div>
          )}
          {error && <div class="ad-err" role="alert" style="padding:0 32px 20px">{error}</div>}
        </article>
      )}
      {!detail && error && <div class="ad-err" role="alert">{error}</div>}
    </div>
  );
}

const messages: Record<string, string> = {
  not_pending: 'Someone already decided this one. Reloading the list.',
  blocked: 'The publisher or routine is blocked, so it cannot go live.',
  no_longer_valid: 'It no longer passes the checks, so it was not published.',
  bad_guideline: 'Pick one of the guidelines.',
};

// ---------- live and blocked ----------

function BlockedList({ blocks, reload }: { blocks: Block[]; reload: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  // One box for all three: an https address is a repository, owner/name is a routine, a bare name is a publisher.
  const classify = (v: string): Block | undefined => {
    v = v.trim();
    if (/^https?:\/\//i.test(v) || /^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(v)) return { kind: 'repo', value: /^https?:/i.test(v) ? v : `https://${v}` } as Block;
    if (/^[a-z0-9][a-z0-9-]{2,29}\/[a-z0-9][a-z0-9-]{1,62}$/.test(v)) return { kind: 'routine', value: v } as Block;
    if (/^[a-z0-9][a-z0-9-]{2,29}$/.test(v)) return { kind: 'user', value: v } as Block;
  };
  const add = async () => {
    const b = classify(text);
    if (!b) return setErr('Use a publisher, owner/routine or an https address.');
    const reason = prompt(`Why block ${b.value}? It is kept in the audit trail.`);
    if (!reason?.trim()) return;
    try {
      await call('PUT', '/admin/blocks', { ...b, reason: reason.trim() });
      setText('');
      setErr('');
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <aside aria-label="Blocked" class="ad-col" style="gap:16px">
      <div style="display:flex;flex-direction:column;gap:6px">
        <h2>Blocked</h2>
        <p class="sub">Every install checks this list, and routines already installed from a blocked source turn themselves off within a day.</p>
      </div>
      <div style="display:flex;gap:8px">
        <input class="field" type="text" value={text} spellcheck={false} aria-label="Repository, publisher or routine" placeholder="Repository, publisher or routine" onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button class="btn btn-secondary" type="button" onClick={add}>Block</button>
      </div>
      {err && <span class="ad-err" role="alert">{err}</span>}
      <div>
        {blocks.length === 0 && <div class="ad-empty" style="padding:16px 0">Nothing is blocked.</div>}
        {blocks.map((b) => (
          <div class="blk" key={b.kind + b.value}>
            <span><span class="mono" style="overflow-wrap:anywhere">{b.value.replace(/^https:\/\//, '')}</span><span class="tag">{KIND[b.kind]}</span></span>
            <span style="color:var(--text-2)">{b.reason}</span>
            <span>{ago(b.created_at)}<button class="link" type="button" onClick={async () => { await call('DELETE', `/admin/blocks?kind=${b.kind}&value=${encodeURIComponent(b.value)}`).catch(() => {}); reload(); }}>Unblock</button></span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function LiveList({ rows, reload, blocks, reloadBlocks }: { rows: Live[]; reload: () => void; blocks: Block[]; reloadBlocks: () => void }) {
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const shown = rows.filter((r) => `${r.owner}/${r.name}`.includes(q.trim().toLowerCase()));
  const flip = async (r: Live) => {
    setErr('');
    try {
      if (r.disabled) await call('POST', `/admin/routines/${r.owner}/${r.name}/enable`);
      else {
        const reason = prompt(`Why turn off ${r.owner}/${r.name}? The publisher sees this.`);
        if (!reason?.trim()) return;
        await call('POST', `/admin/routines/${r.owner}/${r.name}/disable`, { reason: reason.trim() });
      }
      reload();
      reloadBlocks();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div class="ad-split live">
      <section class="ad-col" aria-label="Live routines">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap">
          <div style="display:flex;flex-direction:column;gap:6px;max-width:560px">
            <h1>Live</h1>
            <p class="sub">{rows.length} routines people can install. Turn one off and it stops appearing and installing, at once.</p>
          </div>
          <input class="field" style="width:260px" type="search" aria-label="Search live routines" placeholder="Search live routines" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
        {err && <span class="ad-err" role="alert">{err}</span>}
        <div style="border-top:1px solid var(--border)">
          {shown.length === 0 && <div class="ad-empty">Nothing here.</div>}
          {shown.map((r) => (
            <div class="row" key={r.owner + r.name}>
              <span class="mono" style="font-weight:500;overflow-wrap:anywhere"><span class="dim">{r.owner}/</span>{r.name}{r.disabled_reason && <span class="dim" style="display:block;font:400 12px var(--font-sans);margin-top:4px">Off: {r.disabled_reason}</span>}</span>
              <span style="color:var(--text-2);font-size:13px">{count(r.installs)} installs</span>
              <span class="mono" style="color:var(--text-3);font-size:13px">v{r.version}</span>
              <span style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-2)">{r.disabled ? 'Disabled' : 'Live'}<button class="sw" type="button" role="switch" aria-checked={!r.disabled} aria-label={`${r.name} live`} onClick={() => flip(r)} /></span>
            </div>
          ))}
        </div>
        <span class="dim" style="font-size:12px;color:var(--text-3)">Showing {shown.length} of {rows.length}</span>
      </section>
      <BlockedList blocks={blocks} reload={reloadBlocks} />
    </div>
  );
}

function Activity() {
  const [rows, setRows] = useState<Entry[]>();
  useEffect(() => void call<{ audit: Entry[] }>('GET', '/admin/audit').then((r) => setRows(r.audit), () => setRows([])), []);
  return (
    <div class="ad-split one">
      <section class="ad-col">
        <div style="display:flex;flex-direction:column;gap:6px"><h1>Activity</h1><p class="sub">The last hundred decisions, and who made them.</p></div>
        <div style="border-top:1px solid var(--border)">
          {rows?.length === 0 && <div class="ad-empty">No decisions yet.</div>}
          {rows?.map((e, i) => (
            <div class="blk" key={i}>
              <span><span class="tag">{e.action}</span><span class="mono">{e.target}</span></span>
              <span><span>{e.admin}</span><span>{ago(e.at)}</span></span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------- the page ----------

function Gate({ title, text }: { title: string; text: string }) {
  return <div class="ad-gate"><h1>{title}</h1><p class="sub">{text}</p></div>;
}

function App() {
  const [me, setMe] = useState<auth.Account | null | undefined>();
  const [tab, setTab] = useState<'review' | 'live' | 'blocked' | 'activity'>('review');
  const [waiting, setWaiting] = useState(0);
  const [live, setLive] = useState<Live[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const loadLive = useCallback(() => void call<{ routines: Live[] }>('GET', '/admin/routines').then((r) => setLive(r.routines), () => {}), []);
  const loadBlocks = useCallback(() => void call<{ blocks: Block[] }>('GET', '/admin/blocks').then((r) => setBlocks(r.blocks), () => {}), []);
  useEffect(() => {
    void auth.check().then(auth.account).then((a) => setMe(a ?? null));
  }, []);
  useEffect(() => {
    if (me?.admin) {
      loadLive();
      loadBlocks();
    }
  }, [me]);

  if (me === undefined) return null;
  if (!me) return <Gate title="Sign in first" text="Sign in from the Browser Routines side panel, then reload this page." />;
  if (!me.admin) return <Gate title="Reviewers only" text="This page is for the people who review submissions to the directory." />;
  return (
    <div class="ad">
      <header class="ad-head">
        <div class="ad-left">
          <div class="ad-brand">
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M3 5.5h12L5 11h12L7 16.5h13" fill="none" style="stroke:var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            Browser Routines<span class="tag">Admin</span>
          </div>
          <nav class="ad-nav" aria-label="Admin">
            {([['review', 'Review', waiting], ['live', 'Live', live.length], ['blocked', 'Blocked', blocks.length], ['activity', 'Activity', undefined]] as const).map(([k, label, n]) => (
              <button key={k} class="tab" type="button" aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}{n !== undefined && <em>{n}</em>}</button>
            ))}
          </nav>
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-2)">Signed in as {me.email}</div>
      </header>
      {tab === 'review' && <Review onCount={setWaiting} />}
      {tab === 'live' && <LiveList rows={live} reload={loadLive} blocks={blocks} reloadBlocks={loadBlocks} />}
      {tab === 'blocked' && <div class="ad-split one"><BlockedList blocks={blocks} reload={loadBlocks} /></div>}
      {tab === 'activity' && <Activity />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
