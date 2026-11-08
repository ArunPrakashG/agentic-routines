// The extension's half of the link to an agent on another computer: proving who is who, with what is in any browser.
// The other half, and why it works this way, is packages/cli/src/host/remote.ts. Nothing here touches extension APIs.

const SCHEME = 'agentic-routines-link-v1';
const ITERATIONS = 100_000;
const WAIT_MS = 15_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const DEFAULT_PORT = 47931;

export interface LinkKey {
  address: string;
  id: string;
  key: string;
  computer: string;
}

const text = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer), (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const nonce = () => hex(crypto.getRandomValues(new Uint8Array(32)));

async function hmac(key: Uint8Array, ...parts: (string | Uint8Array)[]): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [text.encode(SCHEME)];
  for (const p of parts) pieces.push(text.encode('|'), typeof p === 'string' ? text.encode(p) : p);
  const all = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    all.set(p, at);
    at += p.length;
  }
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, all));
}

async function codeKey(code: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', text.encode(code), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: text.encode(`${SCHEME}|code`), iterations: ITERATIONS }, k, 256));
}

const same = (a: Uint8Array, h: unknown) => typeof h === 'string' && hex(a) === h;

/** What a person typed, as an address to connect to: `host`, `host:port` or a whole ws:// address. */
export function linkUrl(typed: string): string {
  let s = typed.trim();
  if (!s) throw new Error('Enter the address your agent gave you.');
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`;
  const u = new URL(s);
  if (!u.port && u.protocol === 'ws:') u.port = String(DEFAULT_PORT);
  return u.toString();
}

export function normalCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return new RegExp(`^[${CROCKFORD}]{8}$`).test(code) ? code : undefined;
}

/** Anyone on the way can read a plain link. On these addresses that is a network the person chose. */
export function onPrivateNetwork(typed: string): boolean {
  const u = new URL(linkUrl(typed));
  if (u.protocol === 'wss:') return true;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.ts.net') || host.endsWith('.local') || /^f[cd]/.test(host) || /^fe80:/.test(host)) return true;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/** Opens a socket and takes a handshake's messages in turn. What arrives after the handshake is the caller's. */
function converse(url: string, opening: () => Promise<unknown> | unknown, step: (m: any, say: (m: unknown) => void, finish: (v: unknown) => void, fail: (e: Error) => void) => Promise<void> | void): Promise<{ ws: WebSocket; value: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error(`Nothing answered at ${url}.`)), WAIT_MS);
    const say = (m: unknown) => ws.send(JSON.stringify(m));
    // In order, as the steps do slow things between messages.
    let chain: Promise<unknown> = Promise.resolve();
    const heard = (e: MessageEvent) => {
      chain = chain.then(async () => {
        if (done) return;
        await step(
          JSON.parse(String(e.data)),
          say,
          (value) => {
            done = true;
            clearTimeout(timer);
            ws.removeEventListener('message', heard);
            resolve({ ws, value });
          },
          fail,
        );
      }).catch((err) => fail(err as Error));
    };
    ws.addEventListener('message', heard);
    ws.addEventListener('open', () => void Promise.resolve(opening()).then(say, fail));
    ws.addEventListener('error', () => fail(new Error(`Nothing answered at ${url}.`)));
    // In turn too: the last message is still being worked on when the other side has already closed.
    ws.addEventListener('close', () => void chain.then(() => fail(new Error('Turned down. The code may be wrong, used or too old, so ask your agent for a new one.'))));
  });
}

/** Spends the code, and gets a key for this browser. */
export async function pairLink(typed: string, typedCode: string, name: string): Promise<LinkKey> {
  const code = normalCode(typedCode);
  if (!code) throw new Error('A pairing code has 8 characters, like ABCD-1234.');
  const url = linkUrl(typed);
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
  const pc = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
  const nc = nonce();
  let session: Uint8Array | undefined;
  const { ws, value } = await converse(
    url,
    () => ({ t: 'pair', nonce: nc, ecdh: pc, name }),
    async (m, say, finish, fail) => {
      if (m.t === 'challenge' && !session) {
        const theirs = await crypto.subtle.importKey('raw', bytes(String(m.ecdh)) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256));
        session = await hmac(await codeKey(code), secret, nc, String(m.nonce), pc, String(m.ecdh));
        say({ t: 'proof', proof: hex(await hmac(session, 'browser')) });
      } else if (m.t === 'key' && session) {
        if (!same(await hmac(session, 'listener'), m.proof)) return fail(new Error('What answered does not know the code, so it is not your agent.'));
        const wrap = await hmac(session, 'wrap');
        const key = bytes(String(m.wrapped)).map((b, i) => b ^ wrap[i]);
        finish({ id: String(m.id), key: hex(key), computer: String(m.computer ?? 'computer').slice(0, 80) });
      } else fail(new Error('That is not Agentic Routines.'));
    },
  );
  ws.close();
  return { address: url, ...value };
}

/** A connection where both sides have proved they hold the key, ready for the usual messages. */
export async function openLink(k: Pick<LinkKey, 'address' | 'id' | 'key'>): Promise<{ ws: WebSocket; computer: string }> {
  const key = bytes(k.key);
  const nc = nonce();
  let nh = '';
  const { ws, value } = await converse(
    k.address,
    () => ({ t: 'hello', id: k.id, nonce: nc }),
    async (m, say, finish, fail) => {
      if (m.t === 'challenge' && !nh) {
        nh = String(m.nonce);
        // That side goes first: nothing is said to what cannot prove it holds the key.
        if (!same(await hmac(key, 'listener', nc, nh), m.proof)) return fail(new Error('What answered does not hold the key, so it is not the computer you paired with.'));
        say({ t: 'proof', proof: hex(await hmac(key, 'browser', nc, nh)) });
      } else if (m.t === 'ok' && nh) finish(String(m.computer ?? 'computer').slice(0, 80));
      else fail(new Error('That is not Agentic Routines.'));
    },
  );
  return { ws, computer: value };
}
