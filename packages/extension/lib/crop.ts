import { dHash } from '@browser-routines/core';

// The third check: a perceptual hash of the area around an element.
// captureVisibleTab only sees the active tab, and Chrome allows two calls a second.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  dpr: number;
}

const PAD = 24;
let last = 0;

export async function screenshot(tabId: number): Promise<ImageBitmap | null> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) return null;
  const wait = last + 520 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  try {
    const url = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await (await fetch(url)).blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export function hashAt(img: ImageBitmap, r: Rect): string | undefined {
  const x = Math.max(0, (r.x - PAD) * r.dpr);
  const y = Math.max(0, (r.y - PAD) * r.dpr);
  const w = Math.min(img.width - x, (r.w + PAD * 2) * r.dpr);
  const h = Math.min(img.height - y, (r.h + PAD * 2) * r.dpr);
  if (w < 4 || h < 4) return undefined;
  const c = new OffscreenCanvas(9, 8);
  const g = c.getContext('2d')!;
  g.drawImage(img, x, y, w, h, 0, 0, 9, 8);
  const px = g.getImageData(0, 0, 9, 8).data;
  const gray = new Array<number>(72);
  for (let i = 0; i < 72; i++) gray[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
  return dHash(gray);
}

export async function cropHash(tabId: number, r: Rect): Promise<string | undefined> {
  const img = await screenshot(tabId);
  return img ? hashAt(img, r) : undefined;
}

export async function pngBase64(tabId: number): Promise<string> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) await browser.tabs.update(tabId, { active: true });
  const url = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return url.slice(url.indexOf(',') + 1);
}
