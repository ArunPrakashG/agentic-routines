import type { Send } from '../platform/types';
import { settings } from './settings';
import { sleep } from './tabs';

// Input at a person's pace, for a browser where that setting is on. Off, the pointer jumps and a click takes no time.
//
// It is for pages that react to movement, such as menus that open on the way past or a canvas that follows the pointer, and for
// a person who wants to follow along. It is not a way past a bot check. It does not try to look like a particular person,
// so there is no tremor or overshoot, and nothing here touches what a page can read about the browser. A check that comes up
// goes to the person, as it always does.

const FRAME_MS = 16;
const MIN_MS = 120;
const MAX_MS = 650;
/** Beyond this, a long text would take minutes, so it goes in one piece. */
export const MAX_PACED_TYPING = 400;

const last = new Map<number, { x: number; y: number }>();

export const paced = () => settings().humanInput;

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** A short wait, such as how long a button stays down or the gap between two keys. */
export const pause = (lo: number, hi: number) => (paced() ? sleep(between(lo, hi)) : Promise.resolve());

/** Bring the pointer to a point along a curve, ending just short of it: the caller's own move lands. */
export async function glideTo(tabId: number, send: Send, x: number, y: number, modifiers = 0) {
  const from = last.get(tabId);
  last.set(tabId, { x, y });
  if (!paced() || !from) return;
  const dx = x - from.x;
  const dy = y - from.y;
  const far = Math.hypot(dx, dy);
  if (far < 4) return;
  const ms = Math.min(MAX_MS, MIN_MS + 70 * Math.log2(1 + far / 12));
  const steps = Math.max(4, Math.round(ms / FRAME_MS));
  // Bowed to one side by a little, in proportion to how far it goes.
  const bow = between(-0.12, 0.12) * far;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const eased = t * t * (3 - 2 * t);
    const off = bow * Math.sin(Math.PI * t);
    // Not waiting for each answer: a tab behind another answers on its next frame, and what counts is that they go in order.
    void send('Input.dispatchMouseEvent', { x: from.x + dx * eased - (dy / far) * off, y: from.y + dy * eased + (dx / far) * off, type: 'mouseMoved', button: 'none', buttons: 0, modifiers }).catch(() => {});
    await sleep(FRAME_MS);
  }
}

/** A wheel turn as a short eased burst. */
export async function glideWheel(send: (deltaX: number, deltaY: number) => Promise<unknown>, by: { x: number; y: number }) {
  if (!paced()) return send(by.x, by.y);
  const steps = 12;
  let sentX = 0;
  let sentY = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t * t * (3 - 2 * t);
    const x = by.x * eased - sentX;
    const y = by.y * eased - sentY;
    sentX += x;
    sentY += y;
    if (i === steps) return send(x, y);
    void send(x, y).catch(() => {});
    await sleep(FRAME_MS);
  }
}
