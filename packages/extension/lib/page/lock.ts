import { marked, MARK, unmark } from './mark';

// The page side of a tab lock: the title carries the mark while an agent holds the tab. A page that sets its
// own title (a single page app on every route) gets the mark put back, and the mark ends by itself after ttl.

let label: string | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let watch: MutationObserver | undefined;
// A page that puts its own title back every time we change it would trade blows with us for ever, so after a few
// rounds in a moment the mark is dropped for this page and the tab group says who has the tab.
const MAX_FIGHT = 8;
const FIGHT_MS = 2000;
const rounds: number[] = [];
let yielded = false;

const live = () => {
  try {
    return !!browser.runtime?.id;
  } catch {
    // After the extension reloads, this copy of the script has no extension behind it.
    return false;
  }
};

function apply() {
  if (!label) return;
  if (!live()) return void lock(null);
  const want = marked(label, document.title);
  if (document.title === want) return;
  const now = Date.now();
  while (rounds.length && now - rounds[0] > FIGHT_MS) rounds.shift();
  if (rounds.push(now) > MAX_FIGHT) return void give();
  document.title = want;
}

function give() {
  yielded = true;
  watch?.disconnect();
  watch = undefined;
  label = undefined;
  clearTimeout(expiry);
  if (document.title.startsWith(MARK)) document.title = unmark(document.title);
}

export function lock(next: string | null, ttl = 15 * 60_000) {
  if (window !== window.top) return;
  if (yielded && next !== null) return;
  clearTimeout(expiry);
  if (next === null) {
    label = undefined;
    watch?.disconnect();
    watch = undefined;
    if (document.title.startsWith(MARK)) document.title = unmark(document.title);
    return;
  }
  label = next;
  apply();
  if (!watch && document.head) {
    watch = new MutationObserver(apply);
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  expiry = setTimeout(() => lock(null), ttl);
}

/** A mark left behind by a copy of this script that the extension reload orphaned. */
export function clearStale() {
  if (window === window.top && document.title.startsWith(MARK)) document.title = unmark(document.title);
}
