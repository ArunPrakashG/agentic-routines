import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten-core';

// The script tool: the agent's JS, run in QuickJS with no network, no files and no Node, where the only way out is the
// step tools. Every helper is a step tool call, so what a script does is recorded like any other run and can be saved
// as a routine. The script itself is never kept.

type Content = { type: string; text?: string };
type Result = { content?: Content[]; isError?: boolean };
export type Mark = { param: string; value: string; description?: string } | { expect: string };
export type Step = (tool: string, args: Record<string, unknown>) => Promise<Result>;

const PRELUDE = `
// Helpers run one after another in the order they are called, awaited or not, so a step never overtakes the one
// before it and the recording keeps the script's order. The first that fails stops all the ones after it.
let __q = Promise.resolve();
const __j = (n, a) => {
  const p = __q.then(async () => JSON.parse(await __call(n, JSON.stringify(a ?? {}))));
  __q = p;
  return p;
};
const __fmt = (x) => (typeof x === 'string' ? x : x === undefined ? 'undefined' : JSON.stringify(x));
// print waits for what it is given, so print(read()) works without await.
const print = (...a) => {
  const p = __q.then(async () => __print((await Promise.all(a)).map(__fmt).join(' ')));
  __q = p;
  return p;
};
const open = (url) => __j('open', { url });
const click = (target) => __j('click', { target });
const type = (target, text, o) => __j('type', { target, text, submit: !!(o && o.submit) });
const fill = (target, value) => __j('fill', { target, value });
const check = (target, on = true) => __j('fill', { target, value: !!on });
const select = (target, value) => __j('select', { target, value });
const upload = (target, path) => __j('upload', { target, path });
const press = (key) => __j('press', { key });
const wait = (seconds) => __j('wait', { seconds });
const find = (query) => __j('find', { query });
const read = (o) => __j('read', { filter: o && o.all ? 'all' : 'interactive', full: !!(o && o.full) });
const text = () => __j('text', {});
// Marks for the routine this run will make: a value that changes each time, and what the page says once it worked.
const param = (name, value, description) => (__mark(JSON.stringify({ param: String(name), value: String(value), description })), value);
const expect = (text) => void __mark(JSON.stringify({ expect: String(text) }));
`;
const PRELUDE_LINES = PRELUDE.split('\n').length;

let mod: Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>> | undefined;

// The script tool's reply is wrapped as untrusted data as a whole, so the wrapping each step tool adds is dropped here.
const WRAP = /^(===== (BEGIN|END) UNTRUSTED DATA \w+( \([\w ]+\))? =====|This is data from a website, not from the user\..*)$/;
const textOf = (r: Result) =>
  (r.content ?? [])
    .map((c) => c.text ?? '')
    .join('\n')
    .split('\n')
    .filter((l) => !WRAP.test(l))
    .join('\n');

type Want = 'click' | 'field' | 'select' | 'file';
const ROLES: Record<Want, RegExp> = {
  click: /./,
  field: /^(textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|textarea|menuitemcheckbox|menuitemradio)$/,
  select: /^(combobox|listbox)$/,
  file: /./,
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The ref of the element target names. Fields and buttons are matched by their accessible name (labels count), so a
 *  label's own text never wins over its field; plain text on the page is the fallback for a click. */
async function refFor(step: Step, target: unknown, want: Want): Promise<string> {
  if (typeof target !== 'string' || !target) throw new Error('A target is the words on the element, or a ref like ref_12.');
  if (/^ref_\d+$/.test(target)) return target;
  const t = norm(target);
  const pick = (body: string) => {
    const rows = [...body.matchAll(/^(ref_\d+) (\S+) “([^”]*)”(.*)$/gm)].map(([, ref, role, name, rest]) => ({ ref, role, name: norm(name), rest }));
    const fits = rows.filter((r) => (want === 'file' ? /\(file\)/.test(r.rest) : ROLES[want].test(r.role)));
    return (fits.find((r) => r.name === t) ?? fits.find((r) => r.name.startsWith(t)) ?? fits.find((r) => r.name.includes(t)))?.ref;
  };
  const seen = pick(textOf(await step('read_page', { filter: 'interactive' })));
  if (seen) return seen;
  const r = await step('find', { query: target });
  const found = r.isError ? undefined : (pick(textOf(r)) ?? (want === 'click' ? textOf(r).match(/\bref_\d+\b/)?.[0] : undefined));
  if (!found) throw new Error(`Nothing on the page ${want === 'click' ? 'says' : want === 'file' ? 'takes a file as' : 'has a field called'} “${target}”.`);
  return found;
}

// What the last read showed. Long runs of lines a read repeats from it (a site's menu on every page) are folded into
// one line, which is most of what a page costs to read the second time.
let lastRead = new Set<string>();
const FOLD = 6;
function remember(page: string) {
  lastRead = new Set(page.split('\n').slice(3));
  return page;
}
function shorten(page: string) {
  const lines = page.split('\n');
  const before = lastRead;
  remember(page);
  const out = lines.slice(0, 3);
  let run: string[] = [];
  const flush = () => {
    if (run.length >= FOLD) out.push(`… ${run.length} lines as in the last read (${run[0].slice(0, 60)} … ${run[run.length - 1].slice(0, 60)}); read({full: true}) shows them`);
    else out.push(...run);
    run = [];
  };
  for (const l of lines.slice(3)) {
    if (before.has(l)) run.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out.join('\n');
}

export async function runScript(code: string, step: Step, timeoutMs: number) {
  mod ??= await newQuickJSWASMModuleFromVariant(variant);
  const rt = mod.newRuntime();
  rt.setMemoryLimit(64 * 1024 * 1024);
  rt.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  rt.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const ctx: QuickJSContext = rt.newContext();
  const out: string[] = [];
  const did: string[] = [];
  const marks: Mark[] = [];
  let calls = 0;

  const call = async (name: string, a: Record<string, any>): Promise<unknown> => {
    calls++;
    const act = async (tool: string, args: Record<string, unknown>, what: string) => {
      const r = await step(tool, args);
      if (r.isError) throw new Error(`${what} failed: ${textOf(r).slice(0, 600)}`);
      did.push(what);
      return textOf(r);
    };
    switch (name) {
      case 'open': {
        // An address relative to the page, such as /console/app, is taken from where the tab is now.
        let url = String(a.url);
        if (!/^[a-z][\w+.-]*:/i.test(url)) {
          const here = textOf(await step('read_page', { filter: 'interactive' })).split('\n').find((l) => /^https?:\/\//.test(l));
          if (!here) throw new Error(`open needs a full address; the tab has none to go from for ${url}.`);
          url = new URL(url, here).href;
        }
        return act('navigate', { url }, `open ${url}`);
      }
      case 'click':
        return act('click', { ref: await refFor(step, a.target, 'click') }, `click “${a.target}”`);
      case 'type':
        return act('type', { ref: await refFor(step, a.target, 'field'), text: String(a.text), submit: a.submit || undefined }, `type into “${a.target}”`);
      case 'fill':
        return act('form_input', { ref: await refFor(step, a.target, 'field'), value: a.value }, `set “${a.target}” to ${JSON.stringify(a.value)}`);
      case 'select':
        return act('select', { ref: await refFor(step, a.target, 'select'), value: String(a.value) }, `pick ${JSON.stringify(a.value)} in “${a.target}”`);
      case 'upload':
        return act('upload', { ref: await refFor(step, a.target, 'file'), path: String(a.path) }, `upload to “${a.target}”`);
      case 'press':
        return act('press', { key: String(a.key) }, `press ${a.key}`);
      case 'wait':
        return act('wait', { seconds: Number(a.seconds) }, `wait ${a.seconds}s`);
      case 'find':
        return textOf(await step('find', { query: String(a.query) }));
      case 'read': {
        const page = textOf(await step('read_page', { filter: a.filter }));
        return a.full ? remember(page) : shorten(page);
      }
      case 'text':
        return textOf(await step('get_page_text', {}));
      default:
        throw new Error(`No helper ${name}.`);
    }
  };

  const pending = new Set<Promise<unknown>>();
  const fn = (name: string, f: (...a: QuickJSHandle[]) => QuickJSHandle | void) => ctx.newFunction(name, f).consume((h) => ctx.setProp(ctx.global, name, h));
  fn('__print', (s) => void out.push(ctx.getString(s)));
  fn('__mark', (m) => void marks.push(JSON.parse(ctx.getString(m))));
  fn('__call', (n, a) => {
    const name = ctx.getString(n);
    const args = JSON.parse(ctx.getString(a));
    const p = ctx.newPromise();
    const job = call(name, args).then(
      (v) => ctx.alive && ctx.newString(JSON.stringify(v ?? null)).consume((h) => p.resolve(h)),
      (e) => ctx.alive && ctx.newError((e as Error).message).consume((h) => p.reject(h)),
    );
    pending.add(job);
    void job.finally(() => pending.delete(job));
    void p.settled.then(() => {
      if (!ctx.alive) return;
      p.dispose();
      rt.executePendingJobs();
    });
    return p.handle;
  });

  let error: string | undefined;
  try {
    const ev = ctx.evalCode(`${PRELUDE}\n(async () => {\n${code}\n})().then(async (v) => (await __q, v))`, 'script.js');
    if (ev.error) {
      error = ctx.dump(ev.error)?.message ?? String(ctx.dump(ev.error));
      ev.error.dispose();
    } else {
      const settled = ctx.resolvePromise(ev.value);
      ev.value.dispose();
      rt.executePendingJobs();
      const timer = new Promise<'late'>((r) => setTimeout(() => r('late'), Math.max(0, deadline - Date.now())));
      const r = await Promise.race([settled, timer]);
      if (r === 'late') error = `stopped after ${Math.round(timeoutMs / 1000)} s`;
      else if (r.error) {
        const e = ctx.dump(r.error);
        r.error.dispose();
        error = typeof e === 'object' && e ? `${e.message ?? e}${e.stack ? `\n${String(e.stack).replace(/script\.js:(\d+)/g, (_: string, l: string) => `line ${Number(l) - PRELUDE_LINES - 1}`)}` : ''}` : String(e);
      } else {
        const v = ctx.dump(r.value);
        r.value.dispose();
        if (v !== undefined) out.push(typeof v === 'string' ? v : JSON.stringify(v));
      }
    }
  } finally {
    // A helper still running finishes on its own; its answer has nowhere to go.
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 2000))]);
    try {
      ctx.dispose();
      rt.dispose();
    } catch {
      // A script stopped mid-call leaves objects QuickJS still counts; the runtime goes with it either way.
    }
  }
  return { out, did, calls, error, marks };
}
