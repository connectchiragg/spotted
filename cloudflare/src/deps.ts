/** Dependency wiring for the API Worker. Ingestion runs in the per-video VideoDO (src/video.ts). */
import { AppDeps } from './api';
import { Env, settings } from './env';
import { Gemini } from './gemini';
import { r2Presigner } from './storage';
import { workersAiEmbedder } from './vectors';

export function build(env: Env, waitUntil: (p: Promise<unknown>) => void): AppDeps {
  const config = settings(env);
  return {
    db: env.DB ?? null,
    bucket: env.VIDEOS ?? null,
    index: env.VECTORIZE ?? null,
    presigner: r2Presigner(env),
    gemini: env.GEMINI_API_KEY ? new Gemini(env.GEMINI_API_KEY, config.geminiModel) : null,
    embedder: env.AI ? workersAiEmbedder(env.AI, config.embeddingModel) : null,
    settings: config,
    geminiConfigured: Boolean(env.GEMINI_API_KEY),
    assets: env.ASSETS,
    videos: env.VIDEO ?? null,
    adminToken: env.ADMIN_TOKEN || null,
    waitUntil,
  };
}

