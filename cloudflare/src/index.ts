import { handle } from './api';
import { build } from './consumer';
import { Env } from './env';

export { build, runDueJobs } from './consumer';
export { FramerScheduler } from './scheduler';

/**
 * HTTP only. There is no cron: the FramerScheduler Durable Object's alarm runs
 * the queue, woken by the API when work is created (src/scheduler.ts).
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, build(env, (p) => ctx.waitUntil(p)));
  },
};
