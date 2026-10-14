/**
 * Workers AI text embeddings (default @cf/baai/bge-small-en-v1.5, 384 dims).
 * Vectors are stored under the Workers AI model name, so they never mix with
 * the FastEmbed vectors migrated from EC2 ('BAAI/bge-small-en-v1.5').
 */
import { Db, vectorLiteral } from './db';
import { Job } from './store';

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

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function meanNormalized(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const mean = Array.from({ length: dim }, (_, i) => vectors.reduce((s, v) => s + v[i], 0) / vectors.length);
  const norm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0));
  return norm ? mean.map((x) => x / norm) : mean;
}

/**
 * Embed a completed result: video document, each frame/moment description, and
 * the advisory duplicate-detection vector (mean of summary + descriptions).
 * One Workers AI call for all texts. Returns the duplicate vector.
 */
export async function indexResult(db: Db, embedder: Embedder, jobId: string, result: any): Promise<number[]> {
  const doc = documentText(result);
  const frames: { frame_index: number; description: string }[] = result.frame_descriptions ?? [];
  const parts = [result.summary, ...frames.map((f) => f.description)];
  const vectors = await embedder.embed([doc, ...parts]);
  const [docVector, summaryVector, ...frameVectors] = vectors;
  await db.query(
    `INSERT INTO embeddings (job_id, model, text_hash, vector) VALUES ($1,$2,$3,$4::vector)
     ON CONFLICT (job_id, model) DO UPDATE SET text_hash=excluded.text_hash, vector=excluded.vector`,
    [jobId, embedder.model, await sha256(doc), vectorLiteral(docVector)],
  );
  for (const [i, frame] of frames.entries()) {
    await db.query(
      `INSERT INTO frame_embeddings (job_id, frame_index, model, text_hash, vector) VALUES ($1,$2,$3,$4,$5::vector)
       ON CONFLICT (job_id, frame_index, model) DO UPDATE SET text_hash=excluded.text_hash, vector=excluded.vector`,
      [jobId, frame.frame_index, embedder.model, await sha256(frame.description), vectorLiteral(frameVectors[i])],
    );
  }
  const description = meanNormalized([summaryVector, ...frameVectors]);
  await db.query(
    `INSERT INTO embeddings (job_id, model, text_hash, vector) VALUES ($1,$2,$3,$4::vector)
     ON CONFLICT (job_id, model) DO UPDATE SET text_hash=excluded.text_hash, vector=excluded.vector`,
    [jobId, 'description:' + embedder.model, await sha256(JSON.stringify(parts)), vectorLiteral(description)],
  );
  return description;
}

/** Advisory duplicate check against other active completed videos (never merges or deletes). */
export async function possibleDuplicate(db: Db, model: string, jobId: string, vector: number[], threshold: number) {
  const rows = await db.query(
    `SELECT j.id, j.filename, j.display_name, 1 - (e.vector <=> $1::vector) AS similarity
     FROM embeddings e JOIN jobs j ON j.id = e.job_id
     WHERE e.model = $2 AND j.id <> $3 AND j.status = 'completed' AND j.archived_at IS NULL
     ORDER BY similarity DESC, j.id DESC LIMIT 1`,
    [vectorLiteral(vector), 'description:' + model, jobId],
  );
  const best = rows[0];
  if (!best || Number(best.similarity) < threshold) return null;
  return { request_id: best.id, filename: best.filename, display_name: best.display_name, similarity: Math.round(Number(best.similarity) * 1e4) / 1e4 };
}

/**
 * Re-embedding backfill: completed videos with no vectors for the current model
 * (e.g. migrated from EC2) are embedded a few at a time by the cron consumer.
 */
export async function backfillEmbeddings(db: Db, embedder: Embedder, limit = 3): Promise<number> {
  const rows = await db.query<Job>(
    `SELECT j.id, j.result FROM jobs j WHERE j.status='completed' AND j.result IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.job_id=j.id AND e.model=$1)
     ORDER BY j.created_at DESC LIMIT $2`,
    [embedder.model, limit],
  );
  for (const row of rows) {
    const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    await indexResult(db, embedder, row.id, result);
  }
  return rows.length;
}
