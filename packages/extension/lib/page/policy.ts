// What a named session may do: the sites it may be on and whether it may touch anything. Kept here, not in the agent's
// tools, so that a page that talks an agent round still meets the same limit.

export interface Policy {
  name?: string;
  /** Hosts this session may be on. A name also covers its subdomains. None: any site. */
  hosts?: string[];
  /** A listed name may resolve to a private address, for a site on the person's own network. */
  allowPrivate?: boolean;
  readOnly?: boolean;
}

const policies = new Map<string, Policy>();
const keep = () => browser.storage.local.set({ sessionPolicies: Object.fromEntries(policies) }).catch(() => {});

export const policyOf = (session?: string) => (session ? policies.get(session) : undefined);

export function setPolicy(session: string, p: Policy | undefined) {
  if (p) policies.set(session, p);
  else policies.delete(session);
  void keep();
}

/** May a session with this list be at this address. Blank pages may always be. */
export function listed(hosts: string[] | undefined, url: string | undefined): boolean {
  if (!hosts) return true;
  if (!url || url === 'about:blank') return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^\[?::1\]?$/, /^f[cd]/i, /^fe[89ab]/i, /^::ffff:(127|10|192\.168|169\.254)\./i];
const isPrivate = (ip: string) => PRIVATE.some((r) => r.test(ip));
const IP_NAME = /^(\d+\.){3}\d+$|^\[/;

// Tabs held to a list, each with a block rule of its own. The rule stops a navigation or a redirect before it leaves the
// browser; what gets past it, such as a tab that started loading before the rule was in, is caught here and sent away.
const guards = new Map<number, Policy>();
const refused = new Map<number, string>();
const keepGuards = () => browser.storage.session?.set({ guards: [...guards] }).catch(() => {});

interface Rules {
  updateSessionRules(o: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>;
}
const rules = () => (browser as unknown as { declarativeNetRequest?: Rules }).declarativeNetRequest;

export async function guardTab(tabId: number, p: Policy | undefined) {
  if (!p?.hosts) return unguardTab(tabId);
  guards.set(tabId, p);
  void keepGuards();
  listen();
  await rules()
    ?.updateSessionRules({
      removeRuleIds: [tabId],
      addRules: [{ id: tabId, priority: 1, action: { type: 'block' }, condition: { tabIds: [tabId], resourceTypes: ['main_frame'], ...(p.hosts.length ? { excludedRequestDomains: p.hosts } : {}) } }],
    })
    .catch(() => {});
}

export async function unguardTab(tabId: number) {
  if (!guards.delete(tabId)) return;
  refused.delete(tabId);
  void keepGuards();
  listen();
  await rules()?.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
}

/** Why the last address this tab tried was refused, once. */
export function takeRefused(tabId: number) {
  const why = refused.get(tabId);
  refused.delete(tabId);
  return why;
}

export const notListed = (url: string, hosts: string[]) => `${url} is outside this session's sites (${hosts.join(', ') || 'none'}).`;

function sendAway(tabId: number, why: string) {
  refused.set(tabId, why);
  void browser.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
}

// The browser says which address it really connected to. A listed name that turns out to live on a private address
// is the mark of a rebinding attack, so the page is left. The request has been sent by then: it is caught, not prevented.
const onResponse = (d: { tabId: number; url: string; ip?: string; type: string }) => {
  const g = guards.get(d.tabId);
  if (!g?.hosts || g.allowPrivate || !d.ip || !isPrivate(d.ip)) return;
  const host = new URL(d.url).hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || IP_NAME.test(host)) return;
  sendAway(d.tabId, `${host} answered from a private address (${d.ip}), so this session left the page. If the site really is on your own network, the person can allow that for this session.`);
};

// Added only while a tab is guarded, so a person who never limits a session pays nothing for it.
let listening = false;
function listen() {
  const w = (browser as unknown as { webRequest?: { onResponseStarted: { addListener(fn: unknown, f: object): void; removeListener(fn: unknown): void } } }).webRequest;
  if (!w) return;
  if (guards.size && !listening) {
    w.onResponseStarted.addListener(onResponse, { urls: ['<all_urls>'] });
    listening = true;
  } else if (!guards.size && listening) {
    w.onResponseStarted.removeListener(onResponse);
    listening = false;
  }
}

export function watchPolicies() {
  void browser.storage.local.get('sessionPolicies').then((s) => {
    for (const [k, v] of Object.entries((s.sessionPolicies as Record<string, Policy> | undefined) ?? {})) if (!policies.has(k)) policies.set(k, v);
  });
  void browser.storage.session?.get('guards').then((s) => {
    for (const [id, p] of (s.guards as [number, Policy][] | undefined) ?? []) guards.set(id, p);
    listen();
  });
  browser.webNavigation.onBeforeNavigate.addListener((d) => {
    if (d.frameId !== 0) return;
    const g = guards.get(d.tabId);
    if (g?.hosts && !listed(g.hosts, d.url)) sendAway(d.tabId, notListed(d.url, g.hosts));
  });
  browser.tabs.onRemoved.addListener((tabId) => void unguardTab(tabId));
}
