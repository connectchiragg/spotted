/**
 * Workers AI embeddings (default @cf/baai/bge-m3, 1024 dims, 1,075 neurons per M tokens) in
 * the Vectorize index `framer-cf-m3` (cosine; metadata indexes on `kind` and `video_id`).
 * Three kinds of entry per video; the vector id encodes what it points at, so search needs
 * no metadata round trip (topK can stay at 100):
 *   s:<video>          kind=summary     summary + tags + the start of the transcript
 *   t:<video>:<n>      kind=transcript  a 45 s transcript window (15 s overlap)
 *   f:<video>:<i>      kind=frame       one selected frame's description
 * Every vector also carries {video_id, kind, t_start, t_end, source, source_id, thumb_key}.
 */
import { Segment } from './gemini';

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

const BATCH = 32;
export const WINDOW_S = 45;
export const WINDOW_STEP_S = 30;
export const MAX_TRANSCRIPT_WINDOWS = 40;

export function workersAiEmbedder(ai: Ai, model: string): Embedder {
  return {
    model,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const response: any = await ai.run(model as any, { text: texts.slice(i, i + BATCH) } as any);
        const data: number[][] = response?.data;
        if (!Array.isArray(data) || data.length !== Math.min(BATCH, texts.length - i)) {
          throw new Error('Embedding model returned an unexpected number of vectors');
        }
        out.push(...data);
      }
      for (const v of out) if (!v.length || !v.every(Number.isFinite)) throw new Error('Embedding model returned an invalid vector');
      return out;
    },
  };
}

export interface TranscriptWindow { start: number; end: number; text: string }

/** 45 s windows every 30 s over the transcript segments (empty windows dropped). */
export function transcriptWindows(segments: Segment[], duration: number): TranscriptWindow[] {
  if (!segments.length) return [];
  const end = Math.max(duration, ...segments.map((s) => s.end));
  const out: TranscriptWindow[] = [];
  for (let start = 0; start < end && out.length < MAX_TRANSCRIPT_WINDOWS; start += WINDOW_STEP_S) {
    const stop = Math.min(end, start + WINDOW_S);
    const text = segments.filter((s) => s.end > start && s.start < stop).map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text) out.push({ start, end: Math.round(stop * 10) / 10, text: text.slice(0, 4000) });
    if (stop >= end) break;
  }
  return out;
}

export function summaryText(result: any): string {
  const labels = (result.tags ?? []).map((t: any) => t.label).join(', ');
  const speech = (result.transcript ?? []).map((s: Segment) => s.text).join(' ').slice(0, 1200);
  return `Summary: ${result.summary}\nTags: ${labels}${speech ? `\nSpeech: ${speech}` : ''}`;
}

/** R2 key of frame i's stored JPEG (also its thumbnail). Outside videos/, so the 7-day lifecycle rule for originals keeps it. */
export const thumbKey = (videoId: string, i: number) => `thumbs/${videoId}/${i}.jpg`;

export function vectorIdsOf(videoId: string): string[] {
  return [`s:${videoId}`, ...Array.from({ length: MAX_TRANSCRIPT_WINDOWS }, (_, n) => `t:${videoId}:${n}`), ...Array.from({ length: 40 }, (_, i) => `f:${videoId}:${i}`)];
}

export function nearestFrame(times: number[], t: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < times.length; i++) if (best === null || Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
  return best;
}

/** Embed a completed result and upsert its vectors. Returns the summary vector (duplicate check). */
export async function indexResult(index: VectorizeIndex, embedder: Embedder, video: { id: string; source?: string; source_id?: string | null }, result: any): Promise<number[]> {
  const frames: { frame_index: number; description: string }[] = result.frame_descriptions ?? [];
  const times: number[] = result.sampled_timestamps ?? [];
  const windows: TranscriptWindow[] = result.transcript_windows ?? [];
  const vectors = await embedder.embed([summaryText(result), ...windows.map((w) => w.text), ...frames.map((f) => f.description)]);
  const base = { video_id: video.id, source: video.source ?? 'upload', source_id: video.source_id ?? '', model: embedder.model };
  const thumb = (i: number | null) => (i !== null && (result.thumbs ?? []).includes(i) ? thumbKey(video.id, i) : '');
  const duration = Number(result.duration_seconds) || 0;
  await index.upsert([
    { id: `s:${video.id}`, values: vectors[0], metadata: { ...base, kind: 'summary', t_start: 0, t_end: duration, thumb_key: thumb(0) } },
    ...windows.map((w, n) => ({ id: `t:${video.id}:${n}`, values: vectors[1 + n],
      metadata: { ...base, kind: 'transcript', t_start: w.start, t_end: w.end, thumb_key: thumb(nearestFrame(times, w.start)) } })),
    ...frames.map((f, k) => ({ id: `f:${video.id}:${f.frame_index}`, values: vectors[1 + windows.length + k],
      metadata: { ...base, kind: 'frame', t_start: times[f.frame_index] ?? 0, t_end: times[f.frame_index] ?? 0, thumb_key: thumb(f.frame_index) } })),
  ]);
  // Remove leftovers of an earlier, larger index of the same video.
  const stale = vectorIdsOf(video.id).filter((id) => {
    const m = /^([tf]):.+:(\d+)$/.exec(id);
    if (!m) return false;
    const n = Number(m[2]);
    return m[1] === 't' ? n >= windows.length : !frames.some((f) => f.frame_index === n);
  });
  if (stale.length) await index.deleteByIds(stale);
  return vectors[0];
}

/** "s:<id>" | "t:<id>:<n>" | "f:<id>:<i>" -> parts. */
export function parseVectorId(id: string): { kind: 'summary' | 'transcript' | 'frame'; videoId: string; n: number } | null {
  let m = /^s:(.+)$/.exec(id);
  if (m) return { kind: 'summary', videoId: m[1], n: 0 };
  m = /^([tf]):(.+):(\d+)$/.exec(id);
  if (m) return { kind: m[1] === 't' ? 'transcript' : 'frame', videoId: m[2], n: Number(m[3]) };
  return null;
}

/** Advisory duplicate candidates by summary vector (never merges or deletes), best first. */
export async function duplicateCandidates(index: VectorizeIndex, vector: number[], videoId: string, threshold: number) {
  const { matches } = await index.query(vector, { topK: 10, filter: { kind: 'summary' } });
  return matches
    .map((m) => ({ id: m.id.slice(2), similarity: m.score }))
    .filter((m) => m.id !== videoId && m.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? 1 : -1));
}
