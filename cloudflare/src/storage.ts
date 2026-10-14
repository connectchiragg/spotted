/**
 * R2 access. Object bytes go browser -> R2 directly with a presigned PUT (Workers
 * cap request bodies at 100 MB, uploads go to 400 MB), and playback uses
 * presigned GETs. Presigning uses R2's S3-compatible API and an R2 API token;
 * HEAD/GET/DELETE inside the Worker use the R2 binding.
 */
import { AwsClient } from 'aws4fetch';
import { Env } from './env';

export interface Presigner {
  putUrl(key: string, contentType: string, expiresSeconds: number): Promise<string>;
  getUrl(key: string, expiresSeconds: number): Promise<string>;
}

export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function r2Presigner(env: Env): Presigner | null {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME) return null;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto',
  });
  const base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/`;
  async function sign(method: string, key: string, expires: number, headers: Record<string, string>, query: Record<string, string> = {}) {
    const url = new URL(base + encodeKey(key));
    url.searchParams.set('X-Amz-Expires', String(expires));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const signed = await client.sign(new Request(url, { method, headers }), { aws: { signQuery: true } });
    return signed.url;
  }
  return {
    // Content-Type is part of the signature: a mismatching browser PUT is rejected with 403.
    putUrl: (key, contentType, expires) => sign('PUT', key, expires, { 'Content-Type': contentType }),
    getUrl: (key, expires) => sign('GET', key, expires, {}, { 'response-content-disposition': 'inline' }),
  };
}
