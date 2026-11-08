import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDate, isPromise, isRegExp, isUint8Array } from 'node:util/types';
import vm from 'node:vm';

// Where the execute tool's code runs: a V8 context with no Node in it, which reaches Playwright only through the wrappers here.
// The wrappers give it no way to a Node object, and refuse what would read or write a file, reach the network from this process,
// or start a browser. This keeps honest code honest and is not a security boundary: V8 contexts are not one, and code here can
// already do anything a person could on the session's tabs. worker in execute.ts is what stops code that never yields.

export interface RealmResult {
  value?: string;
  error?: string;
  logs: string[];
  did: string[];
  files: string[];
}

const MAX_LOGS = 200;
const MAX_DID = 200;
const MAX_TEXT = 64 * 1024;
const MAX_FILE = 20 << 20;
const MAX_DEPTH = 16;

// What code gets. Anything else Playwright hands back (a Browser, a BrowserType, a request context, a download) stays out.
const CLASSES = new Set(['Page', 'BrowserContext', 'Frame', 'Locator', 'FrameLocator', 'Keyboard', 'Mouse', 'Touchscreen', 'ElementHandle', 'JSHandle', 'Request', 'Response', 'Dialog', 'ConsoleMessage', 'Clock']);

const REFUSED: Record<string, string> = {
  browser: 'the browser itself is not available here',
  browserType: 'the browser itself is not available here',
  newCDPSession: 'raw CDP is what cdp_endpoint is for',
  route: 'changing the requests of a page is not available here',
  routeFromHAR: 'it reads a file',
  routeWebSocket: 'changing the requests of a page is not available here',
  exposeBinding: 'a page cannot call back into this code',
  exposeFunction: 'a page cannot call back into this code',
  pause: 'nobody is there to resume it',
  setInputFiles: 'a file only goes to a page through the upload tool',
  storageState: 'it hands over every sign-in at once',
  bringToFront: 'this runs behind the person, so a window never comes to the front',
};

// What ends up in the record. The values are left out: a password can be among them.
const ACTIONS = new Set(['goto', 'reload', 'goBack', 'goForward', 'click', 'dblclick', 'tap', 'fill', 'type', 'pressSequentially', 'press', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'dragTo', 'dragAndDrop', 'setContent', 'evaluate', 'evaluateHandle', 'newPage', 'close', 'addCookies', 'clearCookies', 'mouse', 'accept', 'dismiss']);
const SAYS_WHERE = new Set(['goto', 'click', 'dblclick', 'tap', 'hover', 'check', 'uncheck']);

const HIDDEN = new Set(['constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'arguments', 'then']);

// Set up before any of the code runs, so it cannot change what these hold on to.
const SETUP = `(() => {
  Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
  delete Error.captureStackTrace;
  delete globalThis.WebAssembly;
  const then = Promise.prototype.then;
  const apply = Reflect.apply;
  return {
    Object, Array, Promise, Error, Date, Uint8Array,
    settle: (p, ok, bad) => { apply(then, p, [(v) => { ok(v); }, (e) => { bad(e); }]); },
  };
})()`;

function say(v: unknown) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return '(a value that cannot be shown)';
  }
}

/** Playwright's bundle changes its class names to keep them apart: _Page, BrowserType2. */
const classOf = (v: object) => v.constructor?.name?.replace(/^_+|\d+$/g, '') ?? '';

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export async function runInRealm(code: string, o: { page: object; context: object; dir: string; did?: (line: string) => void }): Promise<RealmResult> {
  const out: RealmResult = { logs: [], did: [], files: [] };
  const sandbox = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const R = new vm.Script(SETUP).runInContext(sandbox) as {
    Object: ObjectConstructor; Array: ArrayConstructor; Promise: PromiseConstructor; Error: ErrorConstructor; Date: DateConstructor; Uint8Array: Uint8ArrayConstructor;
    settle: (p: unknown, ok: (v: unknown) => void, bad: (e: unknown) => void) => void;
  };

  const real = new WeakMap<object, object>(); // a wrapper here -> the Playwright object
  const wrappers = new WeakMap<object, object>(); // the Playwright object -> its wrapper
  const theirs = new WeakMap<object, object>(); // a function made for Playwright -> the code's own

  const refuse = (what: string, why: string) => new Error(`${what} is not available in execute: ${why}.`);

  const toTheirError = (e: unknown) => {
    const made = new R.Error(typeof e === 'string' ? e : e instanceof Error ? e.message : 'It failed.');
    made.stack = `Error: ${made.message}`;
    return made;
  };

  /** A value on its way into the code. */
  const inward = (v: unknown, depth = 0): unknown => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
    const own = theirs.get(v as object);
    if (own) return own;
    if (typeof v === 'function') return wrap(v as object);
    if (isPromise(v)) return new R.Promise((ok, bad) => void (v as Promise<unknown>).then((x) => ok(inward(x)), (e) => bad(toTheirError(e))));
    if (v instanceof Error) return toTheirError(v);
    if (isUint8Array(v)) return new R.Uint8Array(v);
    if (isDate(v)) return new R.Date((v as Date).getTime());
    if (depth > MAX_DEPTH) return undefined;
    if (Array.isArray(v)) {
      const list = new R.Array();
      for (const x of v) list.push(inward(x, depth + 1));
      return list;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const copy = new R.Object() as Record<string, unknown>;
      for (const [k, x] of Object.entries(v as object)) if (k !== '__proto__') copy[k] = inward(x, depth + 1);
      return copy;
    }
    return wrap(v as object);
  };

  /** A value on its way out of the code, into Playwright. */
  const outward = (v: unknown, depth = 0): unknown => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
    const ours = real.get(v as object);
    if (ours) return ours;
    if (typeof v === 'function') {
      const fn = v as (...a: unknown[]) => unknown;
      const made = (...a: unknown[]) => {
        try {
          return outward(Reflect.apply(fn, undefined, a.map((x) => inward(x))));
        } catch (e) {
          throw new Error(say((e as Error)?.message ?? e));
        }
      };
      // Playwright sends a function to the page as its source.
      made.toString = () => Function.prototype.toString.call(fn);
      theirs.set(made, fn);
      return made;
    }
    if (isPromise(v)) return new Promise((ok, bad) => R.settle(v, (x) => ok(outward(x)), (e) => bad(new Error(say((e as Error)?.message ?? e)))));
    if (isUint8Array(v)) return Buffer.from(v as Uint8Array);
    if (isRegExp(v)) return new RegExp(RegExp.prototype.toString.call(v).replace(/^\/|\/[a-z]*$/g, ''), (v as RegExp).flags);
    if (isDate(v)) return new Date(Date.prototype.getTime.call(v));
    if (depth > MAX_DEPTH) return undefined;
    if (Array.isArray(v)) return Array.from(v, (x) => outward(x, depth + 1));
    const copy: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) if (k !== '__proto__') copy[k] = outward((v as Record<string, unknown>)[k], depth + 1);
    return copy;
  };

  const tooMuch = (name: string, args: unknown[]) => {
    if (name === 'addCookies' || name === 'clearCookies') return; // There, a path is a cookie's.
    const look = (v: unknown, depth: number): boolean => {
      if (v === null || typeof v !== 'object' || depth > 4) return false;
      return Object.entries(v as object).some(([k, x]) => k === 'path' || k === 'paths' || k === 'recordHar' || k === 'recordVideo' || look(x, depth + 1));
    };
    if (args.some((a) => look(a, 0))) throw refuse(`${name} with a path`, 'it would touch a file. Take the bytes it returns and use files.write');
  };

  const record = (parent: object | undefined, name: string) => {
    if (!ACTIONS.has(name) || out.did.length >= MAX_DID) return (_: unknown[]) => {};
    return (args: unknown[]) => {
      const where = parent && classOf(parent) === 'Locator' ? String(parent) : '';
      const what = SAYS_WHERE.has(name) && typeof args[0] === 'string' ? clip(args[0], 120) : '';
      const line = clip(`${where ? `${where}.` : ''}${name}(${what})`, 200);
      out.did.push(line);
      o.did?.(line);
    };
  };

  const wrap = (obj: object, parent?: object, name = 'function'): object => {
    const known = wrappers.get(obj);
    if (known) return known;
    const isFn = typeof obj === 'function';
    const made = new Proxy(isFn ? () => {} : Object.create(null), {
      get(_, key) {
        if (typeof key !== 'string' || HIDDEN.has(key) || key.startsWith('_')) return undefined;
        if (Object.hasOwn(REFUSED, key)) {
          const why = REFUSED[key];
          return wrap(() => {
            throw refuse(key, why);
          });
        }
        const v = Reflect.get(obj, key, obj);
        if (typeof v === 'function') return wrap(v, obj, key);
        if (v !== null && typeof v === 'object' && !isPlain(v) && !CLASSES.has(classOf(v))) return undefined;
        return inward(v);
      },
      has: (_, key) => typeof key === 'string' && !HIDDEN.has(key) && !key.startsWith('_') && key in obj,
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      getPrototypeOf: () => null,
      setPrototypeOf: () => false,
      preventExtensions: () => false,
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
      apply(_, __, args) {
        const given = args.map((a) => outward(a));
        try {
          if (Object.hasOwn(REFUSED, name)) throw refuse(name, REFUSED[name]);
          tooMuch(name, given);
          if (name === 'close' && parent && classOf(parent) === 'BrowserContext') throw refuse('Closing the context', 'it would close the session');
          record(parent, name)(given);
          const back = Reflect.apply(obj as (...a: unknown[]) => unknown, parent, given);
          if (isPromise(back)) return new R.Promise((ok, bad) => void (back as Promise<unknown>).then((x) => ok(allowed(x)), (e) => bad(toTheirError(e))));
          return allowed(back);
        } catch (e) {
          throw toTheirError(e);
        }
      },
      construct() {
        throw toTheirError('That cannot be made from here.');
      },
    });
    real.set(made, obj);
    wrappers.set(obj, made);
    return made;
  };

  const isPlain = (v: object) => {
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null || Array.isArray(v) || isUint8Array(v) || isDate(v) || v instanceof Error;
  };

  /** What Playwright hands back, with anything not on the list left out. */
  const allowed = (v: unknown): unknown => {
    if (Array.isArray(v)) return inward(v.map(allowed));
    if (v !== null && typeof v === 'object' && !isPlain(v) && !CLASSES.has(classOf(v))) return undefined;
    return inward(v);
  };

  const log = (...a: unknown[]) => {
    if (out.logs.length < MAX_LOGS) out.logs.push(clip(a.map(say).join(' '), 2000));
  };
  const timers = new Set<NodeJS.Timeout>();
  const later = (repeat: boolean) => (fn: () => void, ms?: number) => {
    const run = () => {
      try {
        fn();
      } catch (e) {
        log('A timer failed:', (e as Error).message);
      }
    };
    const t = repeat ? setInterval(run, Math.max(10, Number(ms) || 0)) : setTimeout(run, Number(ms) || 0);
    timers.add(t);
    return Number(t);
  };
  const stopTimer = (id: number) => {
    for (const t of timers) if (Number(t) === id) (clearTimeout(t), timers.delete(t));
  };
  let written = 0;
  const write = (name: string, data: string | Buffer) => {
    const file = String(name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
    if (!file) throw new Error('A file needs a name.');
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data ?? '');
    if (bytes.length > MAX_FILE || written + bytes.length > 5 * MAX_FILE) throw new Error('That is more than files.write keeps.');
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const path = join(o.dir, file);
    writeFileSync(path, bytes, { mode: 0o600 });
    written += statSync(path).size;
    if (!out.files.includes(path)) out.files.push(path);
    return path;
  };

  const globals = sandbox as Record<string, unknown>;
  globals.page = wrap(o.page);
  globals.context = wrap(o.context);
  const logger = new R.Object() as Record<string, unknown>;
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) logger[k] = wrap(log);
  globals.console = logger;
  globals.setTimeout = wrap(later(false));
  globals.setInterval = wrap(later(true));
  globals.clearTimeout = wrap(stopTimer);
  globals.clearInterval = wrap(stopTimer);
  const files = new R.Object() as Record<string, unknown>;
  files.write = wrap(write);
  globals.files = files;

  try {
    const begun = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: 'execute.js',
      importModuleDynamically: (async () => {
        throw toTheirError('import is not available in execute.');
      }) as never,
    }).runInContext(sandbox);
    const value = await (outward(begun) as Promise<unknown>);
    if (value !== undefined) out.value = clip(say(value), MAX_TEXT);
  } catch (e) {
    out.error = clip(say((e as Error)?.message ?? e), 4000);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  return out;
}
