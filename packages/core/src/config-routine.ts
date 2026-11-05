import { isMap, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap } from 'yaml';
import { HOOK_EVENTS, HOOK_LIMITS, isHookEvent, type Hooks } from './hooks.ts';

// `config.routine` in the root of a repository says what routines it holds. YAML, version 1:
//
//   version: 1
//   name: acme-console-routines
//   description: Routines for the Acme Console.
//   instructions: |
//     Read the notes of a routine before running it.
//   routines:
//     - name: acme-release
//       description: Upload a bundle and start the rollout. Use when the user asks to release a build.
//       path: routines/acme-release.md
//
// The checks are written by hand, not with a schema library, so every message can name the file, the line
// and the field, and say what to change.

export const CONFIG_FILE = 'config.routine';
export const MAX_CONFIG = 128 * 1024;

export interface RepoRoutine {
  /** The line the routine starts on, for messages. */
  line: number;
  name: string;
  description: string;
  /** Where the routine file is, relative to the repository root. */
  path: string;
  instructions?: string;
  /** Hosts the routine works on. When set, the routine file's site must be one of them or under one. */
  sites?: string[];
  /** What each value is for, as the author words it. The routine file decides which values exist. */
  params?: Record<string, { description?: string; type?: 'string' | 'file' }>;
  hooks?: Hooks;
}

export interface RepoConfig {
  version: 1;
  name: string;
  description: string;
  instructions?: string;
  routines: RepoRoutine[];
}

export interface ConfigProblem {
  file: string;
  line: number;
  /** The field as a path: routines[1].path. Empty for the file as a whole. */
  field: string;
  message: string;
}

/** `config.routine:14 routines[1].path: …` */
export const formatProblem = (p: ConfigProblem) => `${p.file}:${p.line}${p.field ? ` ${p.field}` : ''}: ${p.message}`;

export class ConfigError extends Error {
  problems: ConfigProblem[];
  constructor(problems: ConfigProblem[]) {
    super(problems.slice(0, 5).map(formatProblem).join('\n') + (problems.length > 5 ? `\n… and ${problems.length - 5} more.` : ''));
    this.problems = problems;
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PARAM = /^[a-z][a-z0-9_]{0,40}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost(:\d+)?$|^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
/** A file in the repository: letters, digits, dots, dashes and underscores in each part, no `..`, at most 5 folders deep. */
export const REPO_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/){0,5}[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/;
const FIELDS = ['version', 'name', 'description', 'instructions', 'routines'];
const ROUTINE_FIELDS = ['name', 'description', 'path', 'instructions', 'sites', 'params', 'hooks'];
const PARAM_FIELDS = ['description', 'type'];

export const isRepoPath = (p: string) => p.length <= 160 && REPO_PATH.test(p) && !p.split('/').some((part) => part === '..' || part === '.');

/**
 * Reads config.routine. Returns every problem found rather than the first, so one edit can fix them all.
 * `config` is null when there is any.
 */
export function parseConfigRoutine(text: string, file = CONFIG_FILE): { config: RepoConfig | null; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  if (text.length > MAX_CONFIG) return { config: null, problems: [{ file, line: 1, field: '', message: `The file is larger than ${MAX_CONFIG / 1024} KB.` }] };
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });

  const lineOf = (n: unknown): number => {
    const node = n as { range?: [number, number, number] | null; key?: { range?: [number, number, number] | null } } | null | undefined;
    const range = node?.range ?? node?.key?.range;
    return range ? lc.linePos(range[0]).line : 1;
  };
  const bad = (node: unknown, field: string, message: string) => void problems.push({ file, line: lineOf(node), field, message });

  for (const e of doc.errors) problems.push({ file, line: lc.linePos(e.pos[0]).line, field: '', message: e.message.split('\n')[0].replace(/ at line \d+, column \d+.*/, '') });
  if (doc.errors.length) return { config: null, problems };
  if (doc.warnings.length) for (const w of doc.warnings) problems.push({ file, line: lc.linePos(w.pos[0]).line, field: '', message: w.message.split('\n')[0] });

  const root = doc.contents;
  if (!isMap(root)) return { config: null, problems: [{ file, line: 1, field: '', message: 'The file must be a list of fields, starting with “version: 1”.' }] };

  const unknown = (map: YAMLMap, known: string[], at: string) => {
    for (const p of map.items) {
      const k = isScalar(p.key) ? String(p.key.value) : '';
      if (!known.includes(k)) bad(p, at ? `${at}.${k}` : k, `Unknown field “${k}”. The fields are: ${known.join(', ')}.`);
    }
  };
  const pair = (map: YAMLMap, key: string) => map.items.find((p) => isScalar(p.key) && p.key.value === key);
  /** The text of a field, or undefined with a problem recorded. */
  const text_ = (map: YAMLMap, key: string, at: string, o: { required?: boolean; max: number }): string | undefined => {
    const p = pair(map, key);
    const field = at ? `${at}.${key}` : key;
    if (!p) {
      if (o.required) bad(map, field, 'Missing. Add it.');
      return undefined;
    }
    if (!isScalar(p.value) || typeof p.value.value !== 'string') {
      bad(p, field, 'Must be text. Put it in quotes if it looks like a number or a date.');
      return undefined;
    }
    const v = p.value.value.trim();
    if (!v && o.required) bad(p, field, 'Must not be empty.');
    if (v.length > o.max) {
      bad(p, field, `Too long: ${v.length} characters, at most ${o.max}.`);
      return undefined;
    }
    return v;
  };

  unknown(root, FIELDS, '');

  const vp = pair(root, 'version');
  if (!vp) bad(root, 'version', 'Missing. Start the file with “version: 1”.');
  else if (!isScalar(vp.value) || vp.value.value !== 1) bad(vp, 'version', `This reader knows version 1, not ${isScalar(vp.value) ? JSON.stringify(vp.value.value) : 'that'}.`);

  const name = text_(root, 'name', '', { required: true, max: 63 });
  if (name && !NAME.test(name)) bad(pair(root, 'name'), 'name', 'Use lowercase letters, digits and dashes, 2 to 63 characters.');
  const description = text_(root, 'description', '', { required: true, max: 500 });
  const instructions = text_(root, 'instructions', '', { max: 4000 });

  const routines: RepoRoutine[] = [];
  const rp = pair(root, 'routines');
  if (!rp) bad(root, 'routines', 'Missing. List at least one routine.');
  else if (!isSeq(rp.value)) bad(rp, 'routines', 'Must be a list: each routine starts with “- name: …”.');
  else if (rp.value.items.length === 0) bad(rp, 'routines', 'The list is empty. Add at least one routine.');
  else if (rp.value.items.length > 50) bad(rp, 'routines', 'At most 50 routines in one repository.');
  else {
    const names = new Map<string, number>();
    const paths = new Map<string, number>();
    rp.value.items.forEach((item, i) => {
      const at = `routines[${i}]`;
      if (!isMap(item)) return bad(item, at, 'Must be a set of fields: name, description, path.');
      unknown(item, ROUTINE_FIELDS, at);
      const rname = text_(item, 'name', at, { required: true, max: 63 });
      if (rname) {
        if (!NAME.test(rname)) bad(pair(item, 'name'), `${at}.name`, 'Use lowercase letters, digits and dashes, 2 to 63 characters.');
        else if (names.has(rname)) bad(pair(item, 'name'), `${at}.name`, `“${rname}” is already routines[${names.get(rname)}].`);
        else names.set(rname, i);
      }
      const rdesc = text_(item, 'description', at, { required: true, max: 1024 });
      if (rdesc && !/\buse when\b/i.test(rdesc)) bad(pair(item, 'description'), `${at}.description`, 'Say when to use it, starting with “Use when”.');
      const path = text_(item, 'path', at, { required: true, max: 160 });
      if (path) {
        if (!isRepoPath(path)) bad(pair(item, 'path'), `${at}.path`, 'Must be a .md file inside the repository, like routines/acme-release.md. No “..”, no leading slash.');
        else if (paths.has(path)) bad(pair(item, 'path'), `${at}.path`, `“${path}” is already routines[${paths.get(path)}].`);
        else paths.set(path, i);
      }
      const rinst = text_(item, 'instructions', at, { max: 4000 });

      let sites: string[] | undefined;
      const sp = pair(item, 'sites');
      if (sp) {
        if (!isSeq(sp.value)) bad(sp, `${at}.sites`, 'Must be a list of hosts, like [console.acme.test].');
        else {
          sites = [];
          if (sp.value.items.length === 0 || sp.value.items.length > 10) bad(sp, `${at}.sites`, 'List 1 to 10 hosts.');
          sp.value.items.forEach((s, j) => {
            const h = isScalar(s) && typeof s.value === 'string' ? s.value.trim().toLowerCase() : '';
            if (!HOST.test(h)) bad(s, `${at}.sites[${j}]`, 'Must be a host name like console.acme.test, with no https:// and no path.');
            else sites!.push(h);
          });
        }
      }

      let params: RepoRoutine['params'];
      const pp = pair(item, 'params');
      if (pp) {
        if (!isMap(pp.value)) bad(pp, `${at}.params`, 'Must be a set of values: each name with a description.');
        else {
          params = {};
          if (pp.value.items.length > 30) bad(pp, `${at}.params`, 'At most 30 values.');
          for (const q of pp.value.items) {
            const k = isScalar(q.key) ? String(q.key.value) : '';
            const pat = `${at}.params.${k}`;
            if (!PARAM.test(k)) {
              bad(q, pat, 'A value name is lowercase letters, digits and underscores, starting with a letter.');
              continue;
            }
            if (isScalar(q.value) && typeof q.value.value === 'string') params[k] = { description: q.value.value.trim().slice(0, 300) };
            else if (isMap(q.value)) {
              unknown(q.value, PARAM_FIELDS, pat);
              const d = text_(q.value, 'description', pat, { max: 300 });
              const tp = pair(q.value, 'type');
              let type: 'string' | 'file' | undefined;
              if (tp) {
                const tv = isScalar(tp.value) ? tp.value.value : null;
                if (tv === 'string' || tv === 'file') type = tv;
                else bad(tp, `${pat}.type`, 'Must be “string” or “file”.');
              }
              params[k] = { ...(d ? { description: d } : {}), ...(type ? { type } : {}) };
            } else bad(q, pat, 'Write a description, or a set with description and type.');
          }
        }
      }

      let hooks: Hooks | undefined;
      const hp = pair(item, 'hooks');
      if (hp) {
        if (!isMap(hp.value)) bad(hp, `${at}.hooks`, 'Must be a set of events, each with the code to run: “step.before: |”.');
        else {
          hooks = {};
          let total = 0;
          for (const q of hp.value.items) {
            const k = isScalar(q.key) ? String(q.key.value) : '';
            const hat = `${at}.hooks.${k}`;
            if (!isHookEvent(k)) {
              bad(q, hat, `Not an event. The events are: ${HOOK_EVENTS.join(', ')}.`);
              continue;
            }
            const code = isScalar(q.value) && typeof q.value.value === 'string' ? q.value.value : null;
            if (code === null || !code.trim()) bad(q, hat, 'Must be the code to run, as text. Use “|” for several lines.');
            else if (code.length > HOOK_LIMITS.code) bad(q, hat, `The code is ${code.length} characters, at most ${HOOK_LIMITS.code}.`);
            else {
              total += code.length;
              hooks[k] = code;
            }
          }
          if (total > HOOK_LIMITS.total) bad(hp, `${at}.hooks`, `All the hooks together are ${total} characters, at most ${HOOK_LIMITS.total}.`);
        }
      }

      if (rname && rdesc && path)
        routines.push({
          line: lineOf(item),
          name: rname,
          description: rdesc,
          path,
          ...(rinst ? { instructions: rinst } : {}),
          ...(sites?.length ? { sites } : {}),
          ...(params && Object.keys(params).length ? { params } : {}),
          ...(hooks && Object.keys(hooks).length ? { hooks } : {}),
        });
    });
  }

  problems.sort((a, b) => a.line - b.line);
  if (problems.length || !name || !description) return { config: null, problems };
  return { config: { version: 1, name, description, ...(instructions ? { instructions } : {}), routines }, problems };
}

/** Same, but throws one error that lists the problems. */
export function readConfigRoutine(text: string, file = CONFIG_FILE): RepoConfig {
  const { config, problems } = parseConfigRoutine(text, file);
  if (!config) throw new ConfigError(problems);
  return config;
}

/** The sites check: does a routine's site sit under one the config lists? An empty or absent list allows any. */
export function siteListed(sites: string[] | undefined, site: string): boolean {
  if (!sites?.length) return true;
  return sites.some((s) => site === s || site.endsWith('.' + s));
}
