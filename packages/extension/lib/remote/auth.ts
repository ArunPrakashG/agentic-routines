// Sign-in with Google, GitHub or Microsoft (PKCE), or an email and password proved with a mailed code. The API holds
// the client secrets and issues our own session, which only lives here: the panel gets the account, never the tokens.

// Dev scripts build with WXT_API_URL pointing at a local API, so tests never reach the real one.
const API = import.meta.env.WXT_API_URL || 'https://agenticroutines.arunprakashg.com';
const GOOGLE_CLIENT_ID = '883265328584-285ao8n0u1nkv8b9ftr2q2bov23lieeo.apps.googleusercontent.com';

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

export type Provider = 'google' | 'github' | 'microsoft';
/** What the API offers. The client ids are public. */
export interface Offered {
  providers: { id: Provider; client_id: string }[];
  password: boolean;
}

const AUTHORIZE: Record<Provider, { url: string; scope: string; nonce: boolean }> = {
  google: { url: 'https://accounts.google.com/o/oauth2/v2/auth', scope: 'openid email profile', nonce: true },
  github: { url: 'https://github.com/login/oauth/authorize', scope: 'read:user user:email', nonce: false },
  microsoft: { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', scope: 'openid profile email', nonce: true },
};

/** The ways to sign in. When the API can't be reached, Google alone, which the extension can always try. */
export async function offered(): Promise<Offered> {
  try {
    const res = await fetch(`${API}/api/v1/auth/providers`);
    if (res.ok) {
      const o = (await res.json()) as Offered;
      return { providers: o.providers.filter((p) => p.id in AUTHORIZE), password: o.password === true };
    }
  } catch {}
  return { providers: [{ id: 'google', client_id: GOOGLE_CLIENT_ID }], password: false };
}

async function begin(res: Response): Promise<void> {
  if (!res.ok) throw new Error(await explain(res));
  const t = (await res.json()) as Tokens & { user: Account };
  await browser.storage.local.set({ session: stored(t.user, t) });
}

const REASONS: Record<string, string> = {
  bad_email: "That email address doesn't look right.",
  weak_password: 'Use at least 10 characters.',
  bad_code: 'That code is wrong or has expired. Ask for a new one.',
  bad_credentials: 'Wrong email or password.',
  too_many_attempts: 'Too many wrong passwords. Wait 15 minutes, or reset your password.',
  rate_limited: 'Too many tries. Wait a minute.',
};
async function explain(res: Response): Promise<string> {
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  return (error && REASONS[error]) || 'Could not finish signing in.';
}

export async function signIn(provider: Provider = 'google'): Promise<void> {
  const how = AUTHORIZE[provider];
  if (!how) throw new Error('Unknown way to sign in.');
  const clientId = (await offered()).providers.find((p) => p.id === provider)?.client_id;
  if (!clientId) throw new Error('That way of signing in is not available.');
  const verifier = random();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(16);
  const nonce = random(16);
  const redirect = browser.identity.getRedirectURL();
  const url = new URL(how.url);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: how.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...(how.nonce ? { nonce, prompt: 'select_account' } : {}),
  }).toString();

  const back = await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const q = new URL(back!).searchParams;
  const code = q.get('code');
  if (q.get('state') !== state || !code) throw new Error('That did not sign you in.');

  await begin(await post(`/auth/${provider}`, { code, code_verifier: verifier, redirect_uri: redirect, nonce, install_id: await installId() }));
}

/** Mails a six digit code to the address. The answer is the same whether or not the address has an account. */
export async function passwordCode(email: string): Promise<void> {
  const res = await post('/auth/password/code', { email });
  if (!res.ok) throw new Error(await explain(res));
}

/** Makes the account for an address, or replaces its password. Needs the mailed code. */
export async function passwordSet(email: string, code: string, password: string): Promise<void> {
  await begin(await post('/auth/password/set', { email, code, password, install_id: await installId() }));
}

export async function passwordLogin(email: string, password: string): Promise<void> {
  await begin(await post('/auth/password/login', { email, password, install_id: await installId() }));
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
