// The tab title says who has the tab: "🟣 Claude Code · Page title". The page, the background and code run with execute need to take it off again.

export const MARK = '🟣 ';

/** The title without the mark. A page's own text is never touched. */
export function unmark(title: string): string {
  if (!title.startsWith(MARK)) return title;
  const at = title.indexOf(' · ');
  return at === -1 ? '' : title.slice(at + 3);
}

export const marked = (label: string, title: string) => `${MARK}${label} · ${unmark(title)}`;
