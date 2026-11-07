import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket as NetSocket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

// A local DevTools endpoint backed by the extension, for Playwright and anything else that speaks CDP. The browser's own
// debugging port is not open: this is an imitation of one, and all that reaches a page goes through the extension's debugger.
// It starts when an agent first asks for it, and stops when nothing holds a token. A person who never uses it has nothing listening.
//
// The browser-wide part of the protocol is answered here, from a list of the session's tabs. What is said to a page goes to the
// extension, which holds the lines (see lib/page/relay.ts in the extension).

const GRANT_MS = 8 * 60 * 60_000;
// Native messages to the browser are capped at 1 MB, and Playwright's own scripts come near it.
const PART = 600_000;
const ROOT = 'tab-';

type Call = <T = any>(method: string, params: object) => Promise<T>;
interface Target { tabId: number; targetInfo: { targetId: string; type: string; title: string; url: string; attached: boolean; browserContextId: string; canAccessOpener: boolean } }
interface Client { ws: WebSocket; session: string; targets: Map<number, Target>; children: Map<string, number>; announced: Set<number>; autoAttach: boolean; discover: boolean }
interface Grant { session: string; until: number; by?: unknown }

const rootOf = (tabId: number) => `${ROOT}${tabId}`;
const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

class Refused extends Error {}

export function cdpRelay(call: Call, log: (...a: unknown[]) => void) {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let port = 0;
  const grants = new Map<string, Grant>();
  const clients = new Map<string, Client>();
  let nextPart = 1;

  async function start() {
    if (server) return;
    const s = createServer(http);
    wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    s.on('upgrade', (req, socket, head) => {
      const grant = allowed(req);
      if (typeof grant === 'string') return void refuseUpgrade(socket as NetSocket, grant);
      wss!.handleUpgrade(req, socket, head, (ws) => void connected(ws, grant.session));
    });
    // Never any other address, whatever the host itself listens on.
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(Number(process.env.AGENTIC_ROUTINES_CDP_PORT ?? 0), '127.0.0.1', () => resolve());
    });
    port = (s.address() as { port: number }).port;
    server = s;
    log('cdp relay listening on', port);
  }

  function stopIfUnused() {
    if (!server || grants.size || clients.size) return;
    server.close();
    wss?.close();
    server = undefined;
    wss = undefined;
    log('cdp relay stopped');
  }

  const refuseUpgrade = (socket: NetSocket, why: string) => {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`);
  };

  /** Who is asking: a token that is still good, from this machine, and not a web page. A page can reach localhost, and can lie about little else. */
  function allowed(req: IncomingMessage): Grant | string {
    const host = req.headers.host ?? '';
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return 'That Host is not this endpoint.';
    if (req.headers.origin) return 'Web pages may not use this endpoint.';
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'none') return 'Web pages may not use this endpoint.';
    const url = new URL(req.url ?? '/', 'http://x');
    const token = url.searchParams.get('token') ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    for (const [t, g] of grants) {
      if (g.until < Date.now()) {
        grants.delete(t);
        continue;
      }
      if (sameToken(t, token)) return g;
    }
    return 'A token is needed. Ask for one with the cdp_endpoint tool.';
  }

  function http(req: IncomingMessage, res: ServerResponse) {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const grant = allowed(req);
    if (typeof grant === 'string') return send(403, { error: grant });
    if (req.method !== 'GET') return send(405, { error: 'Only GET.' });
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/\/$/, '');
    const token = url.searchParams.get('token') ?? '';
    if (path === '/json/version') {
      return void call<{ product: string; userAgent: string }>('cdp.open', { session: grant.session }).then(
        (o) => send(200, { Browser: o.product, 'Protocol-Version': '1.3', 'User-Agent': o.userAgent, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/relay?token=${token}` }),
        (e) => send(503, { error: (e as Error).message }),
      );
    }
    if (path === '/json' || path === '/json/list') {
      return void call<{ tabs: Target[] }>('cdp.open', { session: grant.session }).then(
        (o) => send(200, o.tabs.map((t) => ({ id: t.targetInfo.targetId, type: 'page', title: t.targetInfo.title, url: t.targetInfo.url }))),
        (e) => send(503, { error: (e as Error).message }),
      );
    }
    send(404, { error: 'Not here.' });
  }

  /** One connection at a time for each session. They would share one debugger, and step on each other. */
  async function connected(ws: WebSocket, session: string) {
    const old = clients.get(session);
    if (old) {
      old.ws.close(4000, 'A newer connection took over this session');
      await closed(old);
    }
    const c: Client = { ws, session, targets: new Map(), children: new Map(), announced: new Set(), autoAttach: false, discover: false };
    clients.set(session, c);
    ws.on('message', (data) => {
      let m: { id: number; method: string; params?: any; sessionId?: string };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      route(c, m).then(
        (result) => reply(c, { id: m.id, sessionId: m.sessionId, result: result ?? {} }),
        (e: Error) => reply(c, { id: m.id, sessionId: m.sessionId, error: { code: -32000, message: e.message } }),
      );
    });
    ws.on('close', () => void closed(c));
    ws.on('error', () => ws.close());
  }

  /** The debugger is let go when the client goes: what it switched on, and its pages waiting for it, go with it. */
  async function closed(c: Client) {
    if (clients.get(c.session) !== c) return;
    clients.delete(c.session);
    await call('cdp.close', { session: c.session }).catch(() => {});
    stopIfUnused();
  }

  const reply = (c: Client, m: object) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m));
  };

  async function refreshTargets(c: Client) {
    const o = await call<{ tabs: Target[] }>('cdp.open', { session: c.session });
    c.targets = new Map(o.tabs.map((t) => [t.tabId, t]));
    return o;
  }

  async function announce(c: Client, t: Target) {
    if (c.announced.has(t.tabId)) return;
    c.announced.add(t.tabId);
    await call('cdp.attach', { session: c.session, tabId: t.tabId });
    if (c.discover) reply(c, { method: 'Target.targetCreated', params: { targetInfo: t.targetInfo } });
    if (c.autoAttach) reply(c, { method: 'Target.attachedToTarget', params: { sessionId: rootOf(t.tabId), targetInfo: t.targetInfo, waitingForDebugger: false } });
  }

  const tabOf = (c: Client, sessionId: string) => {
    if (sessionId.startsWith(ROOT)) {
      const id = Number(sessionId.slice(ROOT.length));
      if (c.targets.has(id)) return { tabId: id };
    }
    const id = c.children.get(sessionId);
    if (id !== undefined) return { tabId: id, child: sessionId };
    throw new Refused(`No session ${sessionId}`);
  };

  /** To the extension, in parts if it is long. */
  async function toTab(c: Client, tabId: number, child: string | undefined, method: string, params: object | undefined) {
    const base = { session: c.session, tabId, child, method };
    const body = JSON.stringify(params ?? {});
    if (body.length < PART) return call('cdp.send', { ...base, params });
    const encoded = Buffer.from(body).toString('base64');
    const parts = nextPart++;
    for (let i = 0; i < encoded.length; i += PART) await call('cdp.part', { parts, data: encoded.slice(i, i + PART) });
    return call('cdp.send', { ...base, parts });
  }

  /** The browser-wide part of the protocol, for a browser that has only this session's tabs in it. */
  async function route(c: Client, m: { method: string; params?: any; sessionId?: string }): Promise<unknown> {
    const { method, params, sessionId } = m;
    switch (method) {
      case 'Browser.getVersion': {
        const o = await call<{ product: string; userAgent: string }>('cdp.open', { session: c.session });
        return { protocolVersion: '1.3', product: o.product, revision: '', userAgent: o.userAgent, jsVersion: '' };
      }
      case 'Browser.setDownloadBehavior':
        // Downloads go where the person's browser sends them. An agent does not get to choose a folder here.
        return {};
      case 'Browser.getWindowForTarget':
        return call('cdp.window', { session: c.session, tabId: sessionId ? tabOf(c, sessionId).tabId : undefined });
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      case 'Target.createBrowserContext':
        throw new Refused('This is the person\'s own browser, and it has one context. Use browser.contexts()[0].');
      case 'Target.setDiscoverTargets':
        c.discover = !!params?.discover;
        if (c.discover) for (const t of (await refreshTargets(c)).tabs) reply(c, { method: 'Target.targetCreated', params: { targetInfo: t.targetInfo } });
        return {};
      case 'Target.getTargets':
        return { targetInfos: (await refreshTargets(c)).tabs.map((t) => t.targetInfo) };
      case 'Target.getTargetInfo': {
        if (sessionId) break;
        await refreshTargets(c);
        const t = [...c.targets.values()].find((x) => x.targetInfo.targetId === params?.targetId);
        if (!t) throw new Refused(`No target ${params?.targetId}`);
        return { targetInfo: t.targetInfo };
      }
      case 'Target.setAutoAttach':
        if (sessionId) break;
        c.autoAttach = !!params?.autoAttach;
        if (c.autoAttach) for (const t of (await refreshTargets(c)).tabs) await announce(c, t);
        return {};
      case 'Target.createTarget': {
        const { tabId } = await call<{ tabId: number }>('cdp.newTab', { session: c.session, url: String(params?.url ?? 'about:blank') });
        await refreshTargets(c);
        const t = c.targets.get(tabId);
        if (!t) throw new Refused('The new tab went away.');
        await announce(c, t);
        return { targetId: t.targetInfo.targetId };
      }
      case 'Target.closeTarget': {
        const t = [...c.targets.values()].find((x) => x.targetInfo.targetId === params?.targetId);
        if (!t) throw new Refused(`No target ${params?.targetId}`);
        await call('cdp.closeTab', { session: c.session, tabId: t.tabId });
        return { success: true };
      }
      case 'Target.detachFromTarget':
        if (params?.sessionId && !String(params.sessionId).startsWith(ROOT) && sessionId) break;
        return {};
      case 'Storage.getCookies':
      case 'Network.getAllCookies':
        return call('cdp.cookies', { session: c.session });
      case 'Storage.setCookies':
        return call('cdp.setCookies', { session: c.session, cookies: params?.cookies ?? [] });
    }
    if (method.startsWith('Browser.') || method === 'Target.attachToBrowserTarget' || method === 'Target.attachToTarget' || method === 'Target.sendMessageToTarget' || method === 'Target.activateTarget') {
      throw new Refused(`${method} is not available here.${method === 'Target.attachToTarget' ? ' A separate CDP session on a page is not supported.' : ''}`);
    }
    // Anything else names a page. With no page, there is no browser behind this to ask.
    if (!sessionId) throw new Refused(`${method} needs a page.`);
    const { tabId, child } = tabOf(c, sessionId);
    return toTab(c, tabId, child, method, params);
  }

  return {
    /** A token for this session, and the address to use it on. `by` is the connection that asked: the token goes when it does. */
    async grant(session: string, by?: unknown) {
      await start();
      await call('cdp.open', { session });
      let token = [...grants].find(([, g]) => g.session === session && g.by === by)?.[0];
      if (!token) {
        token = randomBytes(24).toString('base64url');
        grants.set(token, { session, until: Date.now() + GRANT_MS, by });
      }
      return { endpoint: `http://127.0.0.1:${port}/?token=${token}`, port };
    },
    /** That connection is gone, with whatever it was given. A client already connected on such a token goes too. */
    dropped(by: unknown) {
      for (const [t, g] of grants) {
        if (g.by !== by) continue;
        grants.delete(t);
        if (![...grants.values()].some((x) => x.session === g.session)) clients.get(g.session)?.ws.close(4001, 'The agent that asked for this endpoint has gone');
      }
      stopIfUnused();
    },
    /** What the extension says a page said. */
    event(name: string, d: any) {
      if (name === 'cdp.tab') {
        const c = clients.get(d.session);
        if (c) void refreshTargets(c).then(() => {
          const t = c.targets.get(d.tabId);
          if (t) return announce(c, t);
        }).catch((e) => log('cdp announce', e.message));
        return;
      }
      for (const c of clients.values()) {
        if (!c.targets.has(d.tabId)) continue;
        if (name === 'cdp.gone') {
          const t = c.targets.get(d.tabId)!;
          for (const [s, id] of c.children) if (id === d.tabId) c.children.delete(s);
          c.targets.delete(d.tabId);
          c.announced.delete(d.tabId);
          reply(c, { method: 'Target.detachedFromTarget', params: { sessionId: rootOf(d.tabId), targetId: t.targetInfo.targetId } });
          if (c.discover) reply(c, { method: 'Target.targetDestroyed', params: { targetId: t.targetInfo.targetId } });
          continue;
        }
        if (d.method === 'Target.attachedToTarget') c.children.set(d.params.sessionId, d.tabId);
        if (d.method === 'Target.detachedFromTarget') c.children.delete(d.params.sessionId);
        reply(c, { method: d.method, params: d.params, sessionId: d.child ?? rootOf(d.tabId) });
      }
    },
  };
}
