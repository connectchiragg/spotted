/**
 * Server-Sent Events for ingestion progress (owner design): one SQLite-backed
 * Durable Object per video (`VIDEO_EVENTS.idFromName(video_id)`) holds that
 * video's open SSE connections and pushes events to them.
 *
 * Why one object per video, not the scheduler object: an open SSE stream keeps
 * its object awake (hibernation exists for WebSockets only), so streams on the
 * global scheduler would keep it, and its alarm loop, busy for every viewer of
 * every video. Per-video objects isolate traffic, shut down when their video's
 * streams close, and need no routing table.
 *
 * Flow:
 *   GET /videos/:id/events (API Worker) reads the video from D1 and forwards the
 *   snapshot to this object, which answers with the text/event-stream.
 *   After every COMMITTED fenced state change (step done, retry scheduled, dead,
 *   completed; upload confirmed), the writer calls publish(). A write whose
 *   fence failed never publishes (callers check commit()'s result first).
 *
 * Every event is stored (seq = event id) so `Last-Event-ID` resumes by replay.
 * Streams get a `: ping` comment every PING_MS, close on done/failed, and close
 * after MAX_STREAM_MS so EventSource reconnects (with a `retry:` hint).
 * After a day without streams the object deletes its storage.
 */
import { DurableObject } from 'cloudflare:workers';
import { Env } from './env';

import { EventType, TERMINAL } from './notify';

const DEFAULT_PING_MS = 20_000; // within the 15-30 s asked for; proxies drop idle streams after ~100 s
const DEFAULT_MAX_STREAM_MS = 5 * 60_000;
const RETRY_MS = 3_000;
const KEEP_EVENTS = 200;
const MAX_BACKLOG = 32; // unread chunks before a stalled client is dropped
const CLEANUP_AFTER_MS = 24 * 3600_000;

const encoder = new TextEncoder();
export const frame = (id: number, type: EventType, data: unknown) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

interface Client {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  lifetime: ReturnType<typeof setTimeout>;
}

export class VideoEvents extends DurableObject<Env> {
  clients = new Map<number, Client>();
  private nextClient = 0;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.createTable();
  }

  private createTable() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL)`);
  }

  private get pingMs() { return Number(this.env.SSE_PING_MS) || DEFAULT_PING_MS; }
  private get maxStreamMs() { return Number(this.env.SSE_MAX_STREAM_MS) || DEFAULT_MAX_STREAM_MS; }

  private currentSeq(): number {
    return (this.ctx.storage.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM events').one().s as number) ?? 0;
  }

  /** Connect: POST body = the D1 snapshot of the video; header Last-Event-ID resumes. */
  async fetch(request: Request): Promise<Response> {
    const snapshot = await request.json<Record<string, any>>();
    const lastHeader = request.headers.get('last-event-id');
    const last = lastHeader !== null && /^\d+$/.test(lastHeader) ? Number(lastHeader) : null;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    let out = `retry: ${RETRY_MS}\n\n`;
    const current = this.currentSeq();
    if (last !== null && last < current) {
      for (const row of this.ctx.storage.sql.exec('SELECT seq, type, data FROM events WHERE seq > ?1 ORDER BY seq', last)) {
        out += `id: ${row.seq}\nevent: ${row.type}\ndata: ${row.data}\n\n`;
      }
    }
    out += frame(current, 'status', snapshot);
    const terminal = TERMINAL[snapshot.status];
    if (terminal) out += frame(current, terminal, snapshot);
    writer.write(encoder.encode(out)).catch(() => {});
    if (terminal) {
      writer.close().catch(() => {}); // finished videos hold no connections
    } else {
      const id = ++this.nextClient;
      const lifetime = setTimeout(() => this.drop(id, true), this.maxStreamMs);
      this.clients.set(id, { writer, lifetime });
      writer.closed.catch(() => this.drop(id, false)); // client went away (stream cancelled)
      request.signal?.addEventListener('abort', () => this.drop(id, false)); // ... or the request was aborted
      this.startPing();
    }
    return new Response(readable, { headers: sseHeaders });
  }

  /** Store and push one event; done/failed close every stream. Returns the event id. */
  async publish(type: EventType, data: unknown): Promise<number> {
    const seq = this.ctx.storage.sql.exec('INSERT INTO events (type, data, at) VALUES (?1, ?2, ?3) RETURNING seq',
      type, JSON.stringify(data), Date.now()).one().seq as number;
    this.ctx.storage.sql.exec('DELETE FROM events WHERE seq <= ?1', seq - KEEP_EVENTS);
    this.broadcast(frame(seq, type, data));
    if (type === 'done' || type === 'failed') for (const id of [...this.clients.keys()]) this.drop(id, true);
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_AFTER_MS);
    return seq;
  }

  /**
   * Never awaits the writes: a write resolves only once that client reads it, and a
   * slow client must not block the publisher (an ingestion step). A client that
   * falls MAX_BACKLOG chunks behind is dropped; a failed write (client gone) drops it too.
   */
  private broadcast(text: string) {
    const bytes = encoder.encode(text);
    for (const [id, c] of this.clients) {
      if ((c.writer.desiredSize ?? 0) < -MAX_BACKLOG) {
        this.drop(id, false);
        continue;
      }
      c.writer.write(bytes).catch(() => this.drop(id, false));
    }
  }

  private startPing() {
    if (this.ping) return;
    this.ping = setInterval(() => this.broadcast(': ping\n\n'), this.pingMs);
  }

  private drop(id: number, close: boolean) {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    clearTimeout(client.lifetime);
    if (close) client.writer.close().catch(() => {});
    else client.writer.abort().catch(() => {});
    if (!this.clients.size && this.ping) {
      clearInterval(this.ping);
      this.ping = null;
    }
  }

  /** A day after the last event, with no stream open, forget the event log. */
  async alarm() {
    if (this.clients.size) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_AFTER_MS);
    else {
      await this.ctx.storage.deleteAll();
      this.createTable();
    }
  }

  /** Test/debug helper. */
  async clientCount(): Promise<number> {
    return this.clients.size;
  }
}

export const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Accel-Buffering': 'no',
};
