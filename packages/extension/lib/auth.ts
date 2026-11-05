// Google sign-in with PKCE. The API holds the client secret and issues our own session,
// which only lives here: the panel gets the account, never the tokens.

// Dev scripts build with WXT_API_URL pointing at a local API, so tests never reach the real one.
const API = import.meta.env.WXT_API_URL || 'https://browserroutines.arunprakashg.com';
const CLIENT_ID = '883265328584-285ao8n0u1nkv8b9ftr2q2bov23lieeo.apps.googleusercontent.com';

export interface Account {
  email: string;
  name: string;
  picture?: string | null;
  handle?: string | null;
  /** Set by the API for the few accounts that review submissions. */
  admin?: boolean;
}
interface Session {
  account: Account;
  access: string;
  accessExp: number;
  refresh: string;
}
interface Tokens {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function installId(): Promise<string> {
  const { installId: id } = (await browser.storage.local.get('installId')) as { installId?: string };
  if (id) return id;
  const fresh = crypto.randomUUID();
  await browser.storage.local.set({ installId: fresh });
  return fresh;
}

async function load(): Promise<Session | undefined> {
  return ((await browser.storage.local.get('session')) as { session?: Session }).session;
}

const post = (path: string, body: unknown) =>
  fetch(`${API}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function stored(account: Account, t: Tokens): Session {
  return { account, access: t.access_token, accessExp: Date.now() + t.expires_in * 1000, refresh: t.refresh_token };
}

export async function account(): Promise<Account | undefined> {
  return (await load())?.account;
}

export async function signIn(): Promise<void> {
  const verifier = random();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(16);
  const nonce = random(16);
  const redirect = browser.identity.getRedirectURL();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    prompt: 'select_account',
  }).toString();

  const back = await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const q = new URL(back!).searchParams;
  const code = q.get('code');
  if (q.get('state') !== state || !code) throw new Error('Google did not sign you in.');

  const res = await post('/auth/google', { code, code_verifier: verifier, redirect_uri: redirect, nonce, install_id: await installId() });
  if (!res.ok) throw new Error('Could not finish signing in.');
  const t = (await res.json()) as Tokens & { user: Account };
  await browser.storage.local.set({ session: stored(t.user, t) });
}

export async function signOut(): Promise<void> {
  const s = await load();
  await browser.storage.local.remove('session');
  if (s) await post('/auth/signout', { refresh_token: s.refresh }).catch(() => {});
}

let refreshing: Promise<string | undefined> | undefined;

async function refresh(s: Session): Promise<string | undefined> {
  const res = await post('/auth/refresh', { refresh_token: s.refresh, install_id: await installId() });
  if (res.status === 401) {
    await browser.storage.local.remove('session');
    return undefined;
  }
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
  const next = stored(s.account, (await res.json()) as Tokens);
  await browser.storage.local.set({ session: next });
  return next.access;
}

/** A current access token, or undefined when signed out. Throws when the API can't be reached. */
export async function accessToken(): Promise<string | undefined> {
  const s = await load();
  if (!s) return undefined;
  if (s.accessExp > Date.now() + 30_000) return s.access;
  // A refresh token works once, so everyone waits for the same refresh.
  refreshing ??= refresh(s).finally(() => (refreshing = undefined));
  return refreshing;
}

/** A call to the API as the signed-in person. Throws when signed out. */
export async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const token = await accessToken();
  if (!token) throw new Error('Sign in first.');
  return fetch(`${API}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-install-id': await installId(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function setHandle(handle: string): Promise<void> {
  const s = await load();
  if (s) await browser.storage.local.set({ session: { ...s, account: { ...s.account, handle } } });
}

/** Picks up a session that ended elsewhere. Being offline leaves it signed in. */
export async function check(): Promise<void> {
  try {
    const token = await accessToken();
    if (!token) return;
    const res = await fetch(`${API}/api/v1/me`, { headers: { authorization: `Bearer ${token}`, 'x-install-id': await installId() } });
    if (res.status === 401) return void (await browser.storage.local.remove('session'));
    if (!res.ok) return;
    const s = await load();
    if (s) await browser.storage.local.set({ session: { ...s, account: await res.json() } });
  } catch {}
}
