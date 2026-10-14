import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { AppDeps } from '../src/api';
import { ClosableDb, connect } from '../src/db';
import { Embedder } from '../src/embeddings';
import { Settings } from '../src/env';
import { Gemini } from '../src/gemini';
import { Presigner } from '../src/storage';

export const DSN = process.env.TEST_POSTGRES_DSN;

export const settings: Settings = {
  geminiModel: 'gemini-test', embeddingModel: '@cf/test-embed', maxUploadBytes: 400 * 1024 * 1024, maxVideoSeconds: 600,
  maxFrames: 16, searchMinSimilarity: 0.6, duplicateThreshold: 0.95, publicLimits: false, dailyUploadLimit: 10,
  dailyQueryLimit: 100, stepsPerTick: 2,
};

/** Fresh schema per test file, migrated with migrations/0001_init.sql. */
export async function isolatedDb(): Promise<{ db: ClosableDb; drop: () => Promise<void> }> {
  const schema = 'cf_test_' + crypto.randomUUID().replace(/-/g, '');
  const admin = postgres(DSN!, { max: 1, onnotice: () => {} });
  await admin.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const db = connect(DSN!, { max: 4, connection: { search_path: `${schema},public` } });
  await db.query(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8').replace(/^CREATE EXTENSION.*$/m, ''));
  return {
    db,
    drop: async () => {
      await db.close();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** Deterministic bag-of-words embedder: shared words -> high cosine. */
export function fakeEmbedder(): Embedder & { calls: number } {
  const dims = 64;
  const e = {
    model: '@cf/test-embed',
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => {
        const v = new Array(dims).fill(0);
        for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
          let h = 0;
          for (const c of w) h = (h * 31 + c.charCodeAt(0)) % dims;
          v[h] += 1;
        }
        v[0] += 0.01;
        return v;
      });
    },
  };
  return e;
}

export const fakePresigner: Presigner = {
  putUrl: async (key, ct) => `https://r2.test/${key}?put&ct=${encodeURIComponent(ct)}`,
  getUrl: async (key) => `https://r2.test/${key}?get`,
};

export function fakeBucket(objects: Record<string, { size: number; contentType: string }>) {
  return {
    async head(key: string) {
      const o = objects[key];
      return o ? { size: o.size, httpMetadata: { contentType: o.contentType } } : null;
    },
    async get(key: string) {
      const o = objects[key];
      return o ? { size: o.size, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(o.size)); c.close(); } }) } : null;
    },
  } as unknown as R2Bucket;
}

export interface FakeGeminiOptions {
  states?: string[]; // successive getFile states
  duration?: string;
  tagging?: unknown;
  tagStatus?: number;
  answer?: unknown;
}

/** A Gemini client whose fetch is a scripted fake of the REST API. */
export function fakeGemini(opts: FakeGeminiOptions = {}) {
  const states = [...(opts.states ?? ['ACTIVE'])];
  const log: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    log.push(`${method} ${url.replace('https://generativelanguage.googleapis.com', '')}`);
    if (url.endsWith('/upload/v1beta/files')) {
      return new Response('{}', { headers: { 'x-goog-upload-url': 'https://upload.test/session' } });
    }
    if (url === 'https://upload.test/session') {
      if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
      return Response.json({ file: { name: 'files/abc', uri: 'https://files.test/abc', mimeType: 'video/mp4', state: 'PROCESSING' } });
    }
    if (url.endsWith('/v1beta/files/abc') && method === 'GET') {
      const state = states.length > 1 ? states.shift()! : states[0];
      return Response.json({ name: 'files/abc', uri: 'https://files.test/abc', mimeType: 'video/mp4', state,
        videoMetadata: { videoDuration: opts.duration ?? '20s' } });
    }
    if (url.endsWith('/v1beta/files/abc') && method === 'DELETE') return new Response('{}');
    if (url.includes(':generateContent')) {
      const body = JSON.parse(String(init?.body));
      const isAnswer = JSON.stringify(body.systemInstruction).includes('retrieved evidence');
      if (!isAnswer && opts.tagStatus) return new Response('{}', { status: opts.tagStatus });
      const payload = isAnswer ? opts.answer : opts.tagging ?? defaultTagging;
      if (payload === undefined) return new Response('{}', { status: 503 });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
    }
    return new Response('not found', { status: 404 });
  };
  return { gemini: new Gemini('test-key', 'gemini-test', fetcher as typeof fetch), log };
}

export const defaultTagging = {
  summary: 'A person folds a blue towel on a wooden bed.',
  tags: [
    { label: 'Bedroom', category: 'environment', frame_indices: [0, 1] },
    { label: 'towel', category: 'object', frame_indices: [0] },
    { label: 'folding towel', category: 'action', frame_indices: [0] },
  ],
  moments: [
    { timestamp_seconds: 12.5, description: 'Hands fold a blue towel on the bed.' },
    { timestamp_seconds: 2, description: 'A bedroom with a wooden bed and white pillows.' },
  ],
};

export function appDeps(db: ClosableDb | null, overrides: Partial<AppDeps> = {}): AppDeps & { background: Promise<unknown>[] } {
  const background: Promise<unknown>[] = [];
  return {
    db, bucket: null, presigner: fakePresigner, gemini: null, embedder: fakeEmbedder(), settings, geminiConfigured: true,
    waitUntil: (p) => background.push(p), background, ...overrides,
  };
}
