/** Fakes shared by the Node unit tests and the workerd (Miniflare D1) tests. */
import jpeg from 'jpeg-js';
import { AppDeps } from '../src/api';
import { Settings } from '../src/env';
import { Gemini, Segment } from '../src/gemini';
import { MediaPort, Transcriber } from '../src/media';
import { Reranker } from '../src/retrieval';
import { Presigner } from '../src/storage';
import { Embedder } from '../src/vectors';

export const settings: Settings = {
  geminiModel: 'gemini-test', embeddingModel: '@cf/test-embed', rerankModel: '@cf/test-rerank', whisperModel: '@cf/test-whisper',
  maxSourceBytes: 100 * 1000 * 1000, maxVideoSeconds: 600, maxFrames: 16, frameMaxSide: 1024, candidateInterval: 1, minFrameGap: 2, maxFrameGap: 30,
  changeThreshold: 12, describeBatch: 2, whisperDirectMaxBytes: 20 * 1000 * 1000, searchMinScore: 0.02, searchSoftMinScore: 0.008, searchMinSimilarity: 0.53, searchVectorMargin: 0.07, duplicateThreshold: 0.97,
  publicLimits: false, dailyUploadLimit: 10, dailyQueryLimit: 100, importStaggerSeconds: 0, drivePollMinutes: 60, driveLookbackMonths: 24,
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

/** Word-overlap reranker: the share of query words found in the passage. */
export function fakeReranker(): Reranker {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);
  return {
    model: '@cf/test-rerank',
    async rerank(query, contexts) {
      const q = words(query);
      return contexts.map((c) => { const w = words(c); let n = 0; for (const x of q) if (w.has(x)) n++; return q.size ? n / q.size : 0; });
    },
  };
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** In-memory Vectorize with the subset of filtering Spotted uses ($eq on strings, $in). */
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

export interface FakeObject { size: number; contentType: string; bytes?: Uint8Array }

/** An in-memory R2 bucket: head/get (with ranges)/put/list/delete and multipart uploads. */
export function fakeBucket(objects: Record<string, FakeObject>) {
  const bytesOf = (o: FakeObject) => o.bytes ?? new Uint8Array(o.size);
  const body = (b: Uint8Array) => ({ body: new ReadableStream({ start(c) { c.enqueue(b); c.close(); } }), arrayBuffer: async () => b.slice().buffer });
  const toBytes = async (v: any): Promise<Uint8Array> => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(await new Response(v).arrayBuffer()));
  return {
    async head(key: string) {
      const o = objects[key];
      return o ? { size: o.size, httpMetadata: { contentType: o.contentType } } : null;
    },
    async get(key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) {
      const o = objects[key];
      if (!o) return null;
      let b = bytesOf(o);
      const r = opts?.range;
      if (r?.suffix !== undefined) b = b.slice(Math.max(0, b.length - r.suffix));
      else if (r) b = b.slice(r.offset ?? 0, (r.offset ?? 0) + (r.length ?? b.length));
      return { size: o.size, httpMetadata: { contentType: o.contentType }, ...body(b) };
    },
    async put(key: string, value: any, opts?: { httpMetadata?: { contentType?: string } }) {
      const b = await toBytes(value);
      objects[key] = { size: b.length, contentType: opts?.httpMetadata?.contentType ?? 'application/octet-stream', bytes: b };
    },
    async list(opts: { prefix?: string } = {}) {
      return { objects: Object.keys(objects).filter((k) => k.startsWith(opts.prefix ?? '')).map((key) => ({ key })), truncated: false };
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) delete objects[k];
    },
    async createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }) {
      const parts: Uint8Array[] = [];
      return {
        uploadId: 'u1', key,
        async uploadPart(n: number, value: any) { parts[n - 1] = await toBytes(value); return { partNumber: n, etag: `e${n}` }; },
        async complete() {
          const total = parts.reduce((s, p) => s + p.length, 0);
          const all = new Uint8Array(total);
          let off = 0;
          for (const p of parts) { all.set(p, off); off += p.length; }
          objects[key] = { size: total, contentType: opts?.httpMetadata?.contentType ?? 'video/mp4', bytes: all };
        },
        async abort() {},
      };
    },
    resumeMultipartUpload() { return { abort: async () => {} }; },
  } as unknown as R2Bucket;
}

/** Bytes that look like an MP4 with an `mvhd` box declaring `seconds`. */
export function fakeMp4(seconds: number, size = 4096): Uint8Array {
  const b = new Uint8Array(size);
  const box = new DataView(b.buffer, 32, 40);
  box.setUint32(0, 108);
  b.set([0x6d, 0x76, 0x68, 0x64], 36); // 'mvhd'
  box.setUint32(20, 1000); // timescale (offset 16 from 'mvhd')
  box.setUint32(24, Math.round(seconds * 1000)); // duration
  return b;
}

/** Grayscale level of the "scene" at time t: a cut at each boundary. */
export const sceneAt = (cuts: number[]) => (t: number) => 40 + 50 * cuts.filter((c) => t >= c).length;

export function encodeTiles(levels: number[], w = 64, h = 36): Uint8Array {
  const data = new Uint8Array(w * h * levels.length * 4);
  levels.forEach((level, k) => {
    for (let i = 0; i < w * h; i++) {
      const p = (k * w * h + i) * 4;
      data[p] = data[p + 1] = data[p + 2] = level;
      data[p + 3] = 255;
    }
  });
  return new Uint8Array(jpeg.encode({ data, width: w, height: h * levels.length }, 90).data);
}

export interface FakeMediaOptions { cuts?: number[]; failFrame?: number }

/** Media Transformations fake: spritesheets follow `cuts`, frames are tiny JPEGs, audio is bytes. */
export function fakeMedia(opts: FakeMediaOptions = {}) {
  const scene = sceneAt(opts.cuts ?? [0, 10, 20]);
  const counts = { sprites: 0, frames: 0, audio: 0 };
  const port: MediaPort = {
    async spritesheet(_key, o) {
      counts.sprites++;
      return encodeTiles(Array.from({ length: o.count }, (_, k) => scene(o.time + (k * o.duration) / o.count)), o.width, o.height);
    },
    async frame(_key, o) {
      counts.frames++;
      if (opts.failFrame !== undefined && counts.frames === opts.failFrame) throw Object.assign(new Error('MEDIA_TRANSFORMATION_ERROR 9500: busy'), {});
      return encodeTiles([scene(o.time)], 16, 9);
    },
    async audio(_key, o) {
      counts.audio++;
      return new TextEncoder().encode(`audio ${o.time}-${o.time + o.duration}`);
    },
  };
  return { port, counts };
}

export function fakeTranscriber(segments: Segment[] = [{ start: 1, end: 4, text: 'Fold the blue towel neatly.' }]) {
  const counts = { calls: 0 };
  const transcriber: Transcriber = { model: '@cf/test-whisper', async transcribe() { counts.calls++; return segments; } };
  return { transcriber, counts };
}

export interface FakeGeminiOptions {
  /** Status for describe calls (e.g. 429 with RetryInfo 120 s, or 503). */
  describeStatus?: number;
  summaryStatus?: number;
  answer?: unknown;
  /** Awaited before describe calls (to hold a call open). */
  gate?: () => Promise<void>;
}

/** A Gemini client whose fetch is a scripted fake of generateContent; calls are counted. */
export function fakeGemini(opts: FakeGeminiOptions = {}) {
  const requests: any[] = [];
  const counts = { describe: 0, summary: 0, answer: 0 };
  const reply = (payload: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 200, totalTokenCount: 1700 } });
  const quota = () => Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' }] } }, { status: 429 });
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const system = JSON.stringify(body.systemInstruction);
    if (system.includes('still frames')) {
      counts.describe++;
      if (opts.gate) await opts.gate();
      if (opts.describeStatus === 429) return quota();
      if (opts.describeStatus) return new Response('{}', { status: opts.describeStatus });
      const indices = body.contents[0].parts.map((p: any) => /Frame index (\d+)/.exec(p.text ?? '')?.[1]).filter(Boolean).map(Number);
      return reply({ frames: indices.map((index: number) => ({ index, description: `Frame ${index}: hands fold a blue towel on a wooden bed in a bright bedroom.` })) });
    }
    if (system.includes('summarise')) {
      counts.summary++;
      if (opts.summaryStatus === 429) return quota();
      if (opts.summaryStatus) return new Response('{}', { status: opts.summaryStatus });
      return reply({ summary: 'A person folds a blue towel on a wooden bed and says to fold it neatly.',
        tags: [{ label: 'Bedroom', category: 'environment', frame_indices: [0, 1] }, { label: 'towel', category: 'object', frame_indices: [0] },
          { label: 'folding', category: 'action', frame_indices: [1] }, { label: 'neat folding', category: 'speech', frame_indices: [] }],
        labels: [{ label: 'bedroom', frame_indices: [0] }, 'tidying', 'towel rack'], sounds: ['talking'] });
    }
    counts.answer++;
    return opts.answer === undefined ? new Response('{}', { status: 503 }) : reply(opts.answer);
  };
  return { gemini: new Gemini('test-key', 'gemini-test', fetcher as typeof fetch), requests, counts };
}

export function appDeps(db: D1Database | null, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db, bucket: null, index: null, presigner: fakePresigner, gemini: null, embedder: fakeEmbedder(), reranker: fakeReranker(), settings,
    geminiConfigured: true, waitUntil: () => {}, ...overrides,
  };
}
