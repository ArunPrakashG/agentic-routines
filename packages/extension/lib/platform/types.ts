// What the extension needs from a browser that the WebExtension API does not give every browser.
// A new browser is one file in this folder plus a line in `index.ts`.

export type Send = <T = unknown>(method: string, params?: object) => Promise<T>;

export interface Platform {
  /** Shown to the host and agents, so "Chrome" or "Firefox" in what they report. */
  name: string;
  /** A DevTools protocol session on a tab, in browsers that have one. It outlasts `fn`, and goes by itself when the tab has been idle a while. */
  cdp?: <T>(tabId: number, fn: (send: Send) => Promise<T>) => Promise<T>;
  /** One command to a tab, or to a frame or worker inside it by its session. */
  sendTo?: (tabId: number, child: string | undefined, method: string, params?: object) => Promise<unknown>;
  /** The DevTools id of the tab. */
  targetOf?: (tabId: number) => Promise<string>;
  /** Let go of a tab's DevTools session now, when nothing is driving it any more. */
  release?: (tabId: number) => Promise<void>;
  /** What a tab's DevTools session says, from then on. Also `detached`, when that session ends. */
  onEvent?: (fn: (tabId: number, method: string, params: any, child?: string) => void) => void;
  /** The toolbar button: `first` says what the click was for, and with true the panel opens as well. */
  onToolbar(first: (tab: Browser.tabs.Tab) => boolean): void;
}
