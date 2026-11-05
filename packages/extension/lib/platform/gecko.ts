import type { Platform } from './types';

// Firefox has a sidebar in place of the side panel, and no DevTools protocol for extensions.

export const gecko: Platform = {
  name: 'Firefox',
  openPanelOnClick() {
    browser.action.onClicked.addListener(() => (browser as any).sidebarAction.toggle());
  },
};
