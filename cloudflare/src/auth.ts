/**
 * Sign-in with Google (OpenID Connect, scopes openid email profile) and cookie sessions.
 *
 * - GET /auth/login stores a one-time state (oauth_states, purpose 'login') and redirects to
 *   Google. Google returns to the same /oauth/google/callback as the Photos connection; the
 *   state's purpose tells the two apart, so no second redirect URI has to be registered.
 * - The callback exchanges the code at Google's token endpoint over TLS. Per OpenID Connect
 *   Core 3.1.3.7 an ID token received directly from the token endpoint may be trusted without
 *   checking its signature; we still check iss, aud, exp and email_verified.
 * - Every OWNER_EMAILS address signs in as the user 'owner' (the original library, with Drive
 *   and no limits). Anyone else is 'g:<sub>', a guest with per-user limits.
 * - The session cookie (__Host-spotted) holds 32 random bytes; D1 stores only their SHA-256.
 *   HttpOnly, Secure, SameSite=Lax, 30 days. Non-GET requests must also be same-origin
 *   (api.ts), so the cookie cannot be ridden cross-site.
 */
import { nowIso } from './store';

export interface User { id: string; email: string; name: string | null; picture: string | null; role: 'owner' | 'guest' }

export const OWNER_ID = 'owner';
export const SESSION_COOKIE = '__Host-spotted';
const SESSION_DAYS = 30;
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';

const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randomToken = (n = 32) => hexOf(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(text: string): Promise<string> {
  return hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export function ownerEmails(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/** Only same-site relative paths survive as the post-login destination. */
export function safeNext(next: string | null): string {
  return next && /^\/(?!\/)[\w\-./?=&%#]*$/.test(next) ? next : '/';
}

export function loginUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(AUTH);
  u.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
    prompt: 'select_account', state }).toString();
  return u.toString();
}

export interface Identity { sub: string; email: string; name: string | null; picture: string | null }

/** Code -> verified identity from the ID token. Throws on anything unexpected. */
export async function exchangeLogin(cfg: { clientId: string; clientSecret: string; redirectUri: string }, code: string,
  fetcher: typeof fetch = (i, init) => fetch(i, init)): Promise<Identity> {
  const res = await fetcher(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof json.id_token !== 'string') throw new Error('Google sign-in failed');
  const claims = decodeJwtPayload(json.id_token);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Unexpected token issuer');
  if (claims.aud !== cfg.clientId) throw new Error('Token is for another app');
  if (!(Number(claims.exp) * 1000 > Date.now())) throw new Error('Token expired');
  if (claims.email_verified !== true || typeof claims.email !== 'string' || typeof claims.sub !== 'string') throw new Error('Google account email is not verified');
  return { sub: claims.sub, email: claims.email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null };
}

export function decodeJwtPayload(jwt: string): any {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Malformed token');
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

/** Create or refresh the user row for a signed-in identity. */
export async function upsertUser(db: D1Database, identity: Identity, owners: Set<string>): Promise<User> {
  const owner = owners.has(identity.email);
  const id = owner ? OWNER_ID : `g:${identity.sub}`;
  const ts = nowIso();
  await db.prepare(`INSERT INTO users (id, email, name, picture, role, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
    ON CONFLICT (id) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture, role=excluded.role, last_seen_at=excluded.last_seen_at`)
    .bind(id, identity.email, identity.name, identity.picture, owner ? 'owner' : 'guest', ts).run();
  return { id, email: identity.email, name: identity.name, picture: identity.picture, role: owner ? 'owner' : 'guest' };
}

export async function createSession(db: D1Database, userId: string, email: string): Promise<string> {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    db.prepare('INSERT INTO sessions (token_hash, user_id, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await sha256(token), userId, email, now, now + SESSION_DAYS * 86400),
  ]);
  return token;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearedCookie = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export function cookieToken(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) { const v = rest.join('='); return /^[0-9a-f]{64}$/.test(v) ? v : null; }
  }
  return null;
}

/** The signed-in user for this request, or null. */
export async function currentUser(db: D1Database, request: Request): Promise<User | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await db.prepare(`SELECT u.id, s.email, u.name, u.picture, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash=?1 AND s.expires_at > ?2`).bind(await sha256(token), Math.floor(Date.now() / 1000)).first<any>();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name ?? null, picture: row.picture ?? null, role: row.role === 'owner' ? 'owner' : 'guest' };
}

export async function endSession(db: D1Database, request: Request): Promise<void> {
  const token = cookieToken(request);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?1').bind(await sha256(token)).run();
}
