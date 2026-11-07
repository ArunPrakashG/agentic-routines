// Runs in the page. Finds text a person looking at the page would not see: what is not drawn, drawn
// off the page, too small or too faint to read, the same colour as what is behind it, or marked
// aria-hidden. A page can use these to talk to an agent without talking to the user.

const FRESH_MS = 300;
const seen = new WeakMap<Element, { at: number; why: string | null }>();

type Rgba = [number, number, number, number];

function parse(c: string): Rgba | undefined {
  const m = /^rgba?\(([^)]+)\)$/.exec(c.trim());
  if (!m) return undefined;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  if (p.length < 3 || p.some(Number.isNaN)) return undefined;
  return [p[0], p[1], p[2], p[3] ?? 1];
}

function luminance([r, g, b]: Rgba): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour behind an element's text, or undefined when a picture or gradient could be there. */
function backdrop(el: Element): Rgba | undefined {
  for (let e: Element | null = el; e; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host as Element | undefined) ?? null) {
    const s = getComputedStyle(e);
    if (s.backgroundImage !== 'none') return undefined;
    const bg = parse(s.backgroundColor);
    if (bg && bg[3] >= 0.95) return bg;
    if (bg && bg[3] > 0.05) return undefined;
  }
  // The page's own canvas. A dark scheme paints it dark and we cannot tell from here.
  return matchMedia('(prefers-color-scheme: dark)').matches ? undefined : [255, 255, 255, 1];
}

function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) return true;
  return false;
}

/** Why this element's own content is not seen by a person, or null. Looks at the element and what it sits in. */
export function hiddenWhy(el: Element): string | null {
  const now = Date.now();
  const hit = seen.get(el);
  if (hit && now - hit.at < FRESH_MS) return hit.why;
  let why = ownWhy(el);
  const up = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host as Element | undefined);
  if (!why && up && up !== document.documentElement) why = hiddenWhy(up);
  seen.set(el, { at: now, why });
  return why;
}

function ownWhy(el: Element): string | null {
  if (el instanceof HTMLElement && (el.hidden || el.hasAttribute('inert'))) return 'not shown';
  const s = getComputedStyle(el);
  if (s.display === 'none') return 'not shown';
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'not shown';
  if (Number(s.opacity) < 0.05) return 'transparent';
  const size = parseFloat(s.fontSize);
  if (size < 3) return 'tiny text';
  const cp = s.clipPath;
  if (/inset\(\s*(?:50|100)%/.test(cp) || /circle\(\s*0/.test(cp)) return 'clipped';
  if (/rect\(\s*(?:0|1)(?:px)?[ ,]+(?:0|1)(?:px)?[ ,]+(?:0|1)(?:px)?[ ,]+(?:0|1)(?:px)?\s*\)/.test(s.clip)) return 'clipped';
  const r = el.getBoundingClientRect();
  if ((r.width < 1 || r.height < 1) && s.overflow !== 'visible' && (el.textContent ?? '').trim()) return 'zero size';
  if (r.width >= 1 && r.height >= 1) {
    const left = r.left + scrollX;
    const top = r.top + scrollY;
    const wide = Math.max(document.documentElement.scrollWidth, innerWidth);
    // Above or left of where the page starts can never be scrolled to; right of its width is cut off.
    if (left + r.width < 0 || top + r.height < 0 || left > wide) return 'off the page';
  }
  if (parseFloat(s.textIndent) < -500 && s.overflow !== 'visible') return 'off the page';
  if (hasOwnText(el)) {
    const fill = parse(s.getPropertyValue('-webkit-text-fill-color'));
    const color = parse(s.color);
    if ((fill && fill[3] < 0.05) || (color && color[3] < 0.05)) return 'transparent';
    const back = backdrop(el);
    if (color && back && contrast(color, back) < 1.1) return 'same colour as its background';
  }
  return null;
}

/** aria-hidden on the element or what it sits in. */
export const ariaHidden = (el: Element) => !!el.closest('[aria-hidden="true"]');
