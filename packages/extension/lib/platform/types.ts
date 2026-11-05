// What the extension needs from a browser that the WebExtension API does not give every browser.
// A new browser is one file in this folder plus a line in `index.ts`.

export type Send = <T = unknown>(method: string, params?: object) => Promise<T>;

export interface Platform {
  /** Shown to the host and agents, so "Chrome" or "Firefox" in what they report. */
  name: string;
  /** A DevTools protocol session on a tab, in browsers that have one. Attached for the length of `fn`. */
  cdp?: <T>(tabId: number, fn: (send: Send) => Promise<T>) => Promise<T>;
  /** Make the toolbar button open the panel. */
  openPanelOnClick(): void;
}
