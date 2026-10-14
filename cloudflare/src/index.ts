import { AppDeps, handle } from './api';
import { Env, settings } from './env';
import { Gemini } from './gemini';
import { drain } from './ingest';
import { purgeFinished } from './queue';
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
    waitUntil,
  };
}

/**
 * The queue consumer, independent of what woke it. D1 stays the source of truth:
 * this claims and processes due jobs until none are due or the budget runs out,
 * so it is safe to call from any trigger, as often as wanted, concurrently.
 *   - today: the per-minute cron (`scheduled` below);
 *   - option under consideration: R2 event notifications -> Cloudflare Queues as a
 *     wake-up signal. A `queue(batch, env, ctx)` handler would ack the messages and
 *     call runDueJobs(env, ctx); the cron would stay as a slower sweeper for
 *     expired leases, retries and housekeeping. Messages carry no job state.
 */
export async function runDueJobs(env: Env, ctx: ExecutionContext): Promise<string[]> {
  const deps = build(env, (p) => ctx.waitUntil(p));
  if (!deps.db) return [];
  await expireUploads(deps.db);
  await purgeFinished(deps.db);
  if (!deps.bucket || !deps.index || !deps.gemini || !deps.embedder) {
    console.warn('consumer: R2, Vectorize, Workers AI or GEMINI_API_KEY missing; queue not processed');
    return [];
  }
  const outcomes = await drain(
    { db: deps.db, bucket: deps.bucket, index: deps.index, gemini: deps.gemini, embedder: deps.embedder, settings: deps.settings },
    // Cron wall-clock limit is 15 min; CPU (10 ms on Free) is not measurable in Workers, so cap steps.
    { maxSteps: deps.settings.stepsPerTick, deadlineMs: 10 * 60 * 1000 },
  );
  if (outcomes.length) console.log('consumer steps', outcomes.join(' '));
  return outcomes;
}

/** Back-compatible name for the cron entry point. */
export const runCron = runDueJobs;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, build(env, (p) => ctx.waitUntil(p)));
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runDueJobs(env, ctx);
  },
};
