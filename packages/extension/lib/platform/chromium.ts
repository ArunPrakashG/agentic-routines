import type { Platform, Send } from './types';

// Chrome, Edge, Brave, Vivaldi, Opera and the rest of the Chromium family.

function name() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if ((navigator as any).brave) return 'Brave';
  return 'Chrome';
}

export const chromium: Platform = {
  name: name(),
  async cdp(tabId, fn) {
    const target = { tabId };
    await browser.debugger.attach(target, '1.3');
    try {
      const send: Send = (method, params) => browser.debugger.sendCommand(target, method, params) as Promise<any>;
      return await fn(send);
    } finally {
      await browser.debugger.detach(target).catch(() => {});
    }
  },
  openPanelOnClick() {
    (browser as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  },
};
