import type { Platform } from './types';

// Firefox has a sidebar in place of the side panel, and no DevTools protocol for extensions.

export const gecko: Platform = {
  name: 'Firefox',
  onToolbar(first) {
    browser.action.onClicked.addListener((tab) => {
      if (first(tab)) (browser as any).sidebarAction.toggle();
    });
  },
};
