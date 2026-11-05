import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkFetched, compileRun, eventLabel, missingParams, onSite, type Locator, type Routine, type Run, type RunResult, type Step } from '@agentic-routines/core';
import { Bridge, NotConnected } from './bridge.ts';
import { paths } from './paths.ts';
import * as sources from './sources.ts';
import * as store from './store.ts';

const MAX_ROUTINE_TOOLS = 30;
const VERSION = '0.1.0';
const API = process.env.AGENTIC_ROUTINES_API ?? 'https://agenticroutines.arunprakashg.com';

interface Listing {
  owner: string;
  name: string;
  site: string;
  description: string;
  version: number;
  installs: number;
}

async function directory<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/v1${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('Could not reach the directory. Check the connection and try again.');
  }
  if (res.status === 404) throw new Error('Not in the directory.');
  if (res.status === 429) throw new Error('The directory is busy. Try again in a minute.');
  if (!res.ok && res.status !== 204) throw new Error(`The directory answered ${res.status}.`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: 'text', text: t }] as Content[] });
const fail = (t: string) => ({ content: [{ type: 'text', text: t }] as Content[], isError: true });

function toolName(name: string) {
  return 'rt_' + name.replace(/-/g, '_');
}

function clock(ms: number) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Secrets come from the agent's environment, never from the routine. */
function secretsFor(r: Routine): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of r.meta.secrets) {
    const v = process.env[`AGENTIC_ROUTINES_SECRET_${s.toUpperCase()}`];
    if (v) out[s] = v;
  }
  return out;
}

/** Absolute paths for file params, resolved against the agent's working directory. */
function absoluteFiles(r: Routine, params: Record<string, string>) {
  const out = { ...params };
  for (const [k, spec] of Object.entries(r.meta.params)) if (spec.type === 'file' && out[k] && !isAbsolute(out[k])) out[k] = resolvePath(process.cwd(), out[k]);
  return out;
}

export function describeResult(r: RunResult): string {
  const calls = `${r.model_calls} model call${r.model_calls === 1 ? '' : 's'}`;
  switch (r.status) {
    case 'done': {
      const parts = [`Done · ${r.steps_total} steps · ${calls} · ${clock(r.ms)}`];
      if (r.updated_to) parts.push(`routine updated to v${r.updated_to}`);
      let t = parts.join(' · ');
      if (r.approved_in_panel?.length) t += `\nThe routine paused and the user approved ${r.approved_in_panel.join(', ')} in the side panel.`;
      if (r.read && Object.keys(r.read).length) t += '\n' + Object.entries(r.read).map(([k, v]) => `${k}: ${v}`).join('\n');
      return t;
    }
    case 'paused':
      return `Paused before step ${r.at_step} “${r.step_label}”. Steps 1–${(r.at_step ?? 1) - 1} replayed. Check with the user, then call routine_resume with run_id "${r.run_id}" and approve: true to continue, or approve: false to stop.`;
    case 'needs_choice': {
      const lines = (r.candidates ?? []).map((c) => `  ${c.ref} ${c.role ?? ''} “${c.name ?? c.text ?? ''}” (score ${c.score})`);
      return [
        `Step ${r.at_step} changed: “${r.step_label}” is not on the page the way it was recorded.`,
        lines.length ? 'Closest matches:\n' + lines.join('\n') : 'Nothing on the page looks like it.',
        `Call read_page if you need more context. Then call routine_resume with run_id "${r.run_id}" and choice: "<ref>" to use an element (the routine is updated), or approve: false to stop and finish the task with the browser tools.`,
      ].join('\n');
    }
    case 'failed':
      return `Stopped at step ${r.at_step ?? '?'}${r.step_label ? ` “${r.step_label}”` : ''}: ${r.error}. Finish the task with the browser tools; the run is recorded and can be saved over this routine with routine_save.`;
  }
}

export async function runMcp(): Promise<void> {
  const server = new McpServer({ name: 'agentic-routines', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
  const routineTools = new Map<string, RegisteredTool>();
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshRoutineTools(), 300);
  };
  const bridge = new Bridge((e) => {
    if (e.event === 'routines.changed') scheduleRefresh();
  });

  // Fixes from a replay: chosen elements become the next version.
  const pendingRuns = new Map<string, { id: string; routine: Routine }>();

  async function finish(result: RunResult & { fixes?: Record<number, Locator>; crops?: Record<number, string> }) {
    const p = pendingRuns.get(result.run_id);
    if (result.status === 'paused' || result.status === 'needs_choice' || !p) return result;
    pendingRuns.delete(result.run_id);
    const fixes = result.fixes ?? {};
    if (Object.keys(fixes).length) {
      const steps = p.routine.steps.map((s) => (fixes[s.n] ? { ...s, target: fixes[s.n], crop: result.crops?.[s.n] ?? s.crop } : s));
      // Through the host, so the side panel and other agents hear about it.
      const saved = await bridge.call<Routine>('store.write', { routine: { ...p.routine, steps }, owner: (p.routine as any).owner });
      result.updated_to = saved.meta.version;
    }
    return result;
  }

  async function run(id: string, params: Record<string, string>) {
    const r = await store.read(id);
    const missing = missingParams(r, params);
    if (missing.length) return fail(`${r.meta.name} needs: ${missing.join(', ')}.`);
    const filled = absoluteFiles(r, params);
    const files = Object.entries(r.meta.params).filter(([, s]) => s.type === 'file').map(([k]) => filled[k]);
    if (files.length) await bridge.call('host.allowFiles', { paths: files });
    const result = await bridge.call<RunResult>('replay.start', { routine: r, params: filled, secrets: secretsFor(r) }, 15 * 60_000);
    pendingRuns.set(result.run_id, { id, routine: r });
    return text(describeResult(await finish(result)));
  }

  async function refreshRoutineTools() {
    const all = (await store.list()).filter((r) => r.enabled).slice(0, MAX_ROUTINE_TOOLS);
    const want = new Set<string>();
    for (const r of all) want.add(want.has(toolName(r.name)) ? toolName(`${r.owner}-${r.name}`) : toolName(r.name));
    for (const [name, tool] of routineTools) {
      if (!want.has(name)) {
        tool.remove();
        routineTools.delete(name);
      }
    }
    const taken = new Set<string>();
    for (const l of all) {
      // Two people can publish the same name; the second one is told apart by its owner.
      let name = toolName(l.name);
      if (taken.has(name)) name = toolName(`${l.owner}-${l.name}`);
      taken.add(name);
      let r: Routine;
      try {
        r = await store.read(`${l.owner}/${l.name}`);
      } catch {
        continue;
      }
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, p] of Object.entries(r.meta.params)) shape[k] = z.string().describe(p.description ?? (p.type === 'file' ? 'Path to a file' : k));
      const elsewhere = l.origin && l.origin.kind !== 'directory' ? `Written by someone else (${l.origin.source}) and not reviewed by Agentic Routines. ` : '';
      const description = `${elsewhere}${r.meta.description}\n\nReplays ${r.steps.length} recorded steps on ${r.meta.site} without the model.${r.meta.pauses.length ? ` Pauses before step ${r.meta.pauses.join(', ')} for approval.` : ''}`;
      routineTools.get(name)?.remove();
      routineTools.set(
        name,
        server.registerTool(name, { title: r.meta.name, description, inputSchema: shape }, async (args) => run(`${l.owner}/${l.name}`, args as Record<string, string>)),
      );
    }
    if (server.isConnected()) server.sendToolListChanged();
  }

  // ---------- browser tools (each call is recorded by the extension) ----------

  const tab = { tab_id: z.number().int().optional().describe('Tab to act on. Defaults to the tab the agent is working in.') };

  server.registerTool(
    'tabs',
    { description: 'List open tabs: id, title, URL. The agent works in its own tab unless told otherwise.' },
    async () => text(JSON.stringify(await bridge.call('browser.tabs'), null, 1)),
  );

  server.registerTool(
    'navigate',
    { description: 'Open a URL in the agent tab. Lists saved routines for the site, if any.', inputSchema: { url: z.string(), new_tab: z.boolean().optional(), ...tab } },
    async (a) => {
      const res = await bridge.call<{ url: string; title: string; tab_id: number }>('browser.navigate', a);
      let out = `${res.title}\n${res.url} (tab ${res.tab_id})`;
      const here = (await store.list()).filter((r) => r.enabled && onSite(res.url, r.site));
      if (here.length) out += `\n\nSaved routines for this site:\n${here.map((r) => `- ${toolName(r.name)}: ${r.description.split('\n')[0]}`).join('\n')}`;
      return text(out);
    },
  );

  server.registerTool(
    'read_page',
    {
      description: 'Read the page as an outline of roles and names. Interactive elements get a ref like ref_12 to use with click, type, select and upload.',
      inputSchema: { filter: z.enum(['interactive', 'all']).optional(), ...tab },
    },
    async (a) => text(await bridge.call<string>('browser.read', a)),
  );

  server.registerTool('click', { description: 'Click an element by ref.', inputSchema: { ref: z.string(), ...tab } }, async (a) =>
    text(await bridge.call<string>('browser.click', a)),
  );

  server.registerTool(
    'type',
    { description: 'Type into a field by ref. Replaces what is there. Set submit to press Enter after.', inputSchema: { ref: z.string(), text: z.string(), submit: z.boolean().optional(), ...tab } },
    async (a) => text(await bridge.call<string>('browser.type', a)),
  );

  server.registerTool('select', { description: 'Pick an option in a select by ref, by its label or value.', inputSchema: { ref: z.string(), value: z.string(), ...tab } }, async (a) =>
    text(await bridge.call<string>('browser.select', a)),
  );

  server.registerTool(
    'upload',
    { description: 'Attach a file on this machine to a file input by ref.', inputSchema: { ref: z.string(), path: z.string(), ...tab } },
    async (a) => {
      const path = isAbsolute(a.path) ? a.path : resolvePath(process.cwd(), a.path);
      await bridge.call('host.allowFiles', { paths: [path] });
      return text(await bridge.call<string>('browser.upload', { ...a, path }, 10 * 60_000));
    },
  );

  server.registerTool('press', { description: 'Press a key in the focused element: Enter, Escape, Tab, ArrowDown.', inputSchema: { key: z.string(), ...tab } }, async (a) =>
    text(await bridge.call<string>('browser.press', a)),
  );

  server.registerTool('screenshot', { description: 'Image of the area around the element you last acted on, or around ref. Pass full: true only when you need the whole tab. Prefer read_page: it costs less and also sees toasts and dialogs outside the area.', inputSchema: { ref: z.string().optional(), full: z.boolean().optional(), ...tab } }, async (a) => {
    const { data, note } = await bridge.call<{ data: string; note: string }>('browser.screenshot', a);
    return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: note }] as Content[] };
  });

  // ---------- routines ----------

  server.registerTool('routines_list', { description: 'List saved routines with what each is for.' }, async () => {
    const all = await store.list();
    if (!all.length) return text('No routines saved yet. Every browser task you do is recorded; save one with routine_save.');
    return text(all.map((r) => `${r.owner === store.LOCAL ? '' : r.owner + '/'}${r.name} v${r.version} · ${r.site}${r.enabled ? '' : r.blocked ? ' · off, blocked' : ' · off'}${r.origin && r.origin.kind !== 'directory' ? ` · from ${r.origin.source}` : ''}\n  ${r.description.replace(/\n/g, ' ')}`).join('\n'));
  });

  server.registerTool(
    'routine_describe',
    { description: 'Full notes for a routine: when to use it, when not to, values it asks for, where it pauses.', inputSchema: { name: z.string() } },
    async ({ name }) => {
      const r = await store.read(name);
      const params = Object.entries(r.meta.params).map(([k, p]) => `- ${k} (${p.type}): ${p.description ?? ''}`);
      return text(
        [
          `${r.meta.name} v${r.meta.version} · ${r.meta.site} · ${r.steps.length} steps`,
          r.meta.description,
          params.length ? `Asks each run:\n${params.join('\n')}` : 'Asks for nothing.',
          r.meta.pauses.length ? `Pauses before: ${r.meta.pauses.map((n) => `step ${n} “${r.steps[n - 1]?.label}”`).join(', ')}` : '',
          r.meta.secrets.length ? `Secrets (set AGENTIC_ROUTINES_SECRET_<NAME> or the user types them at a pause): ${r.meta.secrets.join(', ')}` : '',
          r.body,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    },
  );

  server.registerTool(
    'routine_run',
    { description: 'Replay a saved routine without the model. Same as its rt_ tool.', inputSchema: { name: z.string(), params: z.record(z.string(), z.string()).optional() } },
    async ({ name, params }) => run(name, params ?? {}),
  );

  server.registerTool(
    'routine_resume',
    {
      description: 'Continue a paused replay. approve: true continues past a pause, false stops. choice: a ref from read_page for a step that changed.',
      inputSchema: { run_id: z.string(), approve: z.boolean().optional(), choice: z.string().optional() },
    },
    async (a) => {
      const result = await bridge.call<RunResult>('replay.resume', a, 15 * 60_000);
      return text(describeResult(await finish(result)));
    },
  );

  server.registerTool(
    'run_steps',
    { description: 'List the recorded steps of a run, numbered, to choose what routine_save leaves out.', inputSchema: { run_id: z.string().optional().describe('Defaults to the latest run') } },
    async ({ run_id }) => {
      const run = await bridge.call<Run>('runs.get', { run_id });
      return text(run.events.map((e, i) => `${i + 1}. ${e.action} ${eventLabel(e)}${e.value !== undefined ? `: ${e.value}` : ''}`).join('\n'));
    },
  );

  server.registerTool(
    'routine_save',
    {
      description:
        'Save a recorded browser run as a routine. Write description as: what it does, then "Use when ..." in the words a user would say. Pass params { name: value typed } to choose what it asks for each run; everything else stays as typed. Without params, every typed value is asked for. If you retried a step or checked your work, or if the task means "the latest" of something, read run_steps first.',
      inputSchema: {
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).describe('Lowercase with dashes, e.g. play-release'),
        description: z.string().min(20).describe('What it does. Use when ...'),
        do_not_use_for: z.string().optional(),
        run_id: z.string().optional().describe('Defaults to the latest run'),
        params: z.record(z.string(), z.string()).optional(),
        fixed: z.array(z.string()).optional().describe('Auto-detected params to keep as typed'),
        leave_out: z.array(z.number().int()).optional().describe('Numbers from run_steps that are not part of the task, like retries and checks'),
        first_in_list: z.array(z.number().int()).optional().describe('Numbers from run_steps of clicks that should take whatever is first in the list next time, not the item clicked now'),
      },
    },
    async (a) => {
      if (!/\buse when\b/i.test(a.description)) return fail('Add a "Use when ..." clause to the description so agents know when to pick this routine.');
      const run = await bridge.call<Run>('runs.get', { run_id: a.run_id });
      const body = a.do_not_use_for ? `## Do not use for\n${a.do_not_use_for}` : '';
      const { routine, recorded, dropped, unmatched, pinned } = compileRun(run, { name: a.name, description: a.description, params: a.params, fixed: a.fixed, leaveOut: a.leave_out, firstInList: a.first_in_list, body, draftedBy: bridge.agent });
      if (unmatched.length) return fail(`Not saved. These params match no value typed in this run: ${unmatched.join(', ')}. Check them against run_steps.`);
      const saved = await bridge.call<Routine>('store.write', { routine });
      await bridge.call('runs.markSaved', { run_id: run.id }).catch(() => {});
      scheduleRefresh();
      const params = Object.keys(saved.meta.params);
      return text(
        `Saved ${saved.meta.name} v${saved.meta.version} · ${saved.steps.length} of ${recorded} recorded steps (${dropped} replaced by a direct URL${a.leave_out?.length ? `, ${a.leave_out.length} left out` : ''})` +
          (params.length ? ` · asks for ${params.join(', ')}` : '') +
          (saved.meta.pauses.length ? ` · pauses before step ${saved.meta.pauses.join(', ')}` : '') +
          (saved.steps[0]?.url ? `\nStarts at ${saved.steps[0].url}, so it stays on what that address opens.` : '') +
          `\nRun it with ${toolName(saved.meta.name)}.` +
          (pinned.length ? `\nThis routine stays on one specific item: ${pinned.join(', ')}. If it should follow whatever is newest, save again with first_in_list, starting from the list page.` : ''),
      );
    },
  );

  // ---------- the directory ----------

  const line = (r: Listing) => `${r.owner}/${r.name} v${r.version} · ${r.site}${r.installs ? ` · ${r.installs} install${r.installs === 1 ? '' : 's'}` : ''}\n  ${r.description.replace(/\n/g, ' ')}`;

  server.registerTool(
    'routines_search',
    {
      description:
        'Find routines other people published for a site or task. Pass site (e.g. "play.google.com", or the host you are on) and/or words. Install one with routine_install. Check this before doing a chore by hand on a site you have no saved routine for.',
      inputSchema: { query: z.string().max(100).optional(), site: z.string().max(253).optional() },
    },
    async ({ query, site }) => {
      const q = new URLSearchParams({ limit: '10' });
      if (query) q.set('q', query);
      if (site) q.set('site', site.replace(/^https?:\/\//, '').split('/')[0]);
      const found: string[] = [];
      let down: Error | undefined;
      if (await sources.directoryOn()) {
        // The sources below still answer when the directory does not.
        try {
          found.push(...(await directory<{ routines: Listing[] }>(`/routines?${q}`)).routines.map(line));
        } catch (e) {
          down = e as Error;
        }
      }
      // The person's own sources. Not reviewed by us, and said so on every line.
      const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const host = site?.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      for (const src of await sources.entries().catch(() => [])) {
        for (const e of src.entries) {
          const hay = `${e.name} ${e.description} ${e.site}`.toLowerCase();
          if (host && !(e.site === host || host.endsWith('.' + e.site))) continue;
          if (!words.every((w) => hay.includes(w))) continue;
          found.push(`${src.source} · ${e.name} v${e.version} · ${e.site}  [not reviewed]\n  ${e.description.replace(/\n/g, ' ')}\n  Install with routine_install_from_git, source "${src.source}", path "${e.path}".`);
        }
      }
      if (!found.length && down) return fail(down.message);
      if (!found.length) return text('Nothing in the directory or the sources for that yet.');
      return text(found.slice(0, 15).join('\n') + '\n\nInstall a directory routine with routine_install and the owner/name.');
    },
  );

  server.registerTool(
    'routine_install',
    {
      description:
        'Save a routine from the directory to this machine, as owner/name. It runs in the user\'s signed-in browser like their own, so tell the user what it does and which site it works on. Run it afterwards with its rt_ tool, or routine_run.',
      inputSchema: { id: z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/).describe('owner/name, from routines_search') },
    },
    async ({ id }) => {
      const [owner, name] = id.split('/');
      const f = await directory<Listing & { meta: Routine['meta']; body: string; steps: Step[] }>(`/routines/${owner}/${name}`);
      // The directory checks this too, but what runs in this browser is decided here.
      const routine: Routine = { meta: { ...f.meta, name, owner, version: f.version }, body: f.body, steps: f.steps };
      let issues: string[];
      try {
        issues = checkFetched(routine);
      } catch {
        issues = ['The directory sent something that is not a routine.'];
      }
      if (issues.length || owner === store.LOCAL) return fail(`Not installed. ${issues.join(' ') || 'Bad owner.'}`);
      // Through the host when a browser is open, so its panel shows it at once.
      const origin = { kind: 'directory' as const, source: owner };
      const saved = await bridge.call<Routine>('store.write', { routine, owner, origin }).catch((e) => {
        if (!(e instanceof NotConnected)) throw e;
        return store.write(routine, owner, origin);
      });
      directory(`/routines/${owner}/${name}/installs`, { method: 'POST' }).catch(() => {});
      scheduleRefresh();
      const asks = Object.keys(saved.meta.params);
      return text(
        `Installed ${owner}/${name} v${saved.meta.version} · ${saved.steps.length} steps on ${saved.meta.site}` +
          (asks.length ? ` · asks for ${asks.join(', ')}` : '') +
          (saved.meta.pauses.length ? ` · pauses before step ${saved.meta.pauses.join(', ')} for approval` : '') +
          `\nIt was written by ${owner}, not the user. Run it with ${toolName(saved.meta.name)}; routine_describe ${owner}/${name} shows the full notes.`,
      );
    },
  );

  server.registerTool(
    'routine_install_from_git',
    {
      description:
        'Ask the user to install a routine from one of their Git sources (see routines_search). Nothing is installed until the user has read the steps and clicked Install in the browser side panel, so this waits for them; do not say it is installed until it returns. It was written by someone else and is not reviewed by Agentic Routines. Needs a browser with the extension open.',
      inputSchema: {
        source: z.string().max(300).describe('The source address, as routines_search showed it'),
        path: z.string().regex(/^routines\/[a-z0-9][a-z0-9-]{1,62}\.md$/).describe('The file, e.g. routines/deploy-staging.md'),
      },
    },
    async ({ source, path }) => {
      let r: { name: string; owner: string; version: number; steps: number; site: string };
      try {
        r = await bridge.call('git.install', { source, path }, 11 * 60_000);
      } catch (e) {
        if (e instanceof NotConnected) return fail('Not installed. Installing from Git needs the user to click Install in the browser side panel, and no browser is connected. Ask the user to open the browser with the extension.');
        return fail(`Not installed. ${(e as Error).message}`);
      }
      scheduleRefresh();
      return text(`Installed ${r.owner}/${r.name} v${r.version} · ${r.steps} steps on ${r.site}. It was written by someone else, not the user, and is not reviewed by Agentic Routines. Run it with ${toolName(r.name)}.`);
    },
  );

  server.registerTool(
    'routine_publish',
    {
      description:
        'Send a saved routine to the public directory for review. Only when the user asked for it. The user is asked to confirm in the browser side panel, where they see what becomes public, so this waits for them. Needs a signed-in account. Nothing is listed until a person reads it and approves it, so do not tell the user it is published. Use routine_submissions to see where it stands.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const r = await bridge.call<{ owner: string; name: string; version: number }>('directory.publish', { id: name }, 11 * 60_000);
      return text(`Sent ${r.owner}/${r.name} v${r.version} for review. It is private until a person approves it; the user sees the decision in the side panel under Your submissions. Only the user can withdraw it.`);
    },
  );

  server.registerTool(
    'routine_submissions',
    {
      description: 'See where the routines the user sent to the directory stand: waiting for review, rejected (with the guideline and what to change), live, or turned off. Read only.',
      inputSchema: {},
    },
    async () => {
      const r = await bridge.call<{
        routines: { name: string; version: number; installs: number; disabled: boolean; disabled_reason: string | null }[];
        submissions: { name: string; version: number; status: string; guideline: string | null; note: string | null }[];
      }>('directory.submissions', {}, 20_000);
      const lines = [
        ...r.submissions
          .filter((x) => x.status === 'pending' || x.status === 'rejected')
          .map((x) => (x.status === 'pending' ? `${x.name} v${x.version}: waiting for review` : `${x.name} v${x.version}: rejected under ${x.guideline}. ${x.note ?? ''}`.trim())),
        ...r.routines.map((x) => (x.disabled ? `${x.name} v${x.version}: turned off. ${x.disabled_reason ?? ''}`.trim() : `${x.name} v${x.version}: live, ${x.installs} installs`)),
      ];
      return text(lines.length ? lines.join('\n') : 'Nothing sent to the directory yet.');
    },
  );

  await mkdir(paths.routines(), { recursive: true });
  await refreshRoutineTools();
  try {
    watch(paths.routines(), { recursive: true }, scheduleRefresh);
  } catch {
    // Recursive watch is missing on some platforms; host events still refresh.
  }
  server.server.oninitialized = () => {
    bridge.agent = server.server.getClientVersion()?.name;
    // Lets the side panel show this agent as connected.
    bridge.call('agent.hello', {}, 5_000).catch(() => {});
  };
  await server.connect(new StdioServerTransport());
}
