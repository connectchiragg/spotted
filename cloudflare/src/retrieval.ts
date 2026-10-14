/**
 * Port of app/retrieval.py hybrid_search. Scoring is identical; the difference is
 * the candidate set: pgvector returns the CANDIDATE_LIMIT nearest videos plus any
 * video whose tag labels contain a query word, instead of scanning every video
 * in the Worker (Workers Free allows 10 ms CPU per request).
 */
import { Db, vectorLiteral } from './db';
import { documentText } from './embeddings';
import { decode, Job } from './store';

const STOPWORDS = new Set('a an the and or of in on at to for is are was were with me show find video videos someone person people doing up'.split(' '));
export const CANDIDATE_LIMIT = 50;

export function normalizeQuery(text: string): string {
  text = text.replace(/^\s*(?:please\s+)?(?:i (?:want|would like) to (?:see|find)|(?:can|could) you (?:show|find)(?: me)?|show me|find me)\s+/i, '');
  return text.replace(/\s+in action[.!?]*\s*$/i, '').trim();
}

export function tokens(text: string): Set<string> {
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => !STOPWORDS.has(w)));
  return new Set([...words].map((w) => (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w)));
}

function isSubset(a: Set<string>, b: Set<string>) {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function overlap(a: Set<string>, b: Set<string>) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

export function fullKeywordMatch(queryTokens: Set<string>, text: string): boolean {
  return queryTokens.size > 0 && isSubset(queryTokens, tokens(text));
}

export interface Citation {
  frame_index: number;
  timestamp_seconds: number;
  label: string;
  description: string;
  source: string;
  image_url: string | null;
}

/** Stored JPEG exists only for videos ingested on EC2 (result.frame_indices). */
export function imageUrl(job: Job, index: number): string | null {
  const stored: number[] = job.result?.frame_indices ?? job.result?.preview_indices ?? [];
  return stored.includes(index) ? `/videos/${job.id}/frames/${index}` : null;
}

type FrameScores = Map<string, number>;
const key = (id: string, index: number) => `${id}\u0000${index}`;

export function frameCitation(job: Job, queryTokens: Set<string>, scores: FrameScores): [Citation | null, number] {
  const timestamps: number[] = job.result.sampled_timestamps ?? [];
  let best: [number, number, number, string] | null = null;
  for (const frame of job.result.frame_descriptions ?? []) {
    const index = frame.frame_index;
    if (!(index >= 0 && index < timestamps.length)) continue;
    const semantic = scores.get(key(job.id, index)) ?? 0;
    const lexical = overlap(tokens(frame.description), queryTokens) / Math.max(1, queryTokens.size);
    const combined = 0.85 * semantic + 0.15 * lexical;
    if (!best || combined > best[0] || (combined === best[0] && index < best[2])) best = [combined, semantic, index, frame.description];
  }
  if (!best) return [null, 0];
  const [, semantic, index, description] = best;
  return [{ frame_index: index, timestamp_seconds: timestamps[index], label: description, description,
    source: 'model-described sampled frame', image_url: imageUrl(job, index) }, semantic];
}

export function taggedFrameCitation(job: Job, queryTokens: Set<string>): Citation | null {
  if (!queryTokens.size) return null;
  const timestamps: number[] = job.result.sampled_timestamps ?? [];
  const byFrame = new Map<number, string[]>();
  for (const tag of job.result.tags ?? []) {
    if (!overlap(tokens(tag.label), queryTokens)) continue;
    for (const index of tag.frame_indices ?? []) {
      if (Number.isInteger(index) && index >= 0 && index < timestamps.length) {
        if (!byFrame.has(index)) byFrame.set(index, []);
        byFrame.get(index)!.push(tag.label);
      }
    }
  }
  for (const index of [...byFrame.keys()].sort((a, b) => a - b)) {
    const label = byFrame.get(index)!.join(', ');
    if (fullKeywordMatch(queryTokens, label)) {
      return { frame_index: index, timestamp_seconds: timestamps[index], label,
        description: 'Tags attributed to this frame: ' + label, source: 'model-attributed sampled frame', image_url: imageUrl(job, index) };
    }
  }
  return null;
}

export interface Candidate { job: Job; semantic: number }
export interface Ranked { job: Job; retrieval: Record<string, any> }

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Pure ranking step (unit-tested): same thresholds and rerank as the Python version. */
export function rank(query: string, candidates: Candidate[], frameScores: FrameScores, minSimilarity: number): Ranked[] {
  const queryTokens = tokens(query);
  const kept: [Job, number, number, Citation, number][] = [];
  for (const { job, semantic: raw } of candidates) {
    const semantic = Math.max(0, Math.min(1, raw));
    const tagText = (job.result.tags ?? []).map((t: any) => t.label).join(' ');
    const lexical = overlap(queryTokens, tokens(documentText(job.result))) / Math.max(1, queryTokens.size);
    let [evidence, frameScore] = frameCitation(job, queryTokens, frameScores);
    const tagged = taggedFrameCitation(job, queryTokens);
    if (tagged && (evidence === null || !fullKeywordMatch(queryTokens, evidence.description))) {
      evidence = tagged;
      frameScore = frameScores.get(key(job.id, tagged.frame_index)) ?? 0;
    }
    if (!evidence) continue;
    const joint = (semantic + frameScore) / 2;
    const supported = joint >= minSimilarity && Math.min(semantic, frameScore) >= Math.max(0, minSimilarity - 0.1);
    const explicit = tagged !== null || (fullKeywordMatch(queryTokens, tagText) && fullKeywordMatch(queryTokens, evidence.description));
    if (!(supported || explicit)) continue;
    kept.push([job, semantic, lexical, evidence, frameScore]);
  }
  const byId = (a: Job, b: Job) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const nearest = kept.sort((a, b) => b[1] - a[1] || byId(a[0], b[0])).slice(0, 3);
  const score = (k: (typeof kept)[number]) => 0.75 * k[1] + 0.25 * k[2];
  let ranked = nearest.sort((a, b) => score(b) - score(a) || byId(a[0], b[0]));
  if (ranked.length) {
    const best = score(ranked[0]);
    ranked = ranked.filter((k) => score(k) >= 0.8 * best);
  }
  return ranked.map(([job, semantic, lexical, evidence, frameScore]) => ({
    job,
    retrieval: { score: round4(0.75 * semantic + 0.25 * lexical), semantic_score: round4(semantic), keyword_score: round4(lexical),
      frame_score: round4(frameScore), citation: evidence },
  }));
}

export async function hybridSearch(db: Db, model: string, queryVector: number[], query: string, minSimilarity: number): Promise<Ranked[]> {
  const words = [...tokens(query)];
  const literal = vectorLiteral(queryVector);
  const rows = await db.query(
    `WITH nearest AS (
       SELECT e.job_id, 1 - (e.vector <=> $1::vector) AS score FROM embeddings e
       JOIN jobs j ON j.id = e.job_id AND j.status='completed' AND j.archived_at IS NULL
       WHERE e.model = $2 ORDER BY e.vector <=> $1::vector LIMIT $3),
     keyword AS (
       SELECT j.id AS job_id FROM jobs j
       WHERE j.status='completed' AND j.archived_at IS NULL AND jsonb_array_length($4::text::jsonb) > 0
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.result->'tags') t, jsonb_array_elements_text($4::text::jsonb) w
                     WHERE lower(t->>'label') LIKE '%' || w || '%')
       LIMIT $3)
     SELECT j.*, COALESCE(n.score, 1 - (e.vector <=> $1::vector), 0) AS semantic_score
     FROM jobs j
     LEFT JOIN nearest n ON n.job_id = j.id
     LEFT JOIN embeddings e ON e.job_id = j.id AND e.model = $2
     WHERE j.id IN (SELECT job_id FROM nearest UNION SELECT job_id FROM keyword)`,
    [literal, model, CANDIDATE_LIMIT, JSON.stringify(words)],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const frames = await db.query(
    `SELECT job_id, frame_index, 1 - (vector <=> $1::vector) AS score FROM frame_embeddings
     WHERE model = $2 AND job_id IN (SELECT jsonb_array_elements_text($3::text::jsonb))`,
    [literal, model, JSON.stringify(ids)],
  );
  const frameScores: FrameScores = new Map(frames.map((f) => [key(f.job_id, f.frame_index), Number(f.score)]));
  const candidates = rows.map((r) => ({ job: decode(r)!, semantic: Number(r.semantic_score) }));
  return rank(normalizeQuery(query), candidates, frameScores, minSimilarity);
}
