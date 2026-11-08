import { dHash } from '@agentic-routines/core';
import { platform } from '../platform';
import { bare, rendering } from '../page/tabs';
import { annotatePng, paint, toBase64, type Mark } from './annotate';

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

/** The part of the page a picture shows and at what size, so a point read off it can be turned back into a point in the page. */
export interface Frame {
  x: number;
  y: number;
  /** Page pixels to one pixel of the picture. */
  sx: number;
  sy: number;
}

/** A PNG says its size in its first bytes. */
export function pngSize(b64: string) {
  const head = atob(b64.slice(0, 44));
  const at = (i: number) => (head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3);
  return { w: at(16), h: at(20) };
}

const ZOOM_W = 1280;

/** Part of the page, a little enlarged so small print can be read. */
export async function regionBase64(tabId: number, r: { x: number; y: number; w: number; h: number }): Promise<{ data: string; frame: Frame; w: number; h: number }> {
  const data = await pngBase64(tabId);
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
  const tab = await browser.tabs.get(tabId);
  const dpr = img.width / (tab.width || img.width);
  const k = Math.min(2, ZOOM_W / r.w);
  const [outW, outH] = [Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k))];
  const c = new OffscreenCanvas(outW, outH);
  c.getContext('2d')!.drawImage(img, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr, 0, 0, outW, outH);
  return { data: await toBase64(c), frame: { x: r.x, y: r.y, sx: r.w / outW, sy: r.h / outH }, w: outW, h: outH };
}

/** What an agent sees unless it asks for more: an area around an element, else the whole tab at half size. */
export async function areaBase64(tabId: number, around?: Rect, marks: Mark[] = []): Promise<{ data: string; area: boolean; frame: Frame; w: number; h: number }> {
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
  const g = c.getContext('2d')!;
  g.drawImage(img, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, outW, outH);
  paint(g, marks, outW / w, x, y);
  return { data: await toBase64(c), area: !!onScreen, frame: { x, y, sx: w / outW, sy: h / outH }, w: outW, h: outH };
}

/** The whole tab with marks on it. */
export async function markedPng(tabId: number, marks: Mark[]): Promise<string> {
  const data = await pngBase64(tabId);
  return annotatePng(data, marks, (await browser.tabs.get(tabId)).width ?? 0);
}

export async function pngBase64(tabId: number): Promise<string> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) {
    // A picture of the window shows the tab in front, so a tab behind another is taken through the DevTools
    // session, and the person is not switched away from what they are looking at. Browsers without one bring it forward.
    if (platform.cdp) return bare(tabId, () => platform.cdp!(tabId, async (send) => (await send<{ data: string }>('Page.captureScreenshot', { format: 'png' })).data));
    await browser.tabs.update(tabId, { active: true });
  }
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
