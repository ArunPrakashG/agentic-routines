import { IRREVERSIBLE, isIrreversible } from './compile.ts';
import { isBlock, spanOf } from './blocks.ts';
import { onSite } from './routine-md.ts';
import type { Locator, Routine, Step } from './types.ts';

// A routine's steps as Playwright code. It is worked out from the steps, with no model, so it costs nothing to make and
// cannot drift from them. Its only use is speed: a run through it stops at every pause, and on any failure carries on step
// by step from where it got to. The code uploaded with a published routine is for reading. What runs is compiled here, from
// the steps installed here.
//
// Nothing from a routine goes into the code except as a JSON string, and comments have their line breaks taken out, as a
// routine can be someone else's and this runs in the same process as the agent's server. Secrets stay placeholders.

/** Where the replay takes over from a fast run, and what the run has by then. */
export interface FastFrom {
  /** The step to go on from. 0 is past the last one. */
  n: number;
  /** The loop it was in, and how far. */
  loop?: { n: number; pass: number; values?: string[]; index: number; seen: number };
  params: Record<string, string>;
  read: Record<string, string>;
  steps_run: number;
  ms: number;
  /** Why it stopped short. */
  why?: string;
}

const str = (s: string) => JSON.stringify(s);
const comment = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\*\//g, '* /').slice(0, 100);

/** A value with its {{params}} in it, as an expression. */
function value(v: string | undefined, encode = false): string {
  const parts: string[] = [];
  let last = 0;
  const text = v ?? '';
  for (const m of text.matchAll(/\{\{(secret:)?([a-z0-9_]+)\}\}/g)) {
    if (m.index > last) parts.push(str(text.slice(last, m.index)));
    const got = m[1] ? `secret(${str(m[2])})` : `param(params, ${str(m[2])})`;
    parts.push(encode ? `encodeURIComponent(${got})` : got);
    last = m.index + m[0].length;
  }
  if (last < text.length || !parts.length) parts.push(str(text.slice(last)));
  return parts.join(' + ');
}

/** Where to look: the page, or the frame the element was in, or the dialog it sat in. */
function scope(t: Locator): string {
  const base = t.frame ? `h.frame(${str(t.frame)})` : 'page';
  return t.modal ? `${base}.getByRole("dialog", { name: ${str(t.modal)} })` : base;
}

/** The most stable thing known about an element first, as the replay does. An element that is no longer unique fails, and the replay takes over. */
export function locate(t: Locator): string {
  const at = scope(t);
  const testid = t.attrs['data-testid'];
  if (testid) return `${at}.getByTestId(${str(testid)})`;
  const id = t.attrs.id;
  if (id) return `${at}.locator(${str(`[id="${id.replace(/["\\]/g, '\\$&')}"]`)})`;
  if (t.role && t.name) return `${at}.getByRole(${str(t.role)}, { name: ${str(t.name)}, exact: true })`;
  const name = t.attrs.name;
  if (name) return `${at}.locator(${str(`[name="${name.replace(/["\\]/g, '\\$&')}"]`)})`;
  if (t.attrs.placeholder) return `${at}.getByPlaceholder(${str(t.attrs.placeholder)}, { exact: true })`;
  if (t.text) return `${at}.getByText(${str(t.text)}, { exact: true })`;
  return `${at}.locator(${str(t.css)})`;
}

const MODS: Record<string, string> = { ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta' };
const modsOf = (m?: string) => (m ? m.split('+').map((x) => MODS[x.trim().toLowerCase()] ?? x.trim()) : []);

function clickOptions(s: Step): string {
  const p = s.pointer;
  const o: string[] = [];
  if (p?.button && p.button !== 'left') o.push(`button: ${str(p.button)}`);
  if (p?.count && p.count > 1) o.push(`clickCount: ${Number(p.count)}`);
  if (p?.mods) o.push(`modifiers: ${JSON.stringify(modsOf(p.mods))}`);
  return o.length ? `{ ${o.join(', ')} }` : '';
}

function target(s: Step): string {
  const l = locate(s.target!);
  if (s.pick === 'first') return `${l}.first()`;
  if (s.pick === 'each') return `${l}.nth(index)`;
  return l;
}

/** Steps a fast run does not do itself: a person has to see them, or only the replay holds what they need. */
export function fastStops(r: Routine, foreign: boolean): Set<number> {
  const out = new Set<number>();
  r.steps.forEach((s, i) => {
    const prev = r.steps[i - 1];
    if (s.pause || s.action === 'handoff' || s.value?.includes('{{secret:')) out.add(s.n);
    if (foreign && isIrreversible({ action: s.action, target: s.target })) out.add(s.n);
    if (foreign && s.target?.frame && !onSite(s.target.frame, r.meta.site)) out.add(s.n);
    // The file has to be the person's: a parameter, never a path in the routine.
    if (s.action === 'upload' && r.meta.params[/^\{\{([a-z0-9_]+)\}\}$/.exec(s.value ?? '')?.[1] ?? '']?.type !== 'file') out.add(s.n);
    // Set would mean filling in what the replay knows how to fill in. It goes step by step.
    if (s.action === 'set' || (s.action === 'drag' && !s.pointer?.to?.target)) out.add(s.n);
    if (s.action === 'dialog' && !s.dismiss) {
      // Yes to a dialog has to be looked at, and the step that opens it blocks until it is answered. So it stops one step sooner.
      out.add(s.n);
      if (prev) out.add(prev.n);
    }
  });
  return out;
}

function stepCode(s: Step, next: Step | undefined, stops: Set<number>): string[] {
  const out: string[] = [`// ${s.n}. ${comment(s.label || s.action)}${stops.has(s.n) ? ' (waits for the replay)' : ''}`];
  if (s.action === 'navigate') {
    out.push(`await h.go(${s.n}, ${value(s.url, true)});`);
    return out;
  }
  out.push(`await at(${s.n});`);
  if (next?.action === 'dialog' && next.dismiss) out.push(`h.answerNext(false);`);
  if (s.pick === 'each') out.push(`await h.checkRow(${s.n}, ${target(s)});`);
  const l = s.target ? target(s) : '';
  switch (s.action) {
    case 'click': {
      const o = clickOptions(s);
      const spot = s.pointer?.spot;
      out.push(spot ? `await h.clickAt(${l}, ${Number(spot.x)}, ${Number(spot.y)}${o ? `, ${o}` : ''});` : `await ${l}.click(${o});`);
      break;
    }
    case 'type':
      out.push(`await ${l}.fill(${value(s.value)});`);
      break;
    case 'clear':
      out.push(`await ${l}.clear();`);
      break;
    case 'select':
      out.push(`await ${l}.selectOption(${value(s.value)});`);
      break;
    case 'upload':
      out.push(`await ${l}.setInputFiles(h.paths(${value(s.value)}));`);
      break;
    case 'press':
      out.push(`await h.press(${value(s.value)}${s.target ? `, ${l}` : ''});`);
      break;
    case 'wait':
      out.push(`await ${l}.waitFor();`);
      break;
    case 'read':
      out.push(`h.read(${str(s.label)}, await ${l}.innerText());`);
      break;
    case 'hover':
      out.push(`await ${l}.hover();`);
      break;
    case 'drag':
      out.push(`await ${l}.dragTo(${locate(s.pointer!.to!.target)});`);
      break;
    case 'scroll':
      if (s.target) out.push(`await ${l}.scrollIntoViewIfNeeded();`);
      if (s.pointer?.by) out.push(`await page.mouse.wheel(${Number(s.pointer.by.x)}, ${Number(s.pointer.by.y)});`);
      break;
    // Answered above, by the step that opens it.
    case 'dialog':
    case 'set':
    case 'handoff':
      break;
  }
  return out;
}

function walk(r: Routine, stops: Set<number>, a: number, z: number, pad: string, out: string[]) {
  for (let i = a; i < z; ) {
    const s = r.steps[i];
    if (!isBlock(s)) {
      for (const line of stepCode(s, r.steps[i + 1], stops)) out.push(pad + line);
      i++;
      continue;
    }
    const [first, end] = spanOf(s, i);
    out.push(`${pad}// ${s.n}. ${comment(s.label || s.action)}`);
    out.push(`${pad}await at(${s.n});`);
    if (s.action === 'each') {
      const e = s.each!;
      if (e.param) out.push(`${pad}await h.eachValue(${s.n}, ${str(e.param)}, ${Number(e.limit)}, async () => {`);
      else out.push(`${pad}await h.eachRow(${s.n}, ${locate(e.matching!)}, ${Number(e.limit)}, async (index) => {`);
      walk(r, stops, first, end, `${pad}  `, out);
      out.push(`${pad}});`);
    } else {
      const w = s.when!;
      const test = w.text ? `h.hasText(${value(w.text)})` : `h.has(${locate(w.has!)})`;
      out.push(`${pad}if (${w.not ? '!' : ''}(await ${test})) {`);
      walk(r, stops, first, first + w.then, `${pad}  `, out);
      if (w.else) {
        out.push(`${pad}} else {`);
        walk(r, stops, first + w.then, end, `${pad}  `, out);
      }
      out.push(`${pad}}`);
    }
    i = end;
  }
}

// What the code needs that Playwright does not say in one line. The loops work the way the replay's do.
const HELPERS = `const param = (params, name) => {
  if (params[name] === undefined) throw new Error("Missing param " + name);
  return params[name];
};

function helpers(page, at, state) {
  const IRREVERSIBLE = new RegExp(${JSON.stringify(IRREVERSIBLE.source)}, ${JSON.stringify(IRREVERSIBLE.flags)});
  const plain = (t) => t.replace(/\\s+/g, " ").trim().toLowerCase();
  const soon = async (fn) => {
    const end = Date.now() + 1500;
    while (true) {
      const yes = await fn().catch(() => false);
      if (yes || Date.now() > end) return yes;
      await page.waitForTimeout(250);
    }
  };
  const h = {
    async go(n, url) {
      await at(n, { url });
      await page.goto(url);
    },
    frame(url) {
      const f = page.frames().find((x) => x.url() === url) ?? page.frames().find((x) => x.url().split("?")[0] === url.split("?")[0]);
      if (!f) throw new Error("No frame at " + url);
      return f;
    },
    answerNext(accept) {
      page.once("dialog", (d) => void (accept ? d.accept() : d.dismiss()).catch(() => {}));
    },
    async clickAt(l, x, y, options = {}) {
      const box = await l.boundingBox();
      if (!box) throw new Error("Nothing to click");
      await l.click({ ...options, position: { x: box.width * x, y: box.height * y } });
    },
    async checkRow(n, l) {
      // Whichever row this pass is on was not the one recorded.
      if (IRREVERSIBLE.test(await l.innerText().catch(() => ""))) await at(n, { pause: true });
    },
    paths: (v) => v.split("\\n").map((p) => p.trim()).filter(Boolean),
    async press(keys, l) {
      const NAMES = { ctrl: "Control", control: "Control", cmd: "Meta", command: "Meta", meta: "Meta", win: "Meta", windows: "Meta", shift: "Shift", alt: "Alt", enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", space: "Space", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
      const name = (k) => NAMES[k.toLowerCase()] ?? (/^f\\d+$/i.test(k) ? k.toUpperCase() : k);
      for (const combo of keys.split(/\\s+/).filter(Boolean)) {
        const c = combo.split("+").map(name).join("+");
        await (l ? l.press(c) : page.keyboard.press(c));
      }
    },
    read(label, text) {
      state.read[state.loop ? label + " (" + state.loop.pass + ")" : label] = text;
    },
    hasText: (text) => soon(async () => plain(await page.evaluate(() => document.body?.innerText ?? "")).includes(plain(text))),
    has: (l) => soon(async () => (await l.count()) > 0),
    async eachValue(n, name, limit, body) {
      const values = state.params[name].split(state.params[name].includes("\\n") ? /\\r?\\n/ : ",").map((v) => v.trim()).filter(Boolean);
      if (values.length > limit) throw new Error("Step " + n + " was given more values than its limit");
      state.loop = { n, pass: 0, values, index: 0, seen: 0 };
      while (state.loop.values.length) {
        state.params[name] = state.loop.values.shift();
        state.loop.pass++;
        await body();
      }
      state.loop = undefined;
    },
    async eachRow(n, l, limit, body) {
      state.loop = { n, pass: 0, index: 0, seen: 0 };
      while (state.loop.pass < limit) {
        // A pass that took its row off the list leaves the next row where this one was.
        const now = await soon(() => l.count()) || 0;
        if (state.loop.pass > 0 && now >= state.loop.seen) state.loop.index++;
        state.loop.seen = now;
        if (state.loop.index >= now) break;
        state.loop.pass++;
        await body(state.loop.index);
      }
      state.loop = undefined;
    },
  };
  return h;
}`;

/** The body of run(), the same in the file a person reads and in what a fast run runs. */
function runBody(r: Routine, foreign: boolean): string {
  const out: string[] = [];
  walk(r, fastStops(r, foreign), 0, r.steps.length, '  ', out);
  return `async function run(page, state, at, secret) {
  const h = helpers(page, at, state);
  const params = state.params;
${out.join('\n')}
}`;
}

/** What a fast run evaluates: nothing but the code above, and made here from the steps that are installed. */
export function fastProgram(r: Routine, foreign: boolean): string {
  return `${HELPERS}\n\n${runBody(r, foreign)}\n\nreturn run;`;
}

/** The script a person or a reviewer reads, and can run with Node. */
export function toPlaywright(r: Routine): string {
  const owner = r.meta.owner ? `${r.meta.owner}/` : '';
  const names = comment(Object.keys(r.meta.params).map((k) => `${k}=...`).join(' '));
  const secrets = r.meta.secrets?.length ? `\n// Secrets are not in this file. It reads them from the environment: ${comment(r.meta.secrets.map((s) => `SECRET_${s.toUpperCase()}`).join(', '))}.` : '';
  return `// ${comment(`${owner}${r.meta.name}, version ${r.meta.version}, on ${r.meta.site}`)}
// Compiled from the routine's steps by Agentic Routines. No model wrote it, and it changes only when the steps do.
// CDP_ENDPOINT=<from the cdp_endpoint tool> node thisfile.mjs ${names}
// It stops at every step that waits for a person. To go past some: APPROVE=3,7 node thisfile.mjs${secrets}

${HELPERS}

export ${runBody(r, false)}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT);
  const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].newPage());
  const state = { params: Object.fromEntries(process.argv.slice(2).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)])), read: {} };
  const stops = new Set(${JSON.stringify([...fastStops(r, false)])});
  const approved = new Set((process.env.APPROVE ?? "").split(",").filter(Boolean).map(Number));
  const at = async (n, o) => {
    if ((o?.pause || stops.has(n)) && !approved.has(n)) throw new Error("Step " + n + " waits for a person. Stopped here.");
  };
  const secret = (name) => {
    const v = process.env["SECRET_" + name.toUpperCase()];
    if (v === undefined) throw new Error("Set SECRET_" + name.toUpperCase());
    return v;
  };
  try {
    await run(page, state, at, secret);
    console.log(JSON.stringify(state.read));
  } finally {
    await browser.close();
  }
}
`;
}
