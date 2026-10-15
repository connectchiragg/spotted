import { describe, expect, it } from 'vitest';
import { handle, HttpError, validateUploadIntent } from '../src/api';
import { settings as readSettings } from '../src/env';
import { changeScores, mad, mp4Duration, selectFrames, spriteTiles, spriteWindows, tileTime } from '../src/frames';
import { Gemini, validateAnswer, validateDescriptions, validateSummary } from '../src/gemini';
import { authUrl, decryptSecret, encryptSecret, SCOPES } from '../src/google';
import { canonicalLabel, expandLabels, LABELS, LABEL_BY_NAME, queryLabels, validateLabels } from '../src/labels';
import { labelVerdict, normalizeQuery, passageOf, rankVideos, rerankText, videoLabels } from '../src/retrieval';

const T = { minScore: 0.02, softMinScore: 0.008, minSimilarity: 0.53, vectorMargin: 0.07 };
import { parseVectorId, transcriptWindows } from '../src/vectors';
import { appDeps, encodeTiles, fakeGemini, fakeMp4 } from './helpers';

describe('upload intent validation (port of UploadIntent)', () => {
  it('accepts and trims a valid intent', () => {
    expect(validateUploadIntent({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10, display_name: '  Trip ' }))
      .toEqual({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10, display_name: 'Trip' });
  });
  for (const bad of [
    { filename: '', size_bytes: 1 },
    { filename: 'a.mp4', size_bytes: 0 },
    { filename: 'a.mp4', size_bytes: 1, content_type: 'image/png' },
    { filename: 'a.mp4', size_bytes: 1, display_name: 'x\u0007' },
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => validateUploadIntent(bad)).toThrow(HttpError);
    });
  }
});

describe('frame selection by pixel deviation', () => {
  it('decodes a vertically stacked spritesheet into grayscale tiles', () => {
    const tiles = spriteTiles(encodeTiles([40, 40, 200]), 3);
    expect(tiles).toHaveLength(3);
    expect(tiles[0].length).toBe(64 * 36);
    expect(mad(tiles[0], tiles[1])).toBeLessThan(2);
    expect(mad(tiles[1], tiles[2])).toBeGreaterThan(150);
    expect(changeScores(tiles)[0]).toBe(Infinity); // the first frame always qualifies
  });

  it('keeps the first frame, cuts above the threshold, and respects the minimum gap', () => {
    const candidates = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ t, score: t === 0 ? Infinity : [0, 30, 40, 1, 2, 50, 3][t] }));
    const picks = selectFrames(candidates, { maxFrames: 16, minGap: 2, threshold: 12 });
    // t=1 (30) is within 2 s of t=0; t=2 (40) qualifies; t=3/4/6 are below the threshold; t=5 (50) qualifies.
    expect(picks.map((p) => p.t)).toEqual([0, 2, 5]);
    expect(picks.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('over the cap keeps the first frame plus the best changes spread across time', () => {
    const candidates = Array.from({ length: 100 }, (_, t) => ({ t, score: t === 0 ? Infinity : 20 + (t % 7) }));
    const picks = selectFrames(candidates, { maxFrames: 5, minGap: 1, threshold: 12 });
    expect(picks).toHaveLength(5);
    expect(picks[0].t).toBe(0);
    expect(picks.at(-1)!.t).toBeGreaterThan(70); // spread, not the first five
  });

  it('splits gaps longer than maxGap so slow or static footage is still covered', () => {
    const candidates = Array.from({ length: 30 }, (_, t) => ({ t, score: t === 0 ? Infinity : 0.5 }));
    expect(selectFrames(candidates, { maxFrames: 16, minGap: 2, threshold: 12 }).map((p) => p.t)).toEqual([0]); // no maxGap: change only
    const times = selectFrames(candidates, { maxFrames: 16, minGap: 2, threshold: 12, maxGap: 8, end: 30 }).map((p) => p.t);
    const gaps = [...times, 30].slice(1).map((t, i) => t - times[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(8);
    expect(times.length).toBeLessThanOrEqual(6);
    // A cut is still preferred inside a gap: the best-scoring candidate wins over the middle.
    const withCut = candidates.map((c) => (c.t === 11 ? { ...c, score: 90 } : c));
    expect(selectFrames(withCut, { maxFrames: 16, minGap: 2, threshold: 95, maxGap: 8, end: 30 }).map((p) => p.t)).toContain(11);
    expect(selectFrames(candidates, { maxFrames: 2, minGap: 2, threshold: 12, maxGap: 8, end: 30 })).toHaveLength(2); // the cap holds
  });

  it('splits candidates into <= 60 s spritesheet windows', () => {
    const w = spriteWindows(130, 1);
    expect(w).toEqual([{ time: 0, duration: 60, count: 60 }, { time: 60, duration: 60, count: 60 }, { time: 120, duration: 10, count: 10 }]);
    expect(tileTime(w[1], 30)).toBe(90);
  });

  it('reads the duration from an mvhd box', () => {
    expect(mp4Duration(fakeMp4(42.5))).toBe(42.5);
    expect(mp4Duration(new Uint8Array(100))).toBeNull();
  });
});

describe('Gemini on frames', () => {
  it('sends inline JPEG frames with timestamps and nearby speech', () => {
    const req = Gemini.describeRequest([{ index: 3, t: 12.5, jpeg: new Uint8Array([1, 2, 3]), transcript: 'hello' }], 'before');
    const parts = req.contents[0].parts;
    expect(parts[0].text).toContain('before');
    expect(parts[1].text).toBe('Frame index 3 at 12.5 s. Speech near this moment: "hello"');
    expect(parts[2]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AQID' } });
    expect(req.systemInstruction.parts[0].text).toContain('80-180 words');
  });

  it('validates per-frame paragraphs and summaries', () => {
    expect(validateDescriptions({ frames: [{ index: 2, description: ' A ' }, { index: 5, description: 'B' }] }, [{ index: 2 }, { index: 5 }]))
      .toEqual([{ frame_index: 2, description: 'A' }, { frame_index: 5, description: 'B' }]);
    expect(() => validateDescriptions({ frames: [{ index: 2, description: 'A' }] }, [{ index: 2 }, { index: 5 }])).toThrow(/skipped a frame/);
    const s = validateSummary({ summary: 's', tags: [{ label: 'Cat ', category: 'object', frame_indices: [0, 9] }, { label: 'cat', category: 'object', frame_indices: [1] }] }, 2);
    expect(s.tags).toEqual([{ label: 'cat', category: 'object', frame_indices: [0, 1] }]);
    expect(s.labels).toEqual(['cat']); // from the object tag
    // Regression (2026-10-16): labels ["animal","home"] while the tags named the cat.
    const t = validateSummary({ summary: 's', labels: ['animal', 'home'], tags: [{ label: 'cat', category: 'object' }, { label: 'resting', category: 'action' }, { label: 'living room', category: 'environment' }] }, 1);
    expect(t.labels.slice(0, 3)).toEqual(['animal', 'home', 'cat']);
    expect(t.labels).not.toContain('resting');
    const l = validateSummary({ summary: 's', tags: [], labels: [{ label: 'Wild boar', frame_indices: [0] }, 'pig', 'dragon'], sounds: ['birds chirping', 'soccer'] }, 2);
    expect([l.labels, l.sounds]).toEqual([['wild boar', 'pig'], ['birdsong']]);
  });

  it('folds labels and sound tags into the summary call, with the soundtrack inline', () => {
    const frames = [{ frame_index: 0, description: 'A boar.', t: 0 }];
    const req = Gemini.summaryRequest(frames, [], 5, new Uint8Array([1, 2, 3]));
    const prompt = req.systemInstruction.parts[0].text;
    expect(prompt).toContain('wild boar');
    expect(prompt).toContain('cheering');
    expect(prompt).toContain('soundtrack');
    expect(req.contents[0].parts.at(-1)).toEqual({ inlineData: { mimeType: 'audio/mp4', data: 'AQID' } });
    const silent = Gemini.summaryRequest(frames, [], 5, null);
    expect(silent.contents[0].parts).toHaveLength(1);
    expect(silent.systemInstruction.parts[0].text).not.toContain('soundtrack');
  });

  it('classifies a 429 as a quota wait with RetryInfo, and 503 as retryable', async () => {
    const frames = [{ index: 0, t: 0, jpeg: new Uint8Array(1), transcript: '' }];
    await expect(fakeGemini({ describeStatus: 429 }).gemini.describeFrames(frames, null)).rejects.toMatchObject({ quota: true, retryAfterSeconds: 120 });
    await expect(fakeGemini({ describeStatus: 503 }).gemini.describeFrames(frames, null)).rejects.toMatchObject({ quota: false, retryable: true });
    await expect(fakeGemini({ describeStatus: 401 }).gemini.describeFrames(frames, null)).rejects.toMatchObject({ retryable: false });
  });

  it('validates grounded answers like validate_answer', () => {
    expect(validateAnswer({ answer: 'A towel [1].', citations: [1] }, 2)).toBe('A towel [1].');
    expect(() => validateAnswer({ answer: 'A towel.', citations: [1] }, 2)).toThrow();
    expect(() => validateAnswer({ answer: 'A towel [3].', citations: [3] }, 2)).toThrow();
  });
});

describe('index entries and ranking', () => {
  it('builds overlapping 45 s transcript windows', () => {
    const w = transcriptWindows([{ start: 0, end: 10, text: 'a' }, { start: 40, end: 50, text: 'b' }, { start: 70, end: 80, text: 'c' }], 80);
    expect(w).toEqual([{ start: 0, end: 45, text: 'a b' }, { start: 30, end: 75, text: 'b c' }, { start: 60, end: 80, text: 'c' }]);
  });

  it('parses vector ids', () => {
    expect(parseVectorId('s:v1')).toEqual({ kind: 'summary', videoId: 'v1', n: 0 });
    expect(parseVectorId('t:v1:3')).toEqual({ kind: 'transcript', videoId: 'v1', n: 3 });
    expect(parseVectorId('f:v1:12')).toEqual({ kind: 'frame', videoId: 'v1', n: 12 });
  });

  it('ranks videos by their best reranked passage and cites its moment', () => {
    const job = (id: string) => ({ id, result: { summary: 's', sampled_timestamps: [0, 7.5], thumbs: [0, 1],
      frame_descriptions: [{ frame_index: 0, description: 'a bed' }, { frame_index: 1, description: 'a towel' }],
      transcript_windows: [{ start: 30, end: 75, text: 'fold it' }] } }) as any;
    const [a, b, c] = [job('a'), job('b'), job('c')];
    const ranked = rankVideos([
      { job: a, passages: [{ ...passageOf(a, 'frame', 1, 0.6)!, rerank: 0.9 }, { ...passageOf(a, 'summary', 0, 0.55)!, rerank: 0.1 }] },
      { job: b, passages: [{ ...passageOf(b, 'transcript', 0, 0.58)!, rerank: 0.5 }] },
      { job: c, passages: [{ ...passageOf(c, 'frame', 0, 0.62)!, rerank: 0.1 }] }, // under 25% of the best
    ], T);
    expect(ranked.map((r) => r.job.id)).toEqual(['a', 'b']);
    expect(ranked[0].retrieval.citation).toMatchObject({ kind: 'frame', timestamp_seconds: 7.5, image_url: '/videos/a/thumbs/1' });
    expect(ranked[1].retrieval.citation).toMatchObject({ kind: 'transcript', timestamp_seconds: 30, image_url: '/videos/b/thumbs/1' });
  });

  it('normalizes conversational queries', () => {
    expect(normalizeQuery('Can you show me dogs running in action')).toBe('dogs running');
    expect(normalizeQuery('Wildlife')).toBe('wildlife');
  });

  // Regression (2026-10-15): "wildlife" over the owner's 5 real videos returned nothing. Scores below are
  // the measured bge-m3 cosines and bge-reranker-base scores of each video's best passage.
  const video = (id: string) => ({ id, result: { summary: id, sampled_timestamps: [0], thumbs: [0], frame_descriptions: [{ frame_index: 0, description: id }] } }) as any;
  const groupsOf = (scores: Record<string, [number, number]>) => Object.entries(scores).map(([id, [cosine, rerank]]) => {
    const job = video(id);
    return { job, passages: [{ ...passageOf(job, 'frame', 0, cosine)!, rerank }] };
  });
  const ids = (r: { job: { id: string } }[]) => r.map((x) => x.job.id);

  it('finds both wildlife videos for the one-word query "wildlife"', () => {
    const groups = groupsOf({ boar: [0.587, 0.0137], crocodile: [0.535, 0.0289], isl: [0.422, 5.4e-5], blue: [0.401, 3.3e-4], aek: [0.375, 3.0e-4] });
    expect(ids(rankVideos(groups, { ...T, softMinScore: 1, minSimilarity: 1 }))).toEqual(['crocodile']); // the rerank cutoff alone dropped the boar
    const ranked = rankVideos(groups, T);
    expect(ids(ranked)).toEqual(['crocodile', 'boar']);
    expect(ranked[1].retrieval.matched_by).toBe('rerank+semantic');
  });

  it('still returns nothing for unrelated one-word queries', () => {
    expect(rankVideos(groupsOf({ boar: [0.514, 0.0099], crocodile: [0.483, 0.0045], isl: [0.425, 3.7e-5] }), T)).toEqual([]); // "dog"
    expect(rankVideos(groupsOf({ isl: [0.425, 3.7e-5], aek: [0.408, 3.7e-5], blue: [0.4, 3.7e-5] }), T)).toEqual([]); // "car"
  });

  it('reranks frames and speech behind the video context, summaries as they are', () => {
    // "birthday party" matched a goal-celebration frame that never said "soccer" (rerank 0.21 -> 0.0007 with context).
    const job = { id: 'aek', result: { summary: 'The video captures a soccer match between AEK and LASK. A goal is scored.',
      tags: [{ label: 'soccer stadium', category: 'environment' }, { label: 'celebrating', category: 'action' }],
      sampled_timestamps: [0, 12], thumbs: [0, 1], frame_descriptions: [{ frame_index: 1, description: 'Players embrace in a joyous celebration.' }],
      transcript_windows: [{ start: 0, end: 15, text: 'Goal!' }] } } as any;
    expect(rerankText(job, passageOf(job, 'frame', 1, 0.5)!)).toBe(
      'Setting: soccer stadium. Video: The video captures a soccer match between AEK and LASK.\nPlayers embrace in a joyous celebration.');
    expect(rerankText(job, passageOf(job, 'transcript', 0, 0.5)!)).toMatch(/^Setting: soccer stadium\. Video: .*\nSpeech: Goal!$/);
    expect(rerankText(job, passageOf(job, 'summary', 0, 0.5)!)).toBe(job.result.summary);
  });

  it('cites the best moment over the summary when it scores close', () => {
    const job = { id: 'v', result: { summary: 's', sampled_timestamps: [0, 12], thumbs: [0, 1], frame_descriptions: [{ frame_index: 1, description: 'hug' }] } } as any;
    const rank = (frame: number) => rankVideos([{ job, passages: [{ ...passageOf(job, 'summary', 0, 0.6)!, rerank: 0.86 }, { ...passageOf(job, 'frame', 1, 0.6)!, rerank: frame }] }], T)[0].retrieval;
    expect(rank(0.8).citation).toMatchObject({ kind: 'frame', timestamp_seconds: 12 });
    expect(rank(0.8).score).toBe(0.86); // the video still scores its best passage
    expect(rank(0.1).citation).toMatchObject({ kind: 'summary', timestamp_seconds: 0 });
  });

  it('drops a high rerank score whose video is far from the best vector match', () => {
    // "indian super league": only one clip is the ISL match; the reranker also liked another match.
    expect(ids(rankVideos(groupsOf({ isl: [0.568, 0.97], aek: [0.449, 0.07], blue: [0.418, 0.13] }), T))).toEqual(['isl']);
  });
  // Labels (2026-10-15, after the relabel backfill). Measured best bge-m3 cosine and bge-reranker-base score per video,
  // with each video's stored labels as Gemini picked them.
  const labelled = (scores: Record<string, [number, number]>, labels: Record<string, string[]>, sounds: Record<string, string[]> = {}) =>
    groupsOf(scores).map((g) => ({ ...g, job: { ...g.job, result: { ...g.job.result, labels: labels[g.job.id] ?? [], sounds: sounds[g.job.id] ?? [] } } }));
  const LIVE = { aek: ['soccer', 'stadium', 'crowd', 'goal', 'scoreboard', 'people'], crocodile: ['nature', 'lake', 'forest', 'tree', 'crocodile'],
    boar: ['wild boar', 'nature', 'meadow', 'forest', 'water'], blue: ['soccer', 'stadium', 'crowd', 'goal celebration', 'ambulance', 'sky', 'sunset'],
    isl: ['stadium', 'soccer', 'scoreboard'] };

  it('vetoes a reranker-only match whose labels contradict the query ("basketball" vs soccer)', () => {
    const scores = { aek: [0.488, 0.0522], blue: [0.45, 0.0521], isl: [0.443, 0.0438], crocodile: [0.352, 3.7e-5], boar: [0.348, 3.7e-5] } as Record<string, [number, number]>;
    expect(ids(rankVideos(labelled(scores, LIVE), T))).toEqual(['aek', 'blue', 'isl']); // without query labels: all three soccer clips pass 0.02
    expect(rankVideos(labelled(scores, LIVE), T, queryLabels('basketball'))).toEqual([]);
    expect(labelVerdict(['basketball'], videoLabels(labelled(scores, LIVE)[0].job))).toBe('conflict');
  });

  it('vetoes "bird" on the crocodile (reptile) and the boar (mammal)', () => {
    const scores = { crocodile: [0.531, 0.0187], boar: [0.574, 0.00285], isl: [0.472, 8.7e-5] } as Record<string, [number, number]>;
    expect(ids(rankVideos(labelled(scores, LIVE), T))).toEqual(['crocodile']); // soft rule: 0.0187 >= 0.008 with cosine 0.531 >= 0.53
    expect(rankVideos(labelled(scores, LIVE), T, ['bird'])).toEqual([]);
  });

  it('rescues a clear label hit below the rerank thresholds ("wildlife": the boar at 0.0052)', () => {
    const scores = { boar: [0.597, 0.00522], crocodile: [0.54, 0.0217], isl: [0.422, 3.7e-5], blue: [0.401, 3.7e-5], aek: [0.375, 3.7e-5] } as Record<string, [number, number]>;
    expect(ids(rankVideos(labelled(scores, LIVE), T))).toEqual(['crocodile']);
    const ranked = rankVideos(labelled(scores, LIVE), T, queryLabels('wildlife'));
    expect(ids(ranked)).toEqual(['crocodile', 'boar']);
    expect(ranked.map((r) => r.retrieval.matched_by)).toEqual(['label', 'label']);
    expect(ranked[0].retrieval.query_labels).toEqual(['wildlife']);
  });

  it('ranks label hits before reranker-only videos and keeps every hit ("sport")', () => {
    const scores = { isl: [0.539, 0.0952], blue: [0.53, 0.047], aek: [0.524, 0.0446], boar: [0.371, 3.7e-5] } as Record<string, [number, number]>;
    expect(ids(rankVideos(labelled(scores, LIVE), T, ['sport']))).toEqual(['isl', 'blue', 'aek']);
  });

  it('matches sound tags ("cheering crowd" needs both the sound and the crowd)', () => {
    const scores = { aek: [0.5, 0.005], isl: [0.5, 0.005] } as Record<string, [number, number]>;
    const ranked = rankVideos(labelled(scores, LIVE, { aek: ['cheering', 'commentary'], isl: ['cheering'] }), T, queryLabels('cheering crowd'));
    expect(ids(ranked)).toEqual(['aek']); // isl has no crowd label: left to the reranker, which is below the floor here
  });

  it('leaves queries that name no label to the rerank rule', () => {
    expect(queryLabels('van Mieghem')).toEqual([]);
    expect(labelVerdict([], new Set(['soccer']))).toBe('none');
    expect(labelVerdict(['pig'], videoLabels({ id: 'c', result: { labels: ['crocodile'] } } as any))).toBe('none'); // no pig, no other mammal
  });

  it('puts sounds into the reranker context and next to the summary', () => {
    const job = { id: 'v', result: { summary: 'A match.', tags: [], sounds: ['cheering', 'applause'], sampled_timestamps: [0], thumbs: [0],
      frame_descriptions: [{ frame_index: 0, description: 'Players.' }] } } as any;
    expect(rerankText(job, passageOf(job, 'summary', 0, 0.5)!)).toBe('A match.\nSounds: cheering, applause.');
    expect(rerankText(job, passageOf(job, 'frame', 0, 0.5)!)).toBe('Video: A match. Sounds: cheering, applause.\nPlayers.');
  });
});

describe('label hierarchy', () => {
  it('is a small, consistent vocabulary: unique names, known parents, no cycles', () => {
    expect(LABELS.length).toBeGreaterThanOrEqual(100);
    expect(LABELS.length).toBeLessThanOrEqual(200);
    expect(new Set(LABELS.map((d) => d.name)).size).toBe(LABELS.length);
    for (const d of LABELS) {
      for (const p of d.parents) expect(LABEL_BY_NAME.get(p)?.kind, `${d.name} -> ${p}`).toBe(d.kind);
      expect(expandLabels([d.name]).length).toBeLessThan(15); // terminates (a cycle would recurse forever)
    }
  });

  it('adds every ancestor in our code', () => {
    expect(expandLabels(['soccer'])).toEqual(['ball game', 'soccer', 'sport', 'team sport']);
    expect(expandLabels(['wild boar'])).toEqual(['animal', 'mammal', 'nature', 'pig', 'wild boar', 'wildlife']);
    expect(expandLabels(['crocodile'])).toEqual(['animal', 'crocodile', 'nature', 'reptile', 'wildlife']);
    expect(expandLabels(['ambulance', 'cheering'])).toEqual(['ambulance', 'cheering', 'crowd sounds', 'emergency vehicle', 'vehicle']);
    expect(expandLabels(['sunset'])).not.toContain('nature'); // a stadium at sunset is not a nature video
    expect(expandLabels(['unicorn'])).toEqual([]);
  });

  it('validates the model output against the vocabulary', () => {
    expect(validateLabels(['Soccer', 'football', 'unicorn', { label: 'ambulance', frame_indices: [3] }, 'Crocodiles', 'cheering', 42], 'visual'))
      .toEqual(['soccer', 'ambulance', 'crocodile']); // synonyms folded, duplicates merged, unknown and sound names dropped
    expect(validateLabels(['Cheering', 'clapping', 'soccer'], 'sound')).toEqual(['cheering', 'applause']);
    expect(validateLabels('soccer', 'visual')).toEqual([]);
    expect(validateLabels(Array.from({ length: 50 }, (_, i) => LABELS[i].name), 'visual', 25)).toHaveLength(25);
    expect(canonicalLabel('Alligator')).toBe('crocodile');
  });

  it('maps queries to labels, longest phrase first', () => {
    expect(queryLabels('Wildlife')).toEqual(['wildlife']);
    expect(queryLabels('american football game')).toEqual(['american football', 'sports match']);
    expect(queryLabels('football')).toEqual(['soccer']);
    expect(queryLabels('a pig eating grass')).toEqual(['pig', 'eating']);
    expect(queryLabels('cheering crowd')).toEqual(['cheering', 'crowd']);
    expect(queryLabels('office meeting')).toEqual(['meeting']);
  });
});

describe('Google OAuth', () => {
  const key = 'ab'.repeat(32);
  it('seals the refresh token with AES-GCM bound to its purpose', async () => {
    const sealed = await encryptSecret('1//refresh', key);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('refresh');
    expect(await decryptSecret(sealed, key)).toBe('1//refresh');
    await expect(decryptSecret(sealed, key, 'other-purpose')).rejects.toThrow();
    await expect(decryptSecret(sealed, 'cd'.repeat(32))).rejects.toThrow();
  });
  it('asks for offline access with both scopes and a state', () => {
    const url = new URL(authUrl({ clientId: 'cid', clientSecret: 's', encKey: key, redirectUri: 'https://framer.test/oauth/google/callback' }, 'st'));
    expect(url.searchParams.get('scope')).toBe(SCOPES.join(' '));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('redirect_uri')).toBe('https://framer.test/oauth/google/callback');
  });
});

describe('settings', () => {
  it('reads defaults and rejects invalid settings', () => {
    expect(readSettings({}).embeddingModel).toBe('@cf/baai/bge-m3');
    expect(readSettings({}).maxSourceBytes).toBe(100_000_000);
    expect(() => readSettings({ MAX_FRAMES: '0' })).toThrow();
    expect(() => readSettings({ MAX_FRAMES: '41' })).toThrow();
    expect(() => readSettings({ MAX_SOURCE_MB: '200' })).toThrow(/Media Transformations/);
  });
});

describe('routes without a database', () => {
  it('serves health and reports missing configuration as 503', async () => {
    const deps = appDeps(null);
    expect(await (await handle(new Request('https://x/health'), deps)).json()).toEqual({ status: 'ok' });
    expect((await handle(new Request('https://x/videos'), deps)).status).toBe(503);
    expect((await handle(new Request('https://x/nope'), deps)).status).toBe(404);
    expect((await handle(new Request('https://x/videos', { method: 'POST' }), deps)).status).toBe(410);
    expect((await handle(new Request('https://x/oauth/google/start'), deps)).status).toBe(503);
  });
  it('refuses cross-origin writes and enforces public-demo limits', async () => {
    const deps = appDeps(null, { settings: { ...appDeps(null).settings, publicLimits: true } });
    expect((await handle(new Request('https://x/photos/sessions', { method: 'POST', headers: { Origin: 'https://evil.test' } }), deps)).status).toBe(403);
    expect((await handle(new Request('https://x/videos/tag', { method: 'POST' }), deps)).status).toBe(403);
    const big = new Request('https://x/query', { method: 'POST', headers: { 'content-length': '20000' }, body: 'x'.repeat(20000) });
    expect((await handle(big, deps)).status).toBe(413);
  });
});
