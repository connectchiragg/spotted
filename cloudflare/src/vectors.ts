/**
 * Workers AI embeddings (default @cf/baai/bge-small-en-v1.5, 384 dims) stored in
 * one Vectorize index (cosine). Vector ids encode what they describe:
 *   v:<video id>            "Tags: ... Summary: ..." document      (kind=video)
 *   f:<video id>:<index>    one moment/frame description            (kind=frame)
 *   d:<video id>            mean of summary + descriptions, for the
 *                           advisory duplicate check                 (kind=description)
 * Metadata indexes on `kind` and `video_id` (created with the index) allow filtering.
 * EC2 vectors (FastEmbed) are NOT migrated: every video is re-embedded here.
 */
export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

const BATCH = 50;

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

export function documentText(result: any): string {
  const labels = (result.tags ?? []).map((t: any) => t.label).join(', ');
  return `Tags: ${labels}. Summary: ${result.summary}`;
}

function meanNormalized(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const mean = Array.from({ length: dim }, (_, i) => vectors.reduce((s, v) => s + v[i], 0) / vectors.length);
  const norm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0));
  return norm ? mean.map((x) => x / norm) : mean;
}

/** Embed a completed result with one Workers AI call and upsert its vectors. Returns the duplicate vector. */
export async function indexResult(index: VectorizeIndex, embedder: Embedder, videoId: string, result: any): Promise<number[]> {
  const frames: { frame_index: number; description: string }[] = result.frame_descriptions ?? [];
  const vectors = await embedder.embed([documentText(result), result.summary, ...frames.map((f) => f.description)]);
  const [doc, summary, ...frameVectors] = vectors;
  const description = meanNormalized([summary, ...frameVectors]);
  const model = embedder.model;
  await index.upsert([
    { id: `v:${videoId}`, values: doc, metadata: { kind: 'video', video_id: videoId, model } },
    ...frames.map((f, i) => ({ id: `f:${videoId}:${f.frame_index}`, values: frameVectors[i], metadata: { kind: 'frame', video_id: videoId, model } })),
    { id: `d:${videoId}`, values: description, metadata: { kind: 'description', video_id: videoId, model } },
  ]);
  return description;
}

export function frameKey(vectorId: string): [string, number] | null {
  const m = /^f:(.+):(\d+)$/.exec(vectorId);
  return m ? [m[1], Number(m[2])] : null;
}

/** Nearest videos by document vector: videoId -> cosine score. */
export async function nearestVideos(index: VectorizeIndex, vector: number[], topK = 50): Promise<Map<string, number>> {
  const { matches } = await index.query(vector, { topK, filter: { kind: 'video' } });
  return new Map(matches.map((m) => [m.id.slice(2), m.score]));
}

/** Frame scores for candidate videos, keyed "<video id>\0<frame index>". Unreturned frames score 0. */
export async function frameScores(index: VectorizeIndex, vector: number[], videoIds: string[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!videoIds.length) return scores;
  const { matches } = await index.query(vector, { topK: 100, filter: { kind: 'frame', video_id: { $in: videoIds.slice(0, 50) } } });
  for (const m of matches) {
    const key = frameKey(m.id);
    if (key) scores.set(`${key[0]}\u0000${key[1]}`, m.score);
  }
  return scores;
}

/** Advisory duplicate candidates (never merges or deletes), best first. */
export async function duplicateCandidates(index: VectorizeIndex, vector: number[], videoId: string, threshold: number) {
  const { matches } = await index.query(vector, { topK: 10, filter: { kind: 'description' } });
  return matches
    .map((m) => ({ id: m.id.slice(2), similarity: m.score }))
    .filter((m) => m.id !== videoId && m.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? 1 : -1));
}
