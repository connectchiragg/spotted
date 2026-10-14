import { handle } from './api';
import { build } from './deps';
import { Env } from './env';

export { build } from './deps';
export { VideoDO } from './video';

/**
 * HTTP only. Each video's ingestion runs in its own VideoDO (actor per video),
 * driven by that object's alarm; there is no cron, queue or scheduler.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, build(env, (p) => ctx.waitUntil(p)));
  },
};
