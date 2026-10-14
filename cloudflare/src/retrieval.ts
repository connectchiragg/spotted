/**
 * Port of app/retrieval.py hybrid_search. Scoring is identical; the difference is
 * the candidate set: Vectorize returns the CANDIDATE_LIMIT nearest videos plus any
 * video whose tag labels contain a query word, instead of scanning every video
 * in the Worker (Workers Free allows 10 ms CPU per request).
 */
import { getVideos, Video as Job } from './store';
import { documentText, frameScores, nearestVideos } from './vectors';

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

export interface SearchDeps {
  db: D1Database;
  index: VectorizeIndex;
}

/**
 * Candidates = the CANDIDATE_LIMIT nearest video vectors from Vectorize plus any
 * active video whose tag labels contain a query word (D1), then the same ranking
 * as the Python version. Keyword-only candidates have semantic score 0, so they
 * qualify only through explicit tag evidence, as before.
 */
export async function hybridSearch(deps: SearchDeps, queryVector: number[], query: string, minSimilarity: number): Promise<Ranked[]> {
  const nearest = await nearestVideos(deps.index, queryVector, CANDIDATE_LIMIT);
  const words = [...tokens(query)];
  let keywordIds: string[] = [];
  if (words.length) {
    const { results } = await deps.db.prepare(
      `SELECT DISTINCT v.id FROM videos v, json_each(v.result, '$.tags') t, json_each(?1) w
       WHERE v.status='completed' AND v.archived_at IS NULL
         AND lower(json_extract(t.value, '$.label')) LIKE '%' || w.value || '%'
       LIMIT ?2`,
    ).bind(JSON.stringify(words), CANDIDATE_LIMIT).all<{ id: string }>();
    keywordIds = results.map((r) => r.id);
  }
  const ids = [...new Set([...nearest.keys(), ...keywordIds])];
  const videos = (await getVideos(deps.db, ids)).filter((v) => v.status === 'completed' && !v.archived_at && v.result);
  if (!videos.length) return [];
  const scores = await frameScores(deps.index, queryVector, videos.map((v) => v.id));
  return rank(query, videos.map((job) => ({ job, semantic: nearest.get(job.id) ?? 0 })), scores, minSimilarity);
}
