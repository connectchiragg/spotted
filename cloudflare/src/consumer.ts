/**
 * Dependency wiring and the queue consumer. runDueJobs is trigger-agnostic: the
 * FramerScheduler Durable Object's alarm calls it today; anything else may too.
 */
import { AppDeps } from './api';
import { Env, settings } from './env';
import { Gemini } from './gemini';
import { drain, IngestDeps } from './ingest';
import { videoNotifier } from './notify';
import { purgeFinished } from './queue';
import { schedulerStub, Waker } from './schedule';
import { r2Presigner } from './storage';
import { expireUploads } from './store';
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
    scheduler: schedulerStub(env),
    events: env.VIDEO_EVENTS ?? null,
    notify: env.DB ? videoNotifier(env.VIDEO_EVENTS, env.DB) : undefined,
    waitUntil,
  };
}

/** Ingestion dependencies from the environment, or null if a binding or secret is missing. */
export function ingestDeps(env: Env, waker: Waker | null): IngestDeps | null {
  const deps = build(env, () => {});
  if (!deps.db || !deps.bucket || !deps.index || !deps.gemini || !deps.embedder) return null;
  return { db: deps.db, bucket: deps.bucket, index: deps.index, gemini: deps.gemini, embedder: deps.embedder,
    settings: deps.settings, waker: waker ?? undefined, notify: deps.notify };
}

/**
 * Housekeeping, then claim and process due jobs until none are due or the budget
 * runs out. D1 is the source of truth, so this is safe to call from any trigger,
 * repeatedly and concurrently. `configured` is false when ingestion bindings or
 * GEMINI_API_KEY are missing (the caller should not keep re-waking).
 */
export async function runDueJobs(env: Env, _ctx: { waitUntil(p: Promise<unknown>): void },
  opts: { deps?: IngestDeps; waker?: Waker } = {}): Promise<{ outcomes: string[]; configured: boolean }> {
  const db = opts.deps?.db ?? env.DB;
  if (!db) return { outcomes: [], configured: false };
  await expireUploads(db);
  await purgeFinished(db);
  const deps = opts.deps ?? ingestDeps(env, opts.waker ?? null);
  if (!deps) {
    console.warn('consumer: R2, Vectorize, Workers AI or GEMINI_API_KEY missing; queue not processed');
    return { outcomes: [], configured: false };
  }
  const outcomes = await drain(deps, {
    // Alarm handlers may run 15 min of wall time; stop starting steps after 10.
    // CPU is not measurable in Workers, so the work per invocation is a step count.
    maxSteps: deps.settings.stepsPerTick, deadlineMs: 10 * 60 * 1000,
  });
  if (outcomes.length) console.log('consumer steps', outcomes.join(' '));
  return { outcomes, configured: true };
}
