/**
 * Per-user LLM keys and which model a piece of work runs on.
 *
 *   owner                  the server's GEMINI_API_KEY (unchanged behaviour)
 *   guest with a key       their own key, decrypted per use; never logged, never returned
 *   guest without a key    null: analysis waits ("Add your API key in Settings to analyse videos")
 *                          and search answers fall back to retrieval only
 *
 * The owner's server key is never used for anyone else, so guests cost the owner no LLM spend.
 */
import { OWNER_ID } from './auth';
import { Gemini } from './gemini';
import { decryptSecret, encryptSecret } from './google';
import { isProvider, Llm, makeLlm, Provider, PROVIDERS } from './llm';
import { nowIso } from './store';

const purpose = (userId: string) => `llm-api-key:${userId}`;

export interface KeyInfo { provider: Provider; model: string; last4: string; status: string; error: string | null; checked_at: string | null; updated_at: string }

export interface LlmContext {
  db: D1Database;
  /** TOKEN_ENC_KEY (64 hex). Without it no stored key can be used. */
  encKey: string | null;
  /** The server's GEMINI_API_KEY and model: the owner's only. */
  serverKey: string | null;
  serverModel: string;
  fetcher?: typeof fetch;
  referer?: string;
}

/** Trimmed, printable, sensibly sized; otherwise null. */
export function cleanKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key.length >= 8 && key.length <= 400 && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

export function cleanModel(raw: unknown, provider: Provider): string | null {
  if (raw === undefined || raw === null || raw === '') return PROVIDERS[provider].defaultModel;
  if (typeof raw !== 'string') return null;
  const model = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/@~-]{0,119}$/.test(model) ? model : null;
}

export async function keyInfo(db: D1Database, userId: string): Promise<KeyInfo | null> {
  const row = await db.prepare('SELECT provider, model, key_last4, status, error, checked_at, updated_at FROM llm_keys WHERE user_id=?1').bind(userId).first<any>();
  return row ? { provider: row.provider, model: row.model, last4: row.key_last4, status: row.status, error: row.error, checked_at: row.checked_at, updated_at: row.updated_at } : null;
}

export async function saveKey(db: D1Database, encKey: string, userId: string, provider: Provider, model: string, key: string): Promise<void> {
  const sealed = await encryptSecret(key, encKey, purpose(userId));
  const ts = nowIso();
  await db.prepare(`INSERT INTO llm_keys (user_id, provider, model, key_enc, key_last4, status, error, checked_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'ok', NULL, ?6, ?6, ?6)
    ON CONFLICT (user_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, key_enc=excluded.key_enc, key_last4=excluded.key_last4,
      status='ok', error=NULL, checked_at=excluded.checked_at, updated_at=excluded.updated_at`).bind(userId, provider, model, sealed, key.slice(-4), ts).run();
}

export async function deleteKey(db: D1Database, userId: string): Promise<boolean> {
  return ((await db.prepare('DELETE FROM llm_keys WHERE user_id=?1').bind(userId).run()).meta.changes ?? 0) > 0;
}

export async function markKey(db: D1Database, userId: string, status: 'ok' | 'invalid', error: string | null): Promise<void> {
  await db.prepare('UPDATE llm_keys SET status=?2, error=?3, checked_at=?4 WHERE user_id=?1').bind(userId, status, error, nowIso()).run();
}

/** The stored key, decrypted (server-side use only). Null: none, or it cannot be opened. */
export async function openKey(db: D1Database, encKey: string | null, userId: string): Promise<{ provider: Provider; model: string; key: string; status: string } | null> {
  if (!encKey) return null;
  const row = await db.prepare('SELECT provider, model, key_enc, status FROM llm_keys WHERE user_id=?1').bind(userId).first<any>();
  if (!row || !isProvider(row.provider)) return null;
  try {
    return { provider: row.provider, model: row.model, key: await decryptSecret(row.key_enc, encKey, purpose(userId)), status: row.status };
  } catch {
    console.warn('llm key could not be decrypted', userId); // e.g. TOKEN_ENC_KEY rotated; never the key
    return null;
  }
}

/**
 * The stored key as a client. Null: none, it cannot be opened, or the provider rejected it during
 * analysis (status 'invalid'; `anyStatus` still returns it, for the Test button).
 */
export async function storedLlm(ctx: LlmContext, userId: string, anyStatus = false): Promise<Llm | null> {
  const stored = await openKey(ctx.db, ctx.encKey, userId);
  if (!stored || (stored.status === 'invalid' && !anyStatus)) return null;
  return makeLlm(stored.provider, stored.key, stored.model, ctx.fetcher, ctx.referer);
}

/** Which LLM this user's work runs on: the owner -> the server key; a guest -> their own key or null. */
export async function llmFor(ctx: LlmContext, userId: string): Promise<Llm | null> {
  if (userId === OWNER_ID) return ctx.serverKey ? new Gemini(ctx.serverKey, ctx.serverModel, ctx.fetcher) : null;
  return storedLlm(ctx, userId);
}

export const NEEDS_KEY = 'Add your API key in Settings to analyse videos';
export const KEY_REJECTED = 'Your API key was rejected. Update it in Settings to analyse videos';
