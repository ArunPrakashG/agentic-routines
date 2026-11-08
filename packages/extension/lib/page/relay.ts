import * as native from '../agent/native';
import { platform } from '../platform';
import { handedOver } from './handoff';
import { glideTo, paced } from './paced';
import { listed, notListed, policyOf } from './policy';
import { refuseScript, scrub } from './secrets';
import { agentTabId, closeOwnTab, glow, heldBy, isOwnTab, openTab, sessionTabs } from './tabs';

// What a CDP client such as Playwright may do. The endpoint itself is in the host (host/cdp.ts); this is where its lines are
// held, since this is what holds the debugger. Pure page work goes through unchanged, and a refusal comes back as a normal
// CDP error for that one command, so the script fails loudly and the connection stays.

// One session may have the tabs, one tab has one session.
const relayed = new Map<number, string>();
const parts = new Map<number, string>();
let lastGlow = 0;
let keeping: ReturnType<typeof setInterval> | undefined;

const REFUSED: Record<string, string> = {
  'Network.clearBrowserCookies': 'it would sign the person out of every site',
  'Network.clearBrowserCache': "it would clear the person's whole cache",
  'Network.deleteCookies': 'it would delete cookies the person relies on',
  'Storage.clearCookies': 'it would sign the person out of every site',
  'Storage.clearDataForOrigin': "it would erase a site's data in the person's browser",
  'Storage.clearDataForStorageKey': "it would erase a site's data in the person's browser",
  'Page.bringToFront': "it would take the person's window from them",
  'Page.crash': 'it would break the page',
  'Page.setDownloadBehavior': 'an agent does not get to choose where downloads go',
  'Tethering.bind': 'it would open a port',
};
// What these name is any site, not only the session's. An origin or storage key has to be on one of its pages.
const STORAGE = ['IndexedDB.', 'CacheStorage.', 'DOMStorage.', 'Storage.', 'ServiceWorker.'];
const STORAGE_FREE = /\.(enable|disable)$|^Storage\.getStorageKey/;
// What a script or a look at the page could read a typed secret with. Moving away, and being told about it, stay allowed.
const SEES_PAGE = /^(Runtime\.(evaluate|callFunctionOn|getProperties|compileScript|runScript)|DOM\.|DOMSnapshot\.|Accessibility\.|Page\.(captureScreenshot|captureSnapshot|printToPDF|startScreencast|addScriptToEvaluateOnNewDocument|createIsolatedWorld)|Debugger\.|Overlay\.)/;
const SCHEMES = /^(https?:|about:blank$)/;

const hostOf = (url?: string) => {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
};

async function pages(session: string) {
  return (await sessionTabs(session)).filter((t) => /^https?:/.test(t.url ?? ''));
}

const covers = (host: string, domain: string) => {
  const d = domain.replace(/^\./, '').toLowerCase();
  return !!host && (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`));
};

/** Why this may not go through, if so. */
async function refusal(session: string, tabId: number, method: string, params: any): Promise<string | undefined> {
  const flat = REFUSED[method];
  if (flat) return `${method} is refused: ${flat}.`;
  if (method === 'Page.navigate') {
    const url = String(params?.url ?? '');
    if (!SCHEMES.test(url)) return `${url} is not an address for a page here.`;
    const hosts = policyOf(session)?.hosts;
    if (hosts && !listed(hosts, url)) return notListed(url, hosts);
  }
  // The host checks a path the same way for this as for the upload tool. One it will not hand over does not get to the page.
  if (method === 'DOM.setFileInputFiles') {
    if (native.linked({ session })) return 'The browser is on another computer, so it cannot read a path on this one. Use the upload tool, which sends the file over.';
    const refused = await native.call('host.allowFiles', { paths: params?.files ?? [] }).then(() => undefined, (e: Error) => e.message);
    if (refused) return refused;
  }
  if (method === 'Page.close' && !isOwnTab(session, tabId)) return 'This tab is the person\'s, so it stays open.';
  if (method === 'Network.getCookies') {
    const hosts = (await pages(session)).map((t) => hostOf(t.url));
    const stray = (params?.urls ?? []).find((u: string) => !hosts.some((h) => h === hostOf(u) || hostOf(u).endsWith(`.${h}`)));
    if (stray) return `Cookies for ${stray} are outside this session's pages.`;
  }
  if (method === 'Network.setCookie' || method === 'Network.setCookies') {
    const hosts = (await pages(session)).map((t) => hostOf(t.url));
    for (const c of params?.cookies ?? [params]) {
      const host = c?.domain ?? hostOf(c?.url);
      if (!hosts.some((h) => covers(h, host))) return `A cookie for ${host} is outside this session's pages.`;
    }
  }
  if (STORAGE.some((d) => method.startsWith(d)) && !STORAGE_FREE.test(method)) {
    const named = params?.securityOrigin ?? params?.origin ?? params?.storageKey ?? params?.storageId?.securityOrigin ?? params?.storageId?.storageKey;
    const hosts = (await pages(session)).map((t) => hostOf(t.url));
    if (!named || !hosts.includes(hostOf(String(named).split('^')[0]))) return `${method} reaches outside this session's pages.`;
  }
  return undefined;
}

/** Whichever tab of the session is on a page. Its debugger can read cookies for any address it is given. */
async function anyPage(session: string) {
  const list = await pages(session);
  const tab = list[0];
  if (!tab?.id) return undefined;
  return { tabId: tab.id, urls: list.map((t) => t.url!) };
}

/** Patchright's defaults for how a page looks. They would hide the person's own settings from the page. */
const MEDIA_DEFAULTS: Record<string, string> = { 'prefers-color-scheme': 'light', 'prefers-reduced-motion': 'no-preference', 'forced-colors': 'none', 'prefers-contrast': 'no-preference' };

function keepAttached() {
  if (keeping || !relayed.size) return;
  // A client that sits still keeps its debugger, and all it has set up on it.
  keeping = setInterval(() => {
    if (!relayed.size) {
      clearInterval(keeping);
      keeping = undefined;
      return;
    }
    for (const tabId of relayed.keys()) void platform.cdp?.(tabId, async () => {}).catch(() => {});
  }, 30_000);
}

function own(session: string, tabId: number) {
  const h = heldBy(tabId);
  if (relayed.get(tabId) !== session || (h && h.session !== session)) throw new Error(`Tab ${tabId} is not part of this session.`);
  if (handedOver(tabId)) throw new Error(`Tab ${tabId} is with the person: a hand-over is waiting for them.`);
}

export async function handleRelay(method: string, p: any): Promise<unknown> {
  const session = String(p?.session ?? 'user');
  switch (method) {
    case 'cdp.open': {
      if (!platform.cdp || !platform.targetOf) throw new Error('This needs a Chromium browser.');
      // CDP has no way to look without being able to touch. A script that reads can also click.
      if (policyOf(session)?.readOnly) throw new Error('This session is read-only, and a CDP client could change any page, so it gets no endpoint.');
      let tabs = await sessionTabs(session);
      if (!tabs.length) {
        await agentTabId(session);
        tabs = await sessionTabs(session);
      }
      const described = await Promise.all(
        tabs.map(async (t) => ({
          tabId: t.id!,
          targetInfo: { targetId: await platform.targetOf!(t.id!), type: 'page', title: (await browser.tabs.get(t.id!)).title ?? '', url: t.url ?? '', attached: true, browserContextId: 'default', canAccessOpener: false },
        })),
      );
      return { tabs: described, userAgent: navigator.userAgent, product: /Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? 'Chrome/0' };
    }
    case 'cdp.attach': {
      if (!(await sessionTabs(session)).some((t) => t.id === p.tabId)) throw new Error(`Tab ${p.tabId} is not part of this session.`);
      await platform.cdp!(p.tabId, async () => {});
      relayed.set(p.tabId, session);
      keepAttached();
      return true;
    }
    case 'cdp.part': {
      parts.set(p.parts, (parts.get(p.parts) ?? '') + p.data);
      return true;
    }
    case 'cdp.send': {
      const tabId = Number(p.tabId);
      let params = p.params;
      if (p.parts) {
        const encoded = parts.get(p.parts) ?? '';
        parts.delete(p.parts);
        params = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))));
      }
      own(session, tabId);
      const no = await refusal(session, tabId, p.method, params);
      if (no) throw new Error(no);
      if (SEES_PAGE.test(p.method)) refuseScript(tabId);
      if (p.method === 'Emulation.setEmulatedMedia' && Array.isArray(params?.features)) params = { ...params, features: params.features.filter((f: any) => MEDIA_DEFAULTS[f?.name] !== f?.value) };
      if (Date.now() - lastGlow > 3000) {
        lastGlow = Date.now();
        void glow(tabId, 'run', 8000);
      }
      if (p.method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved' && !p.child && paced()) await platform.cdp!(tabId, (send) => glideTo(tabId, send, params.x, params.y, params.modifiers)).catch(() => {});
      return scrub(await platform.sendTo!(tabId, p.child, p.method, params));
    }
    case 'cdp.window': {
      const tabs = await sessionTabs(session);
      const tab = await browser.tabs.get(p.tabId ?? tabs[0]?.id).catch(() => undefined);
      const w = tab ? await browser.windows.get(tab.windowId) : undefined;
      return { windowId: w?.id ?? 0, bounds: { left: w?.left ?? 0, top: w?.top ?? 0, width: w?.width ?? 1280, height: w?.height ?? 720, windowState: w?.state ?? 'normal' } };
    }
    case 'cdp.newTab': {
      const url = String(p.url);
      if (!SCHEMES.test(url)) throw new Error(`${url} is not an address for a page here.`);
      return { tabId: await openTab(session, url) };
    }
    case 'cdp.closeTab':
      if (!isOwnTab(session, p.tabId)) throw new Error("This tab is the person's, so it stays open.");
      relayed.delete(p.tabId);
      await closeOwnTab(session, p.tabId);
      return true;
    case 'cdp.cookies': {
      const on = await anyPage(session);
      if (!on) return { cookies: [] };
      refuseScript(on.tabId);
      return scrub(await platform.sendTo!(on.tabId, undefined, 'Network.getCookies', { urls: on.urls }));
    }
    case 'cdp.setCookies': {
      const on = await anyPage(session);
      const no = await refusal(session, on?.tabId ?? 0, 'Network.setCookies', { cookies: p.cookies });
      if (no || !on) throw new Error(no ?? 'This session has no page to set a cookie on.');
      return platform.sendTo!(on.tabId, undefined, 'Network.setCookies', { cookies: p.cookies });
    }
    case 'cdp.close': {
      for (const [tabId, s] of relayed) {
        if (s !== session) continue;
        relayed.delete(tabId);
        void platform.release?.(tabId);
      }
      return true;
    }
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

export function watchRelay() {
  platform.onEvent?.((tabId, method, params, child) => {
    if (!relayed.has(tabId)) return;
    if (method === 'detached') {
      const session = relayed.get(tabId);
      relayed.delete(tabId);
      native.emit('cdp.gone', { tabId }, { session });
      return;
    }
    native.emit('cdp.event', { tabId, child, method, params: scrub(params) }, { session: relayed.get(tabId) });
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    const session = relayed.get(tabId);
    if (relayed.delete(tabId)) native.emit('cdp.gone', { tabId }, { session });
  });
  // A tab the session has just got: a popup its page opened, or one a tool opened for it.
  browser.tabs.onCreated.addListener((t) => {
    if (t.id === undefined || !relayed.size) return;
    setTimeout(() => {
      for (const session of new Set(relayed.values())) if (isOwnTab(session, t.id!)) native.emit('cdp.tab', { session, tabId: t.id }, { session });
    }, 100);
  });
}
