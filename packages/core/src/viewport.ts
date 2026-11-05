// The size of the page when a step was recorded. Layout changes with it: a menu folds into a button, a
// column drops below another, and the picture around an element no longer looks the same. A replay
// compares the two and says how far apart they are.

/** CSS pixels of the page area, and the device pixel ratio. */
export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

// Where common stylesheets change the layout: phone, large phone, tablet, laptop, desktop, wide.
const BREAKPOINTS = [480, 768, 1024, 1280, 1536];

export function band(w: number): number {
  let i = 0;
  while (i < BREAKPOINTS.length && w >= BREAKPOINTS[i]) i++;
  return i;
}

export type ViewportMatch = 'same' | 'near' | 'different';

export interface ViewportCheck {
  match: ViewportMatch;
  /** Plain words for the result and the panel. Absent when the same. */
  note?: string;
}

/**
 * Same band, or a few percent either side of a breakpoint: the layout is the one that was recorded.
 * One band over and close in width: near. Anything else: different. Height and pixel ratio alone do
 * not change the layout, and the crop is measured in CSS pixels, so they are not compared.
 */
export function compareViewport(recorded: Viewport | undefined, now: Viewport | undefined): ViewportCheck {
  if (!recorded || !now || !(recorded.w > 0) || !(now.w > 0)) return { match: 'same' };
  const ratio = now.w / recorded.w;
  const apart = Math.abs(band(recorded.w) - band(now.w));
  if (apart === 0 && ratio > 0.7 && ratio < 1.45) return { match: 'same' };
  if (apart <= 1 && ratio > 0.9 && ratio < 1.12) return { match: 'near' };
  return {
    match: 'different',
    note: `The page is ${now.w}px wide and the routine was recorded at ${recorded.w}px. The layout can differ, so the picture check is switched off for this run and the page structure and the element decide.`,
  };
}
