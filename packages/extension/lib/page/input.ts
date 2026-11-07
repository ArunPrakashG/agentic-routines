import { platform } from '../platform';
import type { Send } from '../platform/types';
import type { FieldState, How, Point } from './dom';
import { toTab } from './frames';
import { glideTo, glideWheel, MAX_PACED_TYPING, paced, pause } from './paced';
import { ask, draw, frameOf, sleep } from './tabs';

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
  await glideTo(tabId, send, x, y, base.modifiers);
  await sendInput(tabId, send, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
  await pause(30, 90);
  for (let clickCount = 1; clickCount <= (o.count ?? 1); clickCount++) {
    await sendInput(tabId, send, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', button, buttons, clickCount });
    await pause(50, 120);
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

function modifiersOf(names: string[]) {
  let modifiers = 0;
  for (const m of names) {
    const bit = MODS[m.toLowerCase()];
    if (bit === undefined) throw new Error(`“${m}” is not a modifier. Use ctrl, shift, alt or cmd.`);
    modifiers |= bit;
  }
  return modifiers;
}

/** A key is one name, or names joined by +: Enter, a, ctrl+a, shift+Tab. */
export async function pressKey(tabId: number, send: Send, combo: string) {
  const parts = combo.split('+').filter(Boolean);
  const name = parts.pop() ?? combo;
  const modifiers = modifiersOf(parts);
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

const mouseOpts = (how: How): MouseOpts => ({ button: how.button, count: how.count, modifiers: modifiersOf((how.mods ?? '').split('+').filter(Boolean)) });

/** Whether the input just sent reached what it was aimed at. A page that left, or went away, took it with it. */
async function arrived(tabId: number, before: string | undefined, ref: string) {
  for (const end = Date.now() + LAND_MS; Date.now() < end; await sleep(50)) {
    if (await ask<boolean>(tabId, { t: 'landed' }, frameOf(ref)).catch(() => true)) return true;
    if ((await browser.tabs.get(tabId)).url !== before) return true;
  }
  return false;
}

/** Aim at an element, with the check that nothing is on top of it. A place on the element is exact or it is nothing. */
async function aimFor(tabId: number, ref: string, action: string, how: How) {
  const local = await ask<Aim>(tabId, { t: 'aim', ref, action, spot: how.spot, at: how.at, moving: action === 'hover', quick: await behind(tabId) });
  // The aim is in the element's own document. Input goes to the tab.
  const tab = await toTab(tabId, ref, local, true);
  const a: Aim = { ...local, x: tab.x, y: tab.y, ...(tab.over ? { hit: false, over: tab.over } : {}) };
  if (!a.hit && how.spot) throw new Error(`“${a.over ?? 'Something else'}” is drawn over that place, so the ${action} was not made.`);
  return a;
}

/** Click an element for real. Says what was on top of it, if something was. */
async function realClick(tabId: number, ref: string, how: How): Promise<{ done: boolean; note?: string }> {
  const a = await aimFor(tabId, ref, 'click', how);
  if (!a.hit) return { done: false, note: a.over ? `“${a.over}” is drawn over it, so a person could not have clicked it; check the page took it.` : undefined };
  return platform.cdp!(tabId, async (send) => {
    const before = (await browser.tabs.get(tabId)).url;
    await mouseClick(tabId, send, a.x, a.y, mouseOpts(how));
    return { done: await arrived(tabId, before, ref) };
  });
}

/** Leave the pointer over an element. What opens under it opens on its next frame. */
async function realHover(tabId: number, ref: string, how: How) {
  const a = await aimFor(tabId, ref, 'hover', how);
  if (!a.hit) return false;
  return platform.cdp!(tabId, async (send) => {
    const before = (await browser.tabs.get(tabId)).url;
    await glideTo(tabId, send, a.x, a.y);
    await sendInput(tabId, send, 'Input.dispatchMouseEvent', { x: a.x, y: a.y, type: 'mouseMoved', button: 'none', buttons: 0 });
    const done = await arrived(tabId, before, ref);
    draw(tabId, send);
    return done;
  });
}

const DRAG_MOVES = 8;

/** Press on one place, move in steps as a hand would, let go on another. Both have to be on screen. */
async function realDrag(tabId: number, ref: string, how: How) {
  const from = await aimFor(tabId, ref, 'drag', how);
  const end = how.toAt ?? (await ask<Point & { off: boolean }>(tabId, { t: 'where', ref: how.toRef!, spot: how.to?.spot }));
  if ('off' in end && end.off) throw new Error('The place to drag to is not on screen from there. Scroll so both ends show first.');
  const to = await toTab(tabId, how.toRef, end);
  if (!from.hit) return false;
  return platform.cdp!(tabId, async (send) => {
    const before = (await browser.tabs.get(tabId)).url;
    const mouse = (type: string, p: Point, extra: object) => sendInput(tabId, send, 'Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
    await mouse('mouseMoved', from, { button: 'none', buttons: 0 });
    await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
    if (!(await arrived(tabId, before, ref))) return false;
    for (let i = 1; i <= DRAG_MOVES; i++) {
      const k = i / DRAG_MOVES;
      await mouse('mouseMoved', { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }, { button: 'left', buttons: 1 });
    }
    await mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 });
    draw(tabId, send);
    return true;
  });
}

const SCROLL_MS = 600;

/** Scroll what is at a place, with the wheel where that can be trusted. Says where that got to. */
async function realScroll(tabId: number, p: Point, by: Point, ref?: string) {
  const frame = frameOf(ref);
  const onTab = await toTab(tabId, ref, p);
  const pos = () => ask<{ key: string; top: number; height: number }>(tabId, { t: 'scrollpos', p }, frame);
  const start = await pos();
  const moved = async () => (await pos()).key !== start.key;
  const wheel = async () => {
    if (!platform.cdp) return;
    await platform.cdp(tabId, (send) => glideWheel((deltaX, deltaY) => sendInput(tabId, send, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: onTab.x, y: onTab.y, deltaX, deltaY, button: 'none', buttons: 0 }), by)).catch(() => {});
    for (const end = Date.now() + SCROLL_MS; Date.now() < end; await sleep(50)) if (await moved()) break;
  };
  // A tab behind another aims the wheel with what it last drew, which may be from before the page moved. There the
  // wheel is only for a page that scrolls on its own terms and ignores being asked.
  if (await behind(tabId)) {
    await ask(tabId, { t: 'scrollby', p, by }, frame);
    if (!(await moved())) await wheel();
  } else {
    await wheel();
    if (!(await moved())) await ask(tabId, { t: 'scrollby', p, by }, frame);
  }
  // It may still be gliding.
  await sleep(150);
  const end = await pos();
  return end.key === start.key ? 'Nothing moved: it is already at that end.' : `Scrolled to ${end.top} of ${end.height} px.`;
}

async function scrollNote(tabId: number, ref: string | undefined, how: How) {
  // No distance: bring the element into view.
  if (!how.by) {
    await ask(tabId, { t: 'aim', ref: ref!, action: 'scroll', spot: how.spot, quick: await behind(tabId) });
    return 'It is on screen now.';
  }
  if (how.at) return realScroll(tabId, how.at, how.by, ref);
  if (!ref) {
    const view = await ask<{ w: number; h: number }>(tabId, { t: 'viewport' });
    return realScroll(tabId, { x: view.w / 2, y: view.h / 2 }, how.by);
  }
  // The wheel only turns something the pointer is over.
  const where = () => ask<Point & { off: boolean }>(tabId, { t: 'where', ref, spot: how.spot });
  if ((await where()).off) await ask(tabId, { t: 'aim', ref, action: 'scroll', spot: how.spot, quick: await behind(tabId) });
  return realScroll(tabId, await where(), how.by, ref);
}

/** Type for real: focus the field, select what is in it, and put the text in as an input method would. */
async function realType(tabId: number, ref: string, text: string): Promise<boolean> {
  // A frame may not take focus from a script, but it takes it from a click, as it does from a person.
  if (frameOf(ref)) await realClick(tabId, ref, {});
  const ok = await ask<boolean>(tabId, { t: 'ready', ref, quick: await behind(tabId) });
  if (!ok) return false;
  await platform.cdp!(tabId, async (send) => {
    if (!text) return void (await pressKey(tabId, send, 'Backspace'));
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (i) await pressKey(tabId, send, 'Enter');
      if (paced() && line.length <= MAX_PACED_TYPING) {
        for (const ch of line) {
          await sendInput(tabId, send, 'Input.insertText', { text: ch });
          await pause(30, 110);
        }
      } else if (line) await sendInput(tabId, send, 'Input.insertText', { text: line });
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

const ON = /^(true|on|checked|yes|1)$/i;
const OFF = /^(false|off|unchecked|no|0)$/i;

/** Bring a field to a state, whatever state it is in now. What is ticked already stays ticked. */
async function setField(tabId: number, ref: string, value: string): Promise<string | undefined> {
  const state = () => ask<FieldState>(tabId, { t: 'fieldstate', ref });
  const now = await state();
  if (now.kind === 'file') throw new Error('That is a file input. Call upload with this ref and the path of the file instead.');
  if (now.kind === 'other') throw new Error('That is not a field. Use click, or read_page to find the field.');
  if (now.kind === 'text') return perform(tabId, ref, 'type', value);
  if (now.kind !== 'toggle') {
    await ask(tabId, { t: 'act', ref, action: 'set', value, quick: await behind(tabId) });
    return undefined;
  }
  if (!ON.test(value) && !OFF.test(value)) throw new Error(`That takes true or false, not \u201c${value}\u201d.`);
  const want = ON.test(value);
  if (now.on === want) return 'It already was.';
  if (!want && now.radio) throw new Error('A radio button goes off when another in its group is chosen. Set that one to true.');
  const note = await perform(tabId, ref, 'click');
  for (const end = Date.now() + LAND_MS; Date.now() < end; await sleep(50)) {
    const s = await state().catch(() => undefined);
    if (!s || (s.kind === 'toggle' && s.on === want)) return note;
  }
  throw new Error(`The click did not turn it ${want ? 'on' : 'off'}. ${note ?? 'The page may refuse it, or draw it from something else.'}`);
}

/**
 * Do something to the page. Real input where the browser has it, and DOM events otherwise or when it did not arrive.
 * What comes back, if anything, is for the agent to hear.
 */
export async function perform(tabId: number, ref: string | undefined, action: string, value?: string, how: How = {}): Promise<string | undefined> {
  if (action === 'scroll') return scrollNote(tabId, ref, how);
  if (action === 'set') return setField(tabId, ref!, value ?? '');
  if (action === 'drag' && frameOf(ref) !== frameOf(how.toRef)) throw new Error('Both ends of a drag have to be in one frame.');
  let note: string | undefined;
  if (platform.cdp) {
    try {
      if (action === 'click' && ref) {
        const r = await realClick(tabId, ref, how);
        if (r.done) return;
        note = r.note;
      } else if (action === 'hover' && ref) {
        if (await realHover(tabId, ref, how)) return;
      } else if (action === 'drag' && ref) {
        if (await realDrag(tabId, ref, how)) return;
      } else if ((action === 'type' || action === 'clear') && ref) {
        if (await realType(tabId, ref, action === 'clear' ? '' : (value ?? ''))) return;
      } else if (action === 'press') {
        if (await realPress(tabId, ref, value ?? 'Enter')) return;
      }
    } catch (e) {
      // A mistake is the agent's to hear. Anything else is the session: the page still takes DOM events.
      if (/is not a (modifier|key)|is gone from the page|was not made|not on screen/.test((e as Error).message)) throw e;
    }
  }
  // The page script knows the other end of a drag by its own ref.
  await ask(tabId, { t: 'act', ref, action, value, how: how.toRef ? { ...how, toRef: how.toRef.replace(/^f\d+:/, '') } : how, quick: await behind(tabId) });
  return note;
}
