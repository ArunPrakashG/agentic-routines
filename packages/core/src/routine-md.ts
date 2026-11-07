import { parse, stringify } from 'yaml';
import { checkHooks, readHooks } from './hooks.ts';
import { checkUrls, readUrls } from './urls.ts';
import { MAX_EXPECT, SURFACES, type Expect, type RoutineMeta, type Surface } from './types.ts';
import type { Viewport } from './viewport.ts';

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function repoOf(v: unknown): RoutineMeta['repo'] {
  const o = v as { name?: unknown; instructions?: unknown } | undefined;
  if (!o || typeof o !== 'object' || typeof o.name !== 'string') return undefined;
  return { name: o.name.slice(0, 63), ...(typeof o.instructions === 'string' && o.instructions ? { instructions: o.instructions.slice(0, 4000) } : {}) };
}

function surfaceOf(v: unknown): Surface | undefined {
  if (v === undefined || v === null || v === 'browser') return undefined;
  if (SURFACES.includes(v as Surface)) return v as Surface;
  throw new Error(`ROUTINE.md surface “${String(v)}” is not one this version knows (browser, desktop).`);
}

function validViewport(v: unknown): Viewport | undefined {
  const o = v as Partial<Viewport> | undefined;
  if (!o || !(o.w! > 0 && o.w! < 20000) || !(o.h! > 0 && o.h! < 20000)) return undefined;
  return { w: Math.round(o.w!), h: Math.round(o.h!), dpr: o.dpr! > 0 && o.dpr! < 10 ? o.dpr! : 1 };
}

export function parseRoutineMd(text: string): { meta: RoutineMeta; body: string } {
  const m = FENCE.exec(text);
  if (!m) throw new Error('ROUTINE.md has no frontmatter');
  const raw = (parse(m[1]) ?? {}) as Partial<RoutineMeta>;
  if (!raw.name) throw new Error('ROUTINE.md frontmatter has no name');
  const meta: RoutineMeta = {
    name: String(raw.name),
    owner: raw.owner ? String(raw.owner) : undefined,
    version: Number(raw.version ?? 1),
    site: String(raw.site ?? ''),
    urls: readUrls((raw as { urls?: unknown }).urls),
    surface: surfaceOf((raw as { surface?: unknown }).surface),
    description: String(raw.description ?? '').trim(),
    params: raw.params ?? {},
    secrets: raw.secrets ?? [],
    pauses: raw.pauses ?? [],
    requires: raw.requires,
    returns: raw.returns,
    drafted_by: raw.drafted_by ? String(raw.drafted_by) : undefined,
    viewport: validViewport((raw as { viewport?: unknown }).viewport),
    instructions: raw.instructions ? String(raw.instructions).slice(0, 4000) : undefined,
    repo: repoOf(raw.repo),
    hooks: readHooks((raw as { hooks?: unknown }).hooks),
    expect: expectOf((raw as { expect?: unknown }).expect),
  };
  return { meta, body: text.slice(m[0].length).trim() };
}

function expectOf(raw: unknown): Expect | undefined {
  const e = raw as Expect | null | undefined;
  const text = typeof e?.text === 'string' ? e.text.slice(0, MAX_EXPECT) : undefined;
  const url = typeof e?.url === 'string' ? e.url.slice(0, MAX_EXPECT) : undefined;
  return text || url ? { ...(text ? { text } : {}), ...(url ? { url } : {}) } : undefined;
}

export function stringifyRoutineMd(meta: RoutineMeta, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) clean[k] = v;
  // Examples are the user's own values; they stay in steps.json on this machine only.
  const params: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(meta.params)) {
    const { example: _drop, ...rest } = p;
    params[k] = rest;
  }
  clean.params = params;
  const fm = stringify(clean, { lineWidth: 80 }).trimEnd();
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

export interface LintIssue {
  field: string;
  message: string;
}

/** Rules a routine must pass before it can be published. */
export function lintForPublish(meta: RoutineMeta, stepUrls: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(meta.name))
    issues.push({ field: 'name', message: 'Use lowercase letters, digits and dashes.' });
  if (!meta.description) issues.push({ field: 'description', message: 'Add when to use it.' });
  else if (!/\buse when\b/i.test(meta.description))
    issues.push({ field: 'description', message: 'Say when to use it, starting with "Use when".' });
  if (meta.description.length > 1024)
    issues.push({ field: 'description', message: 'Keep it under 1024 characters.' });
  if (!meta.site) issues.push({ field: 'site', message: 'No site set.' });
  for (const m of checkUrls(meta.urls, meta.site)) issues.push({ field: 'urls', message: m });
  if (meta.surface && meta.surface !== 'browser') issues.push({ field: 'surface', message: 'Only browser routines can be published for now.' });
  if ((meta.instructions?.length ?? 0) > 4000) issues.push({ field: 'instructions', message: 'Keep the notes for the agent under 4000 characters.' });
  for (const m of checkHooks(meta.hooks)) issues.push({ field: 'hooks', message: m });
  for (const u of stepUrls) {
    if (!onSite(u, meta.site)) {
      issues.push({ field: 'steps', message: `A step leaves ${meta.site}: ${hostOf(u)}` });
      break;
    }
  }
  return issues;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'another address';
  } catch {
    return 'an address that is not valid';
  }
}

/** Is this web address on the site, or one of its subdomains? Anything but http and https is not. */
export function onSite(url: string, site: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.username || u.password) return false;
    return u.host === site || u.host.endsWith('.' + site);
  } catch {
    return false;
  }
}
