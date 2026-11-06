import { dHash } from '@agentic-routines/core';
import { platform } from '../platform';
import { bare, rendering } from '../page/tabs';

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
const CAPTURE_MS = 1500;
const AREA_W = 640;
const AREA_H = 360;
let last = 0;

// Pictures are taken one at a time, however many sessions ask: the browser allows two a second in all.
let queue: Promise<unknown> = Promise.resolve();

// A window on a hidden workspace never answers captureVisibleTab.
function capture(windowId: number): Promise<string> {
  const take = async () => {
    const wait = last + 520 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return Promise.race([
      browser.tabs.captureVisibleTab(windowId, { format: 'png' }),
      new Promise<string>((_, no) => setTimeout(() => no(new Error('The browser window is not visible')), CAPTURE_MS)),
    ]);
  };
  const next = queue.then(take, take);
  queue = next.catch(() => {});
  return next;
}

export async function screenshot(tabId: number): Promise<ImageBitmap | null> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) return null;
  return bare(tabId, () => shoot(tabId, tab.windowId));
}

async function shoot(tabId: number, windowId: number): Promise<ImageBitmap | null> {
  if (!(await rendering(tabId))) return null;
  try {
    const url = await capture(windowId);
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

/** What an agent sees unless it asks for more: an area around an element, else the whole tab at half size. */
export async function areaBase64(tabId: number, around?: Rect): Promise<{ data: string; area: boolean }> {
  const data = await pngBase64(tabId);
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
  const tab = await browser.tabs.get(tabId);
  const dpr = img.width / (tab.width || img.width);
  const vw = img.width / dpr;
  const vh = img.height / dpr;
  const onScreen = around && around.w > 0 && around.h > 0 && around.x < vw && around.y < vh && around.x + around.w > 0 && around.y + around.h > 0;
  let [x, y, w, h, outW, outH] = [0, 0, vw, vh, Math.round(vw / 2), Math.round(vh / 2)];
  if (onScreen) {
    w = Math.min(vw, Math.max(AREA_W, around.w + PAD * 2));
    h = Math.min(vh, Math.max(AREA_H, around.h + PAD * 2));
    x = Math.min(vw - w, Math.max(0, around.x + around.w / 2 - w / 2));
    y = Math.min(vh - h, Math.max(0, around.y + around.h / 2 - h / 2));
    [outW, outH] = [Math.round(w), Math.round(h)];
  }
  const c = new OffscreenCanvas(outW, outH);
  c.getContext('2d')!.drawImage(img, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, outW, outH);
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), area: !!onScreen };
}

export async function pngBase64(tabId: number): Promise<string> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) await browser.tabs.update(tabId, { active: true });
  return bare(tabId, () => grab(tabId, tab.windowId));
}

async function grab(tabId: number, windowId: number): Promise<string> {
  try {
    const url = await capture(windowId);
    return url.slice(url.indexOf(',') + 1);
  } catch (e) {
    // Without a DevTools session a hidden window stays an error.
    if (!platform.cdp) throw e;
    return platform.cdp(tabId, async (send) => (await send<{ data: string }>('Page.captureScreenshot', { format: 'png' })).data);
  }
}
