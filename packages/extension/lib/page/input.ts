import { platform } from '../platform';
import type { Send } from '../platform/types';
import { ask, draw, sleep } from './tabs';

// Real input. Through a DevTools session a click, a key and typed text reach the page the way a person's do, so a site
// cannot tell them apart. Without a session (Firefox), or if the input did not arrive, the page script sends DOM events.

const DRAW_MS = 150;
const LAND_MS = 1000;

/**
 * Send input. The renderer answers on its next frame, and a tab behind another draws none until it is asked for one, which
 * can take seconds. The input itself is already in the page's queue by then, so this does not wait for the answer: what
 * matters, whether it arrived, is checked afterwards.
 */
async function sendInput(tabId: number, send: Send, method: string, params: object) {
  const sent = send(method, params).then(() => true);
  if (!(await Promise.race([sent, sleep(DRAW_MS).then(() => false)]))) draw(tabId, send);
}

export interface MouseOpts {
  button?: 'left' | 'right' | 'middle';
  count?: number;
  modifiers?: number;
}

/** Move, press and release at a point in the page. */
export async function mouseClick(tabId: number, send: Send, x: number, y: number, o: MouseOpts = {}) {
  const button = o.button ?? 'left';
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  const base = { x, y, modifiers: o.modifiers ?? 0 };
  await sendInput(tabId, send, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
  for (let clickCount = 1; clickCount <= (o.count ?? 1); clickCount++) {
    await sendInput(tabId, send, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', button, buttons, clickCount });
    await sendInput(tabId, send, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', button, buttons: 0, clickCount });
  }
}

// Names to what the protocol wants. A single printable character needs none of this.
const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };

const MODS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, cmd: 4, meta: 4, command: 4, win: 4, windows: 4, shift: 8 };
const COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

/** A key is one name, or names joined by +: Enter, a, ctrl+a, shift+Tab. */
export async function pressKey(tabId: number, send: Send, combo: string) {
  const parts = combo.split('+').filter(Boolean);
  const name = parts.pop() ?? combo;
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (bit === undefined) throw new Error(`“${m}” is not a modifier. Use ctrl, shift, alt or cmd.`);
    modifiers |= bit;
  }
  const named = KEYS[name.toLowerCase()];
  if (!named && name.length !== 1) throw new Error(`“${name}” is not a key this tool knows. Use a single character or a name like Enter, Tab, Escape, ArrowDown, Backspace, F5.`);
  const upper = name.toUpperCase();
  const key = named ?? {
    key: name,
    code: /[a-z]/i.test(name) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : '',
    vk: upper.charCodeAt(0),
    text: name,
  };
  // Holding ctrl, alt or cmd makes a shortcut, which types nothing.
  const text = modifiers & 7 ? undefined : key.text;
  const held = modifiers & 6;
  const commands = held && COMMANDS[name.toLowerCase()] ? [COMMANDS[name.toLowerCase()]] : undefined;
  const ev = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk, modifiers };
  await sendInput(tabId, send, 'Input.dispatchKeyEvent', { ...ev, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) });
  await sendInput(tabId, send, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
}

// Nobody is watching the cursor in a tab behind another.
const behind = async (tabId: number) => !(await browser.tabs.get(tabId)).active;

interface Aim {
  x: number;
  y: number;
  /** The point lands on this element, or on something that is part of it. */
  hit: boolean;
  /** What a person would be clicking on instead, when it does not. */
  over?: string;
}

/** Click an element for real. Says what was on top of it, if something was. */
async function realClick(tabId: number, ref: string, o: MouseOpts = {}): Promise<{ done: boolean; note?: string }> {
  const a = await ask<Aim>(tabId, { t: 'aim', ref, action: 'click', quick: await behind(tabId) });
  if (!a.hit) return { done: false, note: a.over ? `“${a.over}” is drawn over it, so a person could not have clicked it; check the page took it.` : undefined };
  return platform.cdp!(tabId, async (send) => {
    const before = (await browser.tabs.get(tabId)).url;
    await mouseClick(tabId, send, a.x, a.y, o);
    // A page that left, or went away, took the click with it.
    for (const end = Date.now() + LAND_MS; Date.now() < end; await sleep(50)) {
      if (await ask<boolean>(tabId, { t: 'landed' }).catch(() => true)) return { done: true };
      if ((await browser.tabs.get(tabId)).url !== before) return { done: true };
    }
    return { done: false };
  });
}

/** Type for real: focus the field, select what is in it, and put the text in as an input method would. */
async function realType(tabId: number, ref: string, text: string): Promise<boolean> {
  const ok = await ask<boolean>(tabId, { t: 'ready', ref, quick: await behind(tabId) });
  if (!ok) return false;
  await platform.cdp!(tabId, async (send) => {
    if (!text) return void (await pressKey(tabId, send, 'Backspace'));
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (i) await pressKey(tabId, send, 'Enter');
      if (line) await sendInput(tabId, send, 'Input.insertText', { text: line });
    }
  });
  for (const end = Date.now() + LAND_MS; Date.now() < end; await sleep(50)) if (await ask<boolean>(tabId, { t: 'typed', ref, value: text })) return true;
  return false;
}

async function realPress(tabId: number, ref: string | undefined, keys: string) {
  if (ref) await ask(tabId, { t: 'ready', ref, keep: true, quick: await behind(tabId) });
  await platform.cdp!(tabId, async (send) => {
    for (const k of keys.split(/\s+/).filter(Boolean)) await pressKey(tabId, send, k);
  });
  return true;
}

/**
 * Do something to the page. Real input where the browser has it, and DOM events otherwise or when it did not arrive.
 * What comes back, if anything, is for the agent to hear.
 */
export async function perform(tabId: number, ref: string | undefined, action: string, value?: string): Promise<string | undefined> {
  let note: string | undefined;
  if (platform.cdp) {
    try {
      if (action === 'click' && ref) {
        const r = await realClick(tabId, ref);
        if (r.done) return;
        note = r.note;
      } else if ((action === 'type' || action === 'clear') && ref) {
        if (await realType(tabId, ref, action === 'clear' ? '' : (value ?? ''))) return;
      } else if (action === 'press') {
        if (await realPress(tabId, ref, value ?? 'Enter')) return;
      }
    } catch (e) {
      // A key the agent got wrong is its to hear. Anything else is the session: the page still takes DOM events.
      if (/is not a (modifier|key)|is gone from the page/.test((e as Error).message)) throw e;
    }
  }
  await ask(tabId, { t: 'act', ref, action, value, quick: await behind(tabId) });
  return note;
}
