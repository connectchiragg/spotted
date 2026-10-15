/**
 * Google OAuth (one owner account), Google Photos Picker API and Google Drive API over fetch.
 *
 * - OAuth: authorization-code flow with access_type=offline. The refresh token is encrypted
 *   with AES-GCM (key: TOKEN_ENC_KEY secret, 32 bytes hex) and stored in D1 `google_auth`;
 *   it is never logged or returned by any route. Access tokens are minted on demand and
 *   cached in isolate memory until shortly before they expire.
 * - Photos Picker (https://developers.google.com/photos/picker): the Library API can no longer
 *   read a user's library, so the owner picks items in Google's picker: sessions.create ->
 *   pickerUri -> poll sessions.get until mediaItemsSet -> mediaItems.list -> download each
 *   video from baseUrl + "=dv" with the bearer token (baseUrls live 60 minutes).
 * - Drive: one folder, videos modified in the last 24 months, then changes.list from a stored
 *   page token, polled every 15 minutes by the LibraryDO alarm (no push web hook, so nothing
 *   needs to bypass Cloudflare Access).
 * - Testing-mode OAuth apps get refresh tokens that expire after 7 days: `invalid_grant`
 *   marks the connection "reconnect needed" (google_auth.status) and the UI offers Reconnect.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const PICKER = 'https://photospicker.googleapis.com/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3';

export class GoogleError extends Error {
  constructor(message: string, public status = 502, public retryable = false, public retryAfterSeconds: number | null = null, public quota = false) {
    super(message);
  }
}

// ------------------------------------------------------------------ token encryption

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));
const b64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(keyHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('TOKEN_ENC_KEY must be 64 hex characters');
  return crypto.subtle.importKey('raw', hex(keyHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** "v1.<iv b64>.<ciphertext b64>"; associated data binds the ciphertext to its purpose. */
export async function encryptSecret(plain: string, keyHex: string, purpose = 'google-refresh-token'): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
    await aesKey(keyHex), new TextEncoder().encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function decryptSecret(sealed: string, keyHex: string, purpose = 'google-refresh-token'): Promise<string> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Unknown sealed secret format');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(purpose) }, await aesKey(keyHex), unb64(ct));
  return new TextDecoder().decode(plain);
}

// ------------------------------------------------------------------ OAuth

export interface GoogleConfig { clientId: string; clientSecret: string; encKey: string; redirectUri: string }

export function authUrl(cfg: GoogleConfig, state: string): string {
  const u = new URL(AUTH);
  u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state }).toString();
  return u.toString();
}

type Fetcher = typeof fetch;
const defaultFetch: Fetcher = (input, init) => fetch(input, init);

function classify(status: number, what: string, body?: any): GoogleError {
  if (status === 429 || (status === 403 && /rate|quota/i.test(JSON.stringify(body ?? '')))) {
    return new GoogleError(`${what}: Google rate limit; retrying later`, 503, true, null, true);
  }
  if (status >= 500) return new GoogleError(`${what}: Google is temporarily unavailable`, 503, true);
  if (status === 401) return new GoogleError(`${what}: Google rejected the credentials; reconnect Google`, 401, false);
  if (status === 403) return new GoogleError(`${what}: access denied by Google`, 403, false);
  if (status === 404) return new GoogleError(`${what}: not found`, 404, false);
  return new GoogleError(`${what}: request failed (${status})`, 502, false);
}

export async function exchangeCode(cfg: GoogleConfig, code: string, fetcher: Fetcher = defaultFetch): Promise<{ refreshToken: string; scope: string }> {
  const res = await fetcher(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) throw new GoogleError('Google did not return a refresh token; remove the app from your Google account and connect again', 400);
  return { refreshToken: json.refresh_token, scope: String(json.scope ?? '') };
}

/** The stored, encrypted refresh token. */
export interface TokenStore { load(): Promise<string | null>; markInvalid(reason: string): Promise<void> }

export function d1TokenStore(db: D1Database): TokenStore {
  return {
    load: async () => (await db.prepare("SELECT refresh_token_enc FROM google_auth WHERE id=1 AND status='connected'").first<{ refresh_token_enc: string }>())?.refresh_token_enc ?? null,
    markInvalid: async (reason) => { await db.prepare("UPDATE google_auth SET status='reconnect_needed', error=?1, updated_at=?2 WHERE id=1").bind(reason, new Date().toISOString()).run(); },
  };
}

const cache = new Map<string, { token: string; until: number }>();

/** Google client for one account. `accessToken()` refreshes as needed. */
export class Google {
  constructor(private cfg: GoogleConfig, private store: TokenStore, private fetcher: Fetcher = defaultFetch) {}

  async accessToken(): Promise<string> {
    const hit = cache.get(this.cfg.clientId);
    if (hit && hit.until > Date.now()) return hit.token;
    const sealed = await this.store.load();
    if (!sealed) throw new GoogleError('Google is not connected', 409, false);
    const refreshToken = await decryptSecret(sealed, this.cfg.encKey);
    const res = await this.fetcher(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      if (json?.error === 'invalid_grant') {
        // Revoked, or a Testing-mode token past its 7 days: the owner must reconnect.
        await this.store.markInvalid('Google access expired or was revoked; reconnect Google');
        throw new GoogleError('Google access was revoked or expired; reconnect Google', 401, false);
      }
      throw classify(res.status, 'Token refresh', json);
    }
    cache.set(this.cfg.clientId, { token: json.access_token, until: Date.now() + (Number(json.expires_in ?? 3600) - 120) * 1000 });
    return json.access_token;
  }

  private async call(url: string, what: string, init: RequestInit = {}, pass: number[] = []): Promise<Response> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetcher(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });
    } catch {
      throw new GoogleError(`${what}: could not reach Google`, 502, true);
    }
    if (res.ok || pass.includes(res.status)) return res;
    const body = await res.json().catch(() => null);
    if (res.status === 401) cache.delete(this.cfg.clientId);
    throw classify(res.status, what, body);
  }

  // -------------------------------------------------------------- Photos Picker

  async createPickerSession(): Promise<PickerSession> {
    return (await this.call(`${PICKER}/sessions`, 'Create picker session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  }

  async getPickerSession(id: string): Promise<PickerSession> {
    return (await this.call(`${PICKER}/sessions/${encodeURIComponent(id)}`, 'Read picker session')).json();
  }

  async deletePickerSession(id: string): Promise<void> {
    await (await this.call(`${PICKER}/sessions/${encodeURIComponent(id)}`, 'Delete picker session', { method: 'DELETE' }, [404])).body?.cancel();
  }

  async listPickedItems(sessionId: string): Promise<PickedItem[]> {
    const items: PickedItem[] = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ sessionId, pageSize: '100', ...(pageToken ? { pageToken } : {}) });
      const json: any = await (await this.call(`${PICKER}/mediaItems?${q}`, 'List picked items')).json();
      items.push(...(json.mediaItems ?? []));
      pageToken = json.nextPageToken ?? '';
      if (!pageToken) break;
    }
    return items;
  }

  /** Size of a picked video's "=dv" download, from Content-Length (HEAD, else a 1-byte range). */
  async photoVideoSize(baseUrl: string): Promise<number | null> {
    const head = await this.call(`${baseUrl}=dv`, 'Read video size', { method: 'HEAD' }, [405]);
    let size = Number(head.headers.get('content-length'));
    if (head.status !== 405 && Number.isFinite(size) && size > 0) return size;
    const ranged = await this.call(`${baseUrl}=dv`, 'Read video size', { headers: { Range: 'bytes=0-0' } });
    await ranged.body?.cancel();
    size = Number(/\/(\d+)$/.exec(ranged.headers.get('content-range') ?? '')?.[1]);
    return Number.isFinite(size) && size > 0 ? size : null;
  }

  async downloadPhotoVideo(baseUrl: string): Promise<Response> {
    return this.call(`${baseUrl}=dv`, 'Download video');
  }

  // -------------------------------------------------------------- Drive

  async driveFolder(id: string): Promise<{ id: string; name: string; mimeType: string }> {
    return (await this.call(`${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`, 'Read Drive folder')).json();
  }

  async listDriveVideos(folderId: string, modifiedAfter: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken = '';
    const q = `'${folderId.replace(/'/g, "\\'")}' in parents and mimeType contains 'video/' and trashed = false and modifiedTime > '${modifiedAfter}'`;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ q, pageSize: '200', fields: `nextPageToken,files(${DRIVE_FIELDS})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) });
      const json: any = await (await this.call(`${DRIVE}/files?${params}`, 'List Drive folder')).json();
      files.push(...(json.files ?? []));
      pageToken = json.nextPageToken ?? '';
      if (!pageToken) break;
    }
    return files;
  }

  async driveStartPageToken(): Promise<string> {
    return (await (await this.call(`${DRIVE}/changes/startPageToken?supportsAllDrives=true`, 'Start Drive changes')).json<any>()).startPageToken;
  }

  /** Changed files since `pageToken`; returns the token to store for next time. */
  async driveChanges(pageToken: string): Promise<{ files: DriveFile[]; removed: string[]; next: string }> {
    const files: DriveFile[] = [];
    const removed: string[] = [];
    let token = pageToken;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ pageToken: token, pageSize: '200', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${DRIVE_FIELDS},trashed))` });
      const json: any = await (await this.call(`${DRIVE}/changes?${params}`, 'List Drive changes')).json();
      for (const c of json.changes ?? []) {
        if (c.removed || c.file?.trashed) removed.push(c.fileId);
        else if (c.file) files.push(c.file);
      }
      if (json.newStartPageToken) return { files, removed, next: json.newStartPageToken };
      token = json.nextPageToken;
      if (!token) break;
    }
    return { files, removed, next: token };
  }

  async downloadDriveFile(id: string): Promise<Response> {
    return this.call(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, 'Download Drive file');
  }
}

const DRIVE_FIELDS = 'id,name,mimeType,size,modifiedTime,parents,videoMediaMetadata(durationMillis,width,height)';

export interface PickerSession {
  id: string;
  pickerUri: string;
  mediaItemsSet?: boolean;
  expireTime?: string;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
}

export interface PickedItem {
  id: string;
  createTime?: string;
  type?: 'PHOTO' | 'VIDEO' | string;
  mediaFile: { baseUrl: string; mimeType: string; filename?: string; mediaFileMetadata?: { width?: number; height?: number; videoMetadata?: { processingStatus?: string } } };
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
  videoMediaMetadata?: { durationMillis?: string };
}

/** "5s" / "1.5s" (protobuf Duration JSON) -> ms. */
export function durationMs(value: string | undefined, fallback: number): number {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value ?? '');
  return m ? Math.round(Number(m[1]) * 1000) : fallback;
}
