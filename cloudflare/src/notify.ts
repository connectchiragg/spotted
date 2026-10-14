/**
 * Publishing ingestion events to a video's VideoEvents Durable Object (src/events.ts).
 * Callers publish only after a fenced D1 commit returned true, so no event ever
 * describes a write that a stale lease holder attempted.
 */
import { videoState } from './api';
import { getVideo } from './store';

export type EventType = 'status' | 'step' | 'progress' | 'done' | 'failed';
export const TERMINAL: Record<string, EventType> = { completed: 'done', failed: 'failed' };

export type Notifier = (videoId: string, type: EventType, extra?: Record<string, unknown>) => Promise<void>;

interface EventsStub { publish(type: EventType, data: unknown): Promise<number> }

export const eventsStub = (ns: DurableObjectNamespace, videoId: string) =>
  ns.get(ns.idFromName(videoId)) as unknown as EventsStub;

/** Read the committed video state from D1 and push it; advisory (errors are logged). */
export function videoNotifier(ns: DurableObjectNamespace | undefined | null, db: D1Database): Notifier | undefined {
  if (!ns) return undefined;
  return async (videoId, type, extra = {}) => {
    try {
      const video = await getVideo(db, videoId);
      if (!video) return;
      await eventsStub(ns, videoId).publish(type, { ...videoState(video), ...extra });
    } catch (error) {
      console.warn('event publish failed', videoId, type, (error as Error)?.message);
    }
  };
}
