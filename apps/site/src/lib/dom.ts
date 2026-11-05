import type { Summary } from './api';

// Everything from the API goes in as text, never as HTML.
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export function count(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
}

export function letter(site: string): string {
  return (site.replace(/^(www|dash|dashboard|search)\./, '').charAt(0) || '?').toUpperCase();
}

export function card(r: Summary): HTMLAnchorElement {
  return el(
    'a',
    { class: 'item', href: `/r?o=${encodeURIComponent(r.owner)}&n=${encodeURIComponent(r.name)}` },
    el('span', { class: 'ico', 'aria-hidden': 'true' }, letter(r.site)),
    el(
      'span',
      { class: 'body' },
      el('span', { class: 'title mono' }, el('span', { class: 'own' }, `${r.owner}/`), r.name),
      el('span', { class: 'desc' }, r.description.split('\n')[0] ?? ''),
      el('span', { class: 'meta mono' }, `${r.site} · v${r.version} · ${count(r.installs)} installs`),
    ),
  );
}
