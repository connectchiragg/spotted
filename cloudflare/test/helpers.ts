/** Fakes shared by the Node unit tests and the workerd (Miniflare D1) tests. */
import { AppDeps } from '../src/api';
import { Settings } from '../src/env';
import { Gemini } from '../src/gemini';
import { Presigner } from '../src/storage';
import { Embedder } from '../src/vectors';

export const settings: Settings = {
  geminiModel: 'gemini-test', embeddingModel: '@cf/test-embed', maxUploadBytes: 400 * 1024 * 1024, maxVideoSeconds: 600,
  maxFrames: 16, searchMinSimilarity: 0.6, duplicateThreshold: 0.95, publicLimits: false, dailyUploadLimit: 10,
  dailyQueryLimit: 100, stepsPerTick: 6,
};

/** Deterministic bag-of-words embedder: shared words -> high cosine. */
export function fakeEmbedder(): Embedder {
  const dims = 64;
  return {
    model: '@cf/test-embed',
    async embed(texts: string[]) {
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
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** In-memory Vectorize with the subset of filtering Framer uses ($eq on strings, $in). */
export function fakeVectorize() {
  const store = new Map<string, { values: number[]; metadata: Record<string, any> }>();
  const matches = (metadata: Record<string, any>, filter: Record<string, any> = {}) =>
    Object.entries(filter).every(([k, cond]) => (cond && typeof cond === 'object' && '$in' in cond ? cond.$in.includes(metadata[k]) : metadata[k] === cond));
  const index = {
    async upsert(vectors: { id: string; values: number[]; metadata: Record<string, any> }[]) {
      for (const v of vectors) store.set(v.id, { values: v.values, metadata: v.metadata });
      return { mutationId: 'm' };
    },
    async query(vector: number[], opts: { topK: number; filter?: Record<string, any> }) {
      const found = [...store.entries()].filter(([, v]) => matches(v.metadata, opts.filter))
        .map(([id, v]) => ({ id, score: cosine(vector, v.values) }))
        .sort((a, b) => b.score - a.score).slice(0, opts.topK);
      return { matches: found, count: found.length };
    },
    async deleteByIds(ids: string[]) {
      ids.forEach((id) => store.delete(id));
      return { mutationId: 'm' };
    },
  };
  return { index: index as unknown as VectorizeIndex, store };
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
  states?: string[]; // successive getFile states of an existing file
  duration?: string;
  tagging?: unknown;
  tagStatus?: number;
  uploadStatus?: number; // status for the upload start request
  answer?: unknown;
  /** Awaited before generateContent for tagging answers (to hold a call open). */
  tagGate?: (signal?: AbortSignal | null) => Promise<void>;
}

/**
 * A Gemini client whose fetch is a scripted, stateful fake of the REST API:
 * uploaded files persist (by client-chosen or generated name), duplicate names
 * answer 409 ALREADY_EXISTS like the real API, and every call is logged.
 */
export function fakeGemini(opts: FakeGeminiOptions = {}) {
  const states = [...(opts.states ?? ['ACTIVE'])];
  const log: string[] = [];
  const files = new Map<string, { name: string; uri: string; mimeType: string; displayName: string }>();
  const requests: any[] = [];
  const counts = { uploads: 0, generate: 0 };
  let pending: { name: string; displayName: string } | null = null;
  let generated = 0;
  const record = (f: { name: string; uri: string; mimeType: string; displayName: string }, state: string) =>
    ({ ...f, state, videoMetadata: { videoDuration: opts.duration ?? '20s' } });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace('https://generativelanguage.googleapis.com', '');
    log.push(`${method} ${path}`);
    if (url.endsWith('/upload/v1beta/files')) {
      if (opts.uploadStatus) return new Response('{}', { status: opts.uploadStatus });
      const file = JSON.parse(String(init?.body)).file ?? {};
      pending = { name: file.name ?? `files/gen${++generated}`, displayName: file.display_name ?? '' };
      return new Response('{}', { headers: { 'x-goog-upload-url': 'https://upload.test/session' } });
    }
    if (url === 'https://upload.test/session') {
      if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
      const { name, displayName } = pending!;
      if (files.has(name)) return Response.json({ error: { code: 409, status: 'ALREADY_EXISTS' } }, { status: 409 });
      counts.uploads++;
      const file = { name, uri: `https://files.test/${name}`, mimeType: 'video/mp4', displayName };
      files.set(name, file);
      return Response.json({ file: record(file, 'PROCESSING') });
    }
    if (path.startsWith('/v1beta/files?') && method === 'GET') {
      return Response.json({ files: [...files.values()].map((f) => record(f, states[0])) });
    }
    const fileMatch = /^\/v1beta\/(files\/[a-z0-9-]+)$/.exec(path);
    if (fileMatch && method === 'GET') {
      const file = files.get(fileMatch[1]);
      if (!file) return Response.json({ error: { code: 404 } }, { status: 404 });
      const state = states.length > 1 ? states.shift()! : states[0];
      return Response.json(record(file, state));
    }
    if (fileMatch && method === 'DELETE') {
      files.delete(fileMatch[1]);
      return new Response('{}');
    }
    if (url.includes(':generateContent')) {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const isAnswer = JSON.stringify(body.systemInstruction).includes('retrieved evidence');
      if (!isAnswer) {
        counts.generate++;
        if (opts.tagGate) await opts.tagGate(init?.signal);
        if (init?.signal?.aborted) throw init.signal.reason;
      }
      if (!isAnswer && opts.tagStatus === 429) {
        return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' }] } }, { status: 429 });
      }
      if (!isAnswer && opts.tagStatus) return new Response('{}', { status: opts.tagStatus });
      const payload = isAnswer ? opts.answer : opts.tagging ?? defaultTagging;
      if (payload === undefined) return new Response('{}', { status: 503 });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 200, totalTokenCount: 1700 } });
    }
    return new Response('not found', { status: 404 });
  };
  return { gemini: new Gemini('test-key', 'gemini-test', fetcher as typeof fetch), log, files, requests, counts };
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

export function appDeps(db: D1Database | null, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db, bucket: null, index: null, presigner: fakePresigner, gemini: null, embedder: fakeEmbedder(), settings,
    geminiConfigured: true, waitUntil: () => {}, ...overrides,
  };
}
