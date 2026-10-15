/**
 * Media Transformations through the Workers Media binding (`"media": {"binding": "MEDIA"}`),
 * which takes the video as a ReadableStream straight from R2: no public origin and no
 * Cloudflare Access in the way. Each call re-reads the R2 object (an input stream cannot be
 * reused). Limits (developers.cloudflare.com/stream/transform-videos): input < 100 MB and
 * <= 10 min; spritesheet and audio cover at most 60 s per call; width/height 10-2000 px.
 * Verified live on this account (2026-10-15): spritesheets stack tiles vertically
 * (15 tiles of 64x36 -> a 64x540 JPEG); a seek past the end fails with 9401.
 *
 * Also Whisper (Workers AI @cf/openai/whisper-large-v3-turbo), which accepts an MP4 video or
 * an M4A directly as { body, contentType } and returns segments with timestamps.
 */
import { Segment } from './gemini';

export interface MediaPort {
  spritesheet(key: string, opts: { time: number; duration: number; count: number; width: number; height: number }): Promise<Uint8Array>;
  frame(key: string, opts: { time: number; maxSide: number }): Promise<Uint8Array>;
  audio(key: string, opts: { time: number; duration: number }): Promise<Uint8Array>;
}

export class MediaError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
  }
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const secs = (t: number) => `${Math.max(0, Math.round(t * 1000) / 1000)}s`;

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** MEDIA_TRANSFORMATION_ERROR 9xxx: input/parameter problems are permanent, the rest retry. */
function wrap(error: unknown, what: string): MediaError {
  const message = String((error as Error)?.message ?? error);
  const code = /\b(9\d{3})\b/.exec(message)?.[1];
  const permanent = code !== undefined && ['9401', '9402', '9403', '9406', '9407', '9408', '9409'].includes(code);
  console.warn('media transformation failed', what, message.slice(0, 200));
  return new MediaError(`${what} failed${code ? ` (${code})` : ''}: ${message.split('\n')[0].slice(0, 160)}`, !permanent);
}

export function mediaBinding(media: any, bucket: R2Bucket): MediaPort {
  const source = async (key: string) => {
    const object = await bucket.get(key);
    if (!object) throw new MediaError('Stored video is missing', false);
    return object.body;
  };
  return {
    async spritesheet(key, o) {
      try {
        const out = media.input(await source(key)).transform({ width: o.width, height: o.height, fit: 'contain' })
          .output({ mode: 'spritesheet', time: secs(o.time), duration: secs(o.duration), imageCount: o.count });
        return await bytes(await out.media());
      } catch (e) { throw e instanceof MediaError ? e : wrap(e, 'Spritesheet'); }
    },
    async frame(key, o) {
      try {
        const out = media.input(await source(key)).transform({ width: o.maxSide, height: o.maxSide, fit: 'scale-down' })
          .output({ mode: 'frame', time: secs(o.time), format: 'jpg' });
        return await bytes(await out.media());
      } catch (e) { throw e instanceof MediaError ? e : wrap(e, 'Frame'); }
    },
    async audio(key, o) {
      try {
        const out = media.input(await source(key)).output({ mode: 'audio', time: secs(o.time), duration: secs(o.duration), format: 'm4a' });
        return await bytes(await out.media());
      } catch (e) { throw e instanceof MediaError ? e : wrap(e, 'Audio'); }
    },
  };
}

export interface Transcriber {
  model: string;
  /** Segments with times relative to the given audio; [] when there is no speech. */
  transcribe(audio: ReadableStream<Uint8Array> | Uint8Array, contentType: string): Promise<Segment[]>;
}

export function workersAiWhisper(ai: Ai, model: string): Transcriber {
  return {
    model,
    async transcribe(audio, contentType) {
      // Verified live (2026-10-15): an MP4 *video* is accepted only as base64, an M4A also as
      // { body, contentType }; a video without an audio track fails with 3030.
      const input = audio instanceof Uint8Array ? { audio: base64(audio) } : { audio: { body: audio, contentType } };
      let out: any;
      try {
        out = await ai.run(model as any, { ...input, vad_filter: true, condition_on_previous_text: false } as any);
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        // A video without an audio track, or pure silence, is not an error for Framer.
        if (/\b3030\b|decode audio|no audio|audio stream|empty/i.test(message)) return [];
        if (/429|capacity|rate|neuron/i.test(message)) throw Object.assign(new MediaError('Transcription quota or capacity reached; retrying later'), { quota: true });
        throw new MediaError(`Transcription failed: ${message.slice(0, 160)}`);
      }
      return (out?.segments ?? []).map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? '').trim() }))
        .filter((s: Segment) => s.text);
    },
  };
}
