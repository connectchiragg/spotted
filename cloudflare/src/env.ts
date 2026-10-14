export interface Env {
  ASSETS?: Fetcher;
  VIDEO?: DurableObjectNamespace;
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  VIDEOS?: R2Bucket;
  AI?: Ai;

  // Secrets (wrangler secret put): never in wrangler.jsonc or git.
  GEMINI_API_KEY?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // Plain vars (wrangler.jsonc "vars").
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  GEMINI_MODEL?: string;
  EMBEDDING_MODEL?: string;
  MAX_UPLOAD_MB?: string;
  MAX_VIDEO_SECONDS?: string;
  MAX_FRAMES?: string;
  SEARCH_MIN_SIMILARITY?: string;
  DUPLICATE_SIMILARITY_THRESHOLD?: string;
  PUBLIC_DEMO_LIMITS?: string;
  DAILY_UPLOAD_LIMIT?: string;
  DAILY_QUERY_LIMIT?: string;
  QUEUE_STEPS_PER_TICK?: string;
  SSE_PING_MS?: string;
  SSE_MAX_STREAM_MS?: string;
}

export interface Settings {
  geminiModel: string;
  embeddingModel: string;
  maxUploadBytes: number;
  maxVideoSeconds: number;
  maxFrames: number;
  searchMinSimilarity: number;
  duplicateThreshold: number;
  publicLimits: boolean;
  dailyUploadLimit: number;
  dailyQueryLimit: number;
  stepsPerTick: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric setting: ${value}`);
  return parsed;
}

export function settings(env: Env): Settings {
  const result: Settings = {
    geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash',
    embeddingModel: env.EMBEDDING_MODEL || '@cf/baai/bge-small-en-v1.5',
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 400) * 1024 * 1024,
    maxVideoSeconds: num(env.MAX_VIDEO_SECONDS, 600),
    maxFrames: num(env.MAX_FRAMES, 16),
    searchMinSimilarity: num(env.SEARCH_MIN_SIMILARITY, 0.6),
    duplicateThreshold: num(env.DUPLICATE_SIMILARITY_THRESHOLD, 0.95),
    publicLimits: (env.PUBLIC_DEMO_LIMITS || 'false').toLowerCase() === 'true',
    dailyUploadLimit: num(env.DAILY_UPLOAD_LIMIT, 10),
    dailyQueryLimit: num(env.DAILY_QUERY_LIMIT, 100),
    stepsPerTick: num(env.QUEUE_STEPS_PER_TICK, 6),
  };
  if (!(result.maxFrames >= 1 && result.maxFrames <= 32)) throw new Error('MAX_FRAMES must be between 1 and 32');
  for (const value of [result.searchMinSimilarity, result.duplicateThreshold]) {
    if (!(value >= 0 && value <= 1)) throw new Error('Similarity thresholds must be between 0 and 1');
  }
  return result;
}
