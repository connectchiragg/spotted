/** Dependency wiring for the API Worker. Ingestion runs in the per-video VideoDO (src/video.ts). */
import { AppDeps } from './api';
import { Env, settings } from './env';
import { Gemini } from './gemini';
import { workersAiReranker } from './retrieval';
import { r2Presigner } from './storage';
import { googleClient } from './video';
import { workersAiEmbedder } from './vectors';

export function build(env: Env, waitUntil: (p: Promise<unknown>) => void): AppDeps {
  const config = settings(env);
  const origin = env.PUBLIC_ORIGIN || 'https://spotted.haciensus.com';
  const googleReady = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENC_KEY);
  return {
    db: env.DB ?? null,
    bucket: env.VIDEOS ?? null,
    index: env.VECTORIZE ?? null,
    presigner: r2Presigner(env),
    gemini: env.GEMINI_API_KEY ? new Gemini(env.GEMINI_API_KEY, config.geminiModel) : null,
    embedder: env.AI ? workersAiEmbedder(env.AI, config.embeddingModel) : null,
    reranker: env.AI ? workersAiReranker(env.AI, config.rerankModel) : null,
    settings: config,
    geminiConfigured: Boolean(env.GEMINI_API_KEY),
    assets: env.ASSETS,
    videos: env.VIDEO ?? null,
    library: env.LIBRARY ?? null,
    googleConfig: googleReady ? { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, encKey: env.TOKEN_ENC_KEY!, redirectUri: `${origin}/oauth/google/callback` } : null,
    google: googleClient(env),
    origins: [origin, ...(env.PUBLIC_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)],
    adminToken: env.ADMIN_TOKEN || null,
    waitUntil,
  };
}
