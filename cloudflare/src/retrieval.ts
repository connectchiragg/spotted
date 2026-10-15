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
 *
 * Labels (src/labels.ts): the query is mapped to vocabulary labels (names and synonyms), and each
 * video carries Gemini's picks plus the ancestors our code adds. labelVerdict():
 *   - hit:      the video carries every label the query names -> accepted even below the rerank
 *               thresholds ("wildlife" -> crocodile and boar), and ranked before reranker-only videos;
 *   - conflict: the video lacks a query label but carries a mutually exclusive sibling of it
 *               (query "basketball", video "soccer"; "bird" vs "reptile") -> never accepted on the
 *               reranker score alone;
 *   - none:     the query names no label, or the video neither has nor contradicts it -> the
 *               rerank + cosine rule above decides.
 */
import { descendantsOf, exclusiveSiblings, expandLabels, queryLabels } from './labels';
import { decode as decodeVideo, getVideos, Video as Job } from './store';
import { nearestFrame, parseVectorId } from './vectors';

export const CANDIDATE_VIDEOS = 10;
/** Videos found by their labels alone (not among the nearest vectors) that are added to the candidates. */
export const LABEL_CANDIDATES = 10;
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

const soundsLine = (job: Job) => {
  const sounds: string[] = job.result?.sounds ?? [];
  return sounds.length ? `Sounds: ${sounds.join(', ')}.` : '';
};

/** What the whole video is: its environment tags, the summary's first sentence and what is heard. */
export function videoContext(job: Job): string {
  const r = job.result ?? {};
  const setting = (r.tags ?? []).filter((t: any) => t.category === 'environment').map((t: any) => t.label).join(', ');
  const video = r.summary ? `Video: ${firstSentence(r.summary)}` : '';
  return [setting && `Setting: ${setting}.`, video, soundsLine(job)].filter(Boolean).join(' ');
}

/** The text the reranker sees: a summary (with its sounds), other passages behind their video's context. */
export function rerankText(job: Job, p: Passage): string {
  if (p.kind === 'summary') return [p.text, soundsLine(job)].filter(Boolean).join('\n');
  const context = videoContext(job);
  return context ? `${context}\n${p.text}` : p.text;
}

/** A video's labels and sound tags with every ancestor (stored picks are expanded here, by our code). */
export function videoLabels(job: Job): Set<string> {
  return new Set(expandLabels([...(job.result?.labels ?? []), ...(job.result?.sounds ?? [])]));
}

export type LabelVerdict = 'hit' | 'conflict' | 'none';

/** How a video's labels relate to the labels a query names (see the header comment). */
export function labelVerdict(queryLabelNames: string[], labels: Set<string>): LabelVerdict {
  if (!queryLabelNames.length || !labels.size) return 'none';
  if (queryLabelNames.some((q) => !labels.has(q) && exclusiveSiblings(q).some((x) => labels.has(x)))) return 'conflict';
  return queryLabelNames.every((q) => labels.has(q)) ? 'hit' : 'none';
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

/** Pure ranking (unit-tested): passages already reranked, grouped per video; `queryLabelNames` from queryLabels(). */
export function rankVideos(groups: { job: Job; passages: (Passage & { rerank: number })[] }[], t: Thresholds, queryLabelNames: string[] = []): Ranked[] {
  const scored = groups.filter((g) => g.passages.length).map((g) => {
    const best = [...g.passages].sort((a, b) => b.rerank - a.rerank || b.vectorScore - a.vectorScore)[0];
    return { g, best, cosine: Math.max(...g.passages.map((p) => p.vectorScore)), label: labelVerdict(queryLabelNames, videoLabels(g.job)) };
  });
  const topCosine = Math.max(0, ...scored.map((x) => x.cosine));
  const byScores = (x: (typeof scored)[number]) => x.cosine >= topCosine - t.vectorMargin
    && (x.best.rerank >= t.minScore || (x.best.rerank >= t.softMinScore && x.cosine >= t.minSimilarity));
  const kept = scored.filter((x) => x.label === 'hit' || (x.label === 'none' && byScores(x)));
  const hit = (x: (typeof scored)[number]) => (x.label === 'hit' ? 1 : 0);
  kept.sort((a, b) => hit(b) - hit(a) || b.best.rerank - a.best.rerank || (a.g.job.id < b.g.job.id ? -1 : 1));
  // The relative cutoff compares reranker-only videos with the best reranker-only video; label hits are kept.
  const top = kept.find((x) => !hit(x))?.best.rerank ?? 0;
  return kept.filter((x) => hit(x) || x.best.rerank >= RELATIVE_CUTOFF * top).slice(0, MAX_RESULTS).map(({ g, best, cosine, label }) => {
    const moment = g.passages.filter((p) => p.kind !== 'summary').sort((a, b) => b.rerank - a.rerank)[0];
    const cited = best.kind === 'summary' && moment && moment.rerank >= MOMENT_CITE_FRACTION * best.rerank ? moment : best;
    return {
      job: g.job,
      retrieval: { score: round4(best.rerank), rerank_score: round4(best.rerank), semantic_score: round4(cosine),
        matched_by: label === 'hit' ? 'label' : best.rerank >= t.minScore ? 'rerank' : 'rerank+semantic',
        ...(queryLabelNames.length ? { query_labels: queryLabelNames } : {}),
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
  // Archived and unfinished videos keep their vectors: drop them before taking the top
  // CANDIDATE_VIDEOS, or they use up slots and push real matches out.
  const ranks = new Map([...byVideo.keys()].map((id, i) => [id, i]));
  const videos = (await getVideos(deps.db, [...byVideo.keys()]))
    .filter((v) => v.status === 'completed' && !v.archived_at && v.result)
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!)
    .slice(0, CANDIDATE_VIDEOS);
  const qLabels = queryLabels(query);
  // Label hits are looked up directly, not only among the nearest vectors: as the library grows, a
  // labelled video can rank below the vector cut for a broad query ("animals"). They join with
  // their summary as the only passage (cosine 0; a label hit is accepted without it).
  const extra = (await labelMatches(deps.db, qLabels, LABEL_CANDIDATES)).filter((v) => !videos.some((x) => x.id === v.id));
  const groups = [
    ...videos.map((job) => ({ job, passages: byVideo.get(job.id)!.map((h) => passageOf(job, h.kind, h.n, h.score)).filter((p): p is Passage => Boolean(p && p.text)) })),
    ...extra.map((job) => ({ job, passages: [passageOf(job, 'summary', 0, 0)].filter((p): p is Passage => Boolean(p && p.text)) })),
  ].filter((g) => g.passages.length);
  const scores = await deps.reranker.rerank(query, groups.flatMap((g) => g.passages.map((p) => rerankText(g.job, p))));
  let k = 0;
  const reranked = groups.map((g) => ({ job: g.job, passages: g.passages.map((p) => ({ ...p, rerank: scores[k++] ?? 0 })) }));
  return rankVideos(reranked, thresholds, qLabels);
}

/** Completed, unarchived videos whose labels or sounds imply every query label (newest first). */
export async function labelMatches(db: D1Database, names: string[], limit: number): Promise<Job[]> {
  if (!names.length) return [];
  const has = "(EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(result, '$.labels'), '[]')) WHERE value IN (SELECT value FROM json_each(?{n})))"
    + " OR EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(result, '$.sounds'), '[]')) WHERE value IN (SELECT value FROM json_each(?{n}))))";
  const where = names.map((_, i) => has.replaceAll('{n}', String(i + 1))).join(' AND ');
  const { results } = await db.prepare(`SELECT * FROM videos WHERE status='completed' AND archived_at IS NULL AND result IS NOT NULL AND ${where}
    ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`).bind(...names.map((n) => JSON.stringify(descendantsOf(n)))).all();
  return results.map((r) => decodeVideo(r)!);
}
