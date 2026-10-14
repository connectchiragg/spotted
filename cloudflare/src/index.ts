import { AppDeps, handle } from './api';
import { ClosableDb, connect } from './db';
import { workersAiEmbedder, backfillEmbeddings } from './embeddings';
import { Env, settings } from './env';
import { Gemini } from './gemini';
import { drain } from './ingest';
import { sweepExhausted } from './queue';
import { r2Presigner } from './storage';
import { expireUploads } from './store';

function build(env: Env, waitUntil: (p: Promise<unknown>) => void): { deps: AppDeps; db: ClosableDb | null } {
  const config = settings(env);
  const db = env.HYPERDRIVE ? connect(env.HYPERDRIVE.connectionString) : null;
  return {
    db,
    deps: {
      db,
      bucket: env.VIDEOS ?? null,
      presigner: r2Presigner(env),
      gemini: env.GEMINI_API_KEY ? new Gemini(env.GEMINI_API_KEY, config.geminiModel) : null,
      embedder: env.AI ? workersAiEmbedder(env.AI, config.embeddingModel) : null,
      settings: config,
      geminiConfigured: Boolean(env.GEMINI_API_KEY),
      assets: env.ASSETS,
      waitUntil,
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const { deps, db } = build(env, (p) => pending.push(p));
    try {
      return await handle(request, deps);
    } finally {
      // Close the Hyperdrive connection once any request-path queue work finishes.
      ctx.waitUntil(Promise.allSettled(pending).then(() => db?.close()));
    }
  },

  /** Cron consumer: housekeeping, then claim due ingestion steps with SKIP LOCKED. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { deps, db } = build(env, (p) => ctx.waitUntil(p));
    if (!db || !deps.bucket || !deps.gemini || !deps.embedder) {
      console.warn('cron: bindings or secrets missing; queue not processed');
      await db?.close();
      return;
    }
    const ingest = { db, bucket: deps.bucket, gemini: deps.gemini, embedder: deps.embedder, settings: deps.settings };
    try {
      await sweepExhausted(db);
      await expireUploads(db);
      // Leave margin under the 15-minute cron wall-clock limit.
      const outcomes = await drain(ingest, { maxSteps: deps.settings.stepsPerTick, deadlineMs: 10 * 60 * 1000 });
      if (outcomes.length < deps.settings.stepsPerTick) await backfillEmbeddings(db, deps.embedder, 2);
      if (outcomes.length) console.log('cron steps', outcomes.join(' '));
    } finally {
      await db.close();
    }
  },
};
