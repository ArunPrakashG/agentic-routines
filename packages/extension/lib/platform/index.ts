import { chromium } from './chromium';
import { gecko } from './gecko';
import type { Platform } from './types';

export type { Platform, Send } from './types';

// Picked by what the browser can do, not by its name, so a Chromium fork needs nothing here.
export const platform: Platform = (browser as any).sidebarAction && !(browser as any).sidePanel ? gecko : chromium;
