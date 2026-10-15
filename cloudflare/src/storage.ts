/**
 * Optional R2 presigning. With an R2 API token (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY), uploads
 * and playback use presigned PUT/GET URLs straight to R2. Without one (the default), they go
 * through the Worker: PUT /videos/:id/upload and GET /videos/:id/source (src/api.ts), within the
 * 100 MB request-body limit that matches the source limit. Everything else uses the R2 binding.
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
