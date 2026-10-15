/**
 * Search over all three kinds of vector (summary, transcript window, frame):
 *   1. embed the query (bge-m3) and take the 100 nearest vectors from Vectorize;
 *   2. group by video, keep each video's best few passages (top CANDIDATE_VIDEOS videos);
 *   3. rerank every kept passage against the query with a cross-encoder
 *      (@cf/baai/bge-reranker-base, 283 neurons per M tokens);
 *   4. a video's score is its best passage's rerank score. It is kept when its best cosine is within
 *      `vectorMargin` of the best video's, and either the rerank score >= minScore, or the rerank
 *      score >= softMinScore and the cosine >= minSimilarity; then within a fraction of the best,
 *      at most MAX_RESULTS. The best passage is the citation (timestamp + thumbnail).
 * Why two signals: bge-reranker-base scores a broad word against a specific description low
 * ("wildlife" vs a crocodile frame: 0.03; capitalised "Wildlife": 0.011), and sometimes scores
 * a wrong video high ("indian super league" vs another match: 0.33), so neither model's score
 * is a reliable cutoff on its own (docs/cloudflare-port.md §10.7).
 * Passage texts come from the D1 result JSON, so Vectorize stores no text. Frame and transcript
 * passages are reranked with the video's context in front (rerankText): alone, a frame such as
 * "players … embracing in a joyous celebration" scored 0.21 for "birthday party"; with
 * "Setting: soccer stadium. Video: … a soccer match …" in front it scores 0.0007.
 */
import { getVideos, Video as Job } from './store';
import { nearestFrame, parseVectorId } from './vectors';

export const CANDIDATE_VIDEOS = 10;
export const PASSAGES_PER_VIDEO = 4;
export const MAX_RESULTS = 3;
export const RELATIVE_CUTOFF = 0.25;
/** Cite the best frame or speech window over the summary when it scores at least this fraction of the best. */
export const MOMENT_CITE_FRACTION = 0.5;

export function normalizeQuery(text: string): string {
  text = text.replace(/^\s*(?:please\s+)?(?:i (?:want|would like) to (?:see|find)|(?:can|could) you (?:show|find)(?: me)?|show me|find me)\s+/i, '');
  // Lowercased: the reranker scores "Wildlife" a third of "wildlife", and bge-m3 shifts too.
  return text.replace(/\s+in action[.!?]*\s*$/i, '').trim().toLowerCase();
}

export interface Reranker {
  model: string;
  /** One relevance score per context, in the same order. */
  rerank(query: string, contexts: string[]): Promise<number[]>;
}

export function workersAiReranker(ai: Ai, model: string): Reranker {
  return {
    model,
    async rerank(query, contexts) {
      if (!contexts.length) return [];
      const out: any = await ai.run(model as any, { query, contexts: contexts.map((text) => ({ text: text.slice(0, 2000) })) } as any);
      const scores = new Array(contexts.length).fill(0);
      for (const r of out?.response ?? []) if (Number.isInteger(r?.id) && r.id < scores.length) scores[r.id] = Number(r.score) || 0;
      return scores;
    },
  };
}

export interface Citation {
  kind: 'summary' | 'transcript' | 'frame';
  frame_index: number;
  timestamp_seconds: number;
  t_end: number | null;
  label: string;
  description: string;
  source: string;
  image_url: string | null;
}

export interface Passage { kind: Citation['kind']; n: number; text: string; t: number; tEnd: number | null; frame: number | null; vectorScore: number }

/** The passage a vector id points at, from the video's stored result. */
export function passageOf(job: Job, kind: Citation['kind'], n: number, vectorScore: number): Passage | null {
  const r = job.result ?? {};
  const times: number[] = r.sampled_timestamps ?? [];
  if (kind === 'summary') return { kind, n, text: r.summary ?? '', t: 0, tEnd: null, frame: times.length ? 0 : null, vectorScore };
  if (kind === 'transcript') {
    const w = (r.transcript_windows ?? [])[n];
    return w ? { kind, n, text: `Speech: ${w.text}`, t: w.start, tEnd: w.end, frame: nearestFrame(times, w.start), vectorScore } : null;
  }
  const f = (r.frame_descriptions ?? []).find((x: any) => x.frame_index === n);
  return f ? { kind, n, text: f.description, t: times[n] ?? 0, tEnd: null, frame: n, vectorScore } : null;
}

const firstSentence = (text: string) => (/^.*?[.!?](?:\s|$)/s.exec(text)?.[0] ?? text).trim().slice(0, 200);

/** What the whole video is: its environment tags and the summary's first sentence. */
export function videoContext(job: Job): string {
  const r = job.result ?? {};
  const setting = (r.tags ?? []).filter((t: any) => t.category === 'environment').map((t: any) => t.label).join(', ');
  const video = r.summary ? `Video: ${firstSentence(r.summary)}` : '';
  return [setting && `Setting: ${setting}.`, video].filter(Boolean).join(' ');
}

/** The text the reranker sees: a summary as is, other passages behind their video's context. */
export function rerankText(job: Job, p: Passage): string {
  const context = p.kind === 'summary' ? '' : videoContext(job);
  return context ? `${context}\n${p.text}` : p.text;
}

export function imageUrl(job: Job, frame: number | null): string | null {
  return frame !== null && (job.result?.thumbs ?? []).includes(frame) ? `/videos/${job.id}/thumbs/${frame}` : null;
}

export function citationOf(job: Job, p: Passage): Citation {
  const sources = { summary: 'video summary', transcript: 'speech transcript', frame: 'model-described frame' } as const;
  return { kind: p.kind, frame_index: p.frame ?? 0, timestamp_seconds: p.t, t_end: p.tEnd, label: p.text.slice(0, 200), description: p.text,
    source: sources[p.kind], image_url: imageUrl(job, p.frame) };
}

export interface Ranked { job: Job; retrieval: Record<string, any> }
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export interface Thresholds { minScore: number; softMinScore: number; minSimilarity: number; vectorMargin: number }

export const thresholdsOf = (s: { searchMinScore: number; searchSoftMinScore: number; searchMinSimilarity: number; searchVectorMargin: number }): Thresholds =>
  ({ minScore: s.searchMinScore, softMinScore: s.searchSoftMinScore, minSimilarity: s.searchMinSimilarity, vectorMargin: s.searchVectorMargin });

/** Pure ranking (unit-tested): passages already reranked, grouped per video. */
export function rankVideos(groups: { job: Job; passages: (Passage & { rerank: number })[] }[], t: Thresholds): Ranked[] {
  const scored = groups.filter((g) => g.passages.length).map((g) => {
    const best = [...g.passages].sort((a, b) => b.rerank - a.rerank || b.vectorScore - a.vectorScore)[0];
    return { g, best, cosine: Math.max(...g.passages.map((p) => p.vectorScore)) };
  });
  const topCosine = Math.max(0, ...scored.map((x) => x.cosine));
  const kept = scored.filter((x) => x.cosine >= topCosine - t.vectorMargin
    && (x.best.rerank >= t.minScore || (x.best.rerank >= t.softMinScore && x.cosine >= t.minSimilarity)));
  kept.sort((a, b) => b.best.rerank - a.best.rerank || (a.g.job.id < b.g.job.id ? -1 : 1));
  const top = kept[0]?.best.rerank ?? 0;
  return kept.filter((x) => x.best.rerank >= RELATIVE_CUTOFF * top).slice(0, MAX_RESULTS).map(({ g, best, cosine }) => {
    const moment = g.passages.filter((p) => p.kind !== 'summary').sort((a, b) => b.rerank - a.rerank)[0];
    const cited = best.kind === 'summary' && moment && moment.rerank >= MOMENT_CITE_FRACTION * best.rerank ? moment : best;
    return {
      job: g.job,
      retrieval: { score: round4(best.rerank), rerank_score: round4(best.rerank), semantic_score: round4(cosine),
        matched_by: best.rerank >= t.minScore ? 'rerank' : 'rerank+semantic',
        citation: citationOf(g.job, cited), evidence_kinds: [...new Set(g.passages.filter((p) => p.rerank >= t.softMinScore).map((p) => p.kind))] },
    };
  });
}

export interface SearchDeps { db: D1Database; index: VectorizeIndex; reranker: Reranker }

export async function search(deps: SearchDeps, queryVector: number[], query: string, thresholds: Thresholds): Promise<Ranked[]> {
  const { matches } = await deps.index.query(queryVector, { topK: 100 });
  const byVideo = new Map<string, { kind: Citation['kind']; n: number; score: number }[]>();
  for (const m of matches) {
    const p = parseVectorId(m.id);
    if (!p) continue;
    const list = byVideo.get(p.videoId) ?? [];
    if (list.length < PASSAGES_PER_VIDEO) list.push({ kind: p.kind, n: p.n, score: m.score });
    byVideo.set(p.videoId, list);
  }
  const ids = [...byVideo.keys()].slice(0, CANDIDATE_VIDEOS);
  const videos = (await getVideos(deps.db, ids)).filter((v) => v.status === 'completed' && !v.archived_at && v.result);
  const groups = videos.map((job) => ({ job, passages: byVideo.get(job.id)!.map((h) => passageOf(job, h.kind, h.n, h.score)).filter((p): p is Passage => Boolean(p && p.text)) }))
    .filter((g) => g.passages.length);
  const scores = await deps.reranker.rerank(query, groups.flatMap((g) => g.passages.map((p) => rerankText(g.job, p))));
  let k = 0;
  const reranked = groups.map((g) => ({ job: g.job, passages: g.passages.map((p) => ({ ...p, rerank: scores[k++] ?? 0 })) }));
  return rankVideos(reranked, thresholds);
}
