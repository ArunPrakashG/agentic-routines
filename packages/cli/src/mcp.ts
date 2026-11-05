import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { compileRun, missingParams, onSite, type Locator, type Routine, type Run, type RunResult } from '@browser-routines/core';
import { Bridge } from './bridge.ts';
import { paths } from './paths.ts';
import * as store from './store.ts';

const MAX_ROUTINE_TOOLS = 30;
const VERSION = '0.1.0';

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
    const v = process.env[`BROWSER_ROUTINES_SECRET_${s.toUpperCase()}`];
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
  const server = new McpServer({ name: 'browser-routines', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
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
    const want = new Set(all.map((r) => toolName(r.name)));
    for (const [name, tool] of routineTools) {
      if (!want.has(name)) {
        tool.remove();
        routineTools.delete(name);
      }
    }
    for (const l of all) {
      const name = toolName(l.name);
      let r: Routine;
      try {
        r = await store.read(`${l.owner}/${l.name}`);
      } catch {
        continue;
      }
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, p] of Object.entries(r.meta.params)) shape[k] = z.string().describe(p.description ?? (p.type === 'file' ? 'Path to a file' : k));
      const description = `${r.meta.description}\n\nReplays ${r.steps.length} recorded steps on ${r.meta.site} without the model.${r.meta.pauses.length ? ` Pauses before step ${r.meta.pauses.join(', ')} for approval.` : ''}`;
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

  server.registerTool('screenshot', { description: 'Screenshot of the visible part of the tab. Prefer read_page; images cost far more context.', inputSchema: { ...tab } }, async (a) => {
    const data = await bridge.call<string>('browser.screenshot', a);
    return { content: [{ type: 'image', data, mimeType: 'image/png' }] as Content[] };
  });

  // ---------- routines ----------

  server.registerTool('routines_list', { description: 'List saved routines with what each is for.' }, async () => {
    const all = await store.list();
    if (!all.length) return text('No routines saved yet. Every browser task you do is recorded; save one with routine_save.');
    return text(all.map((r) => `${r.owner === store.LOCAL ? '' : r.owner + '/'}${r.name} v${r.version} · ${r.site}${r.enabled ? '' : ' · off'}\n  ${r.description.replace(/\n/g, ' ')}`).join('\n'));
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
          r.meta.secrets.length ? `Secrets (set BROWSER_ROUTINES_SECRET_<NAME> or the user types them at a pause): ${r.meta.secrets.join(', ')}` : '',
          r.body,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    },
  );

  server.registerTool(
    'routine_run',
    { description: 'Replay a saved routine without the model. Same as its rt_ tool.', inputSchema: { name: z.string(), params: z.record(z.string()).optional() } },
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
    'routine_save',
    {
      description:
        'Save a recorded browser run as a routine. Write description as: what it does, then "Use when ..." in the words a user would say. Values typed during the run become params; name them by passing params { name: value typed }.',
      inputSchema: {
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).describe('Lowercase with dashes, e.g. play-release'),
        description: z.string().min(20).describe('What it does. Use when ...'),
        do_not_use_for: z.string().optional(),
        run_id: z.string().optional().describe('Defaults to the latest run'),
        params: z.record(z.string()).optional(),
        fixed: z.array(z.string()).optional().describe('Auto-detected params to keep as typed'),
      },
    },
    async (a) => {
      if (!/\buse when\b/i.test(a.description)) return fail('Add a "Use when ..." clause to the description so agents know when to pick this routine.');
      const run = await bridge.call<Run>('runs.get', { run_id: a.run_id });
      const body = a.do_not_use_for ? `## Do not use for\n${a.do_not_use_for}` : '';
      const { routine, recorded, dropped } = compileRun(run, { name: a.name, description: a.description, params: a.params, fixed: a.fixed, body });
      const saved = await bridge.call<Routine>('store.write', { routine });
      await bridge.call('runs.markSaved', { run_id: run.id }).catch(() => {});
      scheduleRefresh();
      const params = Object.keys(saved.meta.params);
      return text(
        `Saved ${saved.meta.name} v${saved.meta.version} · ${saved.steps.length} of ${recorded} recorded steps (${dropped} replaced by a direct URL)` +
          (params.length ? ` · asks for ${params.join(', ')}` : '') +
          (saved.meta.pauses.length ? ` · pauses before step ${saved.meta.pauses.join(', ')}` : '') +
          (saved.steps[0]?.url ? `\nStarts at ${saved.steps[0].url}, so it stays on what that address opens.` : '') +
          `\nRun it with ${toolName(saved.meta.name)}.`,
      );
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
