export interface Env {
  ASSETS?: Fetcher;
  VIDEO?: DurableObjectNamespace;
  LIBRARY?: DurableObjectNamespace;
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  VIDEOS?: R2Bucket;
  AI?: Ai;
  /** Media Transformations binding ("media": {"binding": "MEDIA"}). */
  MEDIA?: any;

  // Secrets (wrangler secret put): never in wrangler.jsonc or git.
  GEMINI_API_KEY?: string;
  /** Bearer token for DELETE /admin/videos/:id; without it the admin route does not exist. */
  ADMIN_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** 64 hex chars: AES-GCM key that seals the Google refresh token in D1. */
  TOKEN_ENC_KEY?: string;

  // Plain vars (wrangler.jsonc "vars").
  GOOGLE_CLIENT_ID?: string;
  PUBLIC_ORIGIN?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  GEMINI_MODEL?: string;
  EMBEDDING_MODEL?: string;
  RERANK_MODEL?: string;
  WHISPER_MODEL?: string;
  MAX_SOURCE_MB?: string;
  MAX_VIDEO_SECONDS?: string;
  MAX_FRAMES?: string;
  FRAME_MAX_SIDE?: string;
  CANDIDATE_INTERVAL_S?: string;
  MIN_FRAME_GAP_S?: string;
  MAX_FRAME_GAP_S?: string;
  CHANGE_THRESHOLD?: string;
  DESCRIBE_BATCH?: string;
  WHISPER_DIRECT_MAX_MB?: string;
  SEARCH_MIN_SCORE?: string;
  DUPLICATE_SIMILARITY_THRESHOLD?: string;
  PUBLIC_DEMO_LIMITS?: string;
  DAILY_UPLOAD_LIMIT?: string;
  DAILY_QUERY_LIMIT?: string;
  IMPORT_STAGGER_S?: string;
  DRIVE_POLL_MINUTES?: string;
  DRIVE_LOOKBACK_MONTHS?: string;
}

export interface Settings {
  geminiModel: string;
  embeddingModel: string;
  rerankModel: string;
  whisperModel: string;
  /** Media Transformations accepts inputs under 100 MB; larger sources are skipped, never copied. */
  maxSourceBytes: number;
  maxVideoSeconds: number;
  maxFrames: number;
  frameMaxSide: number;
  candidateInterval: number;
  minFrameGap: number;
  /** Split gaps between picked frames longer than this (coverage for slowly changing footage). */
  maxFrameGap: number;
  changeThreshold: number;
  describeBatch: number;
  whisperDirectMaxBytes: number;
  searchMinScore: number;
  duplicateThreshold: number;
  publicLimits: boolean;
  dailyUploadLimit: number;
  dailyQueryLimit: number;
  importStaggerSeconds: number;
  drivePollMinutes: number;
  driveLookbackMonths: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric setting: ${value}`);
  return parsed;
}

export function settings(env: Env): Settings {
  const result: Settings = {
    geminiModel: env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    embeddingModel: env.EMBEDDING_MODEL || '@cf/baai/bge-m3',
    rerankModel: env.RERANK_MODEL || '@cf/baai/bge-reranker-base',
    whisperModel: env.WHISPER_MODEL || '@cf/openai/whisper-large-v3-turbo',
    maxSourceBytes: num(env.MAX_SOURCE_MB, 100) * 1000 * 1000,
    maxVideoSeconds: num(env.MAX_VIDEO_SECONDS, 600),
    maxFrames: num(env.MAX_FRAMES, 16),
    frameMaxSide: num(env.FRAME_MAX_SIDE, 1024),
    candidateInterval: num(env.CANDIDATE_INTERVAL_S, 1),
    minFrameGap: num(env.MIN_FRAME_GAP_S, 2),
    maxFrameGap: num(env.MAX_FRAME_GAP_S, 8),
    changeThreshold: num(env.CHANGE_THRESHOLD, 12),
    describeBatch: num(env.DESCRIBE_BATCH, 8),
    whisperDirectMaxBytes: num(env.WHISPER_DIRECT_MAX_MB, 10) * 1000 * 1000,
    searchMinScore: num(env.SEARCH_MIN_SCORE, 0.02),
    duplicateThreshold: num(env.DUPLICATE_SIMILARITY_THRESHOLD, 0.97),
    publicLimits: (env.PUBLIC_DEMO_LIMITS || 'false').toLowerCase() === 'true',
    dailyUploadLimit: num(env.DAILY_UPLOAD_LIMIT, 10),
    dailyQueryLimit: num(env.DAILY_QUERY_LIMIT, 100),
    importStaggerSeconds: num(env.IMPORT_STAGGER_S, 20),
    drivePollMinutes: num(env.DRIVE_POLL_MINUTES, 15),
    driveLookbackMonths: num(env.DRIVE_LOOKBACK_MONTHS, 24),
  };
  if (!(result.maxFrames >= 1 && result.maxFrames <= 40)) throw new Error('MAX_FRAMES must be between 1 and 40');
  if (!(result.maxSourceBytes > 0 && result.maxSourceBytes <= 100 * 1000 * 1000)) throw new Error('MAX_SOURCE_MB must be at most 100 (Media Transformations input limit)');
  if (!(result.describeBatch >= 1 && result.describeBatch <= 16)) throw new Error('DESCRIBE_BATCH must be between 1 and 16');
  for (const value of [result.searchMinScore, result.duplicateThreshold]) {
    if (!(value >= 0 && value <= 1)) throw new Error('Score thresholds must be between 0 and 1');
  }
  return result;
}
