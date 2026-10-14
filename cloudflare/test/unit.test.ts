import { describe, expect, it } from 'vitest';
import { handle, HttpError, validateUploadIntent } from '../src/api';
import { settings as readSettings } from '../src/env';
import { geminiMimeType, parseDuration, TaggerError, validateAnswer, validateTagging } from '../src/gemini';
import { normalizeQuery, rank, tokens } from '../src/retrieval';
import { appDeps, defaultTagging, fakeGemini } from './helpers';

describe('upload intent validation (port of UploadIntent)', () => {
  it('accepts and trims a valid intent', () => {
    expect(validateUploadIntent({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10, display_name: '  Trip ' }))
      .toEqual({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10, display_name: 'Trip' });
  });
  it('defaults content type to octet-stream', () => {
    expect(validateUploadIntent({ filename: 'a.mkv', size_bytes: 1 }).content_type).toBe('application/octet-stream');
  });
  for (const bad of [
    { filename: '', size_bytes: 1 },
    { filename: 'a\u0001.mp4', size_bytes: 1 },
    { filename: 'a.mp4', size_bytes: 0 },
    { filename: 'a.mp4', size_bytes: 1.5 },
    { filename: 'a.mp4', size_bytes: '10' },
    { filename: 'a.mp4', size_bytes: 1, content_type: 'image/png' },
    { filename: 'a.mp4', size_bytes: 1, display_name: '   ' },
    { filename: 'a.mp4', size_bytes: 1, display_name: 'x\u0007' },
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => validateUploadIntent(bad)).toThrow(HttpError);
    });
  }
});

describe('Gemini helpers', () => {
  it('maps browser MIME types and extensions to Gemini video types', () => {
    expect(geminiMimeType('video/quicktime', 'x.mov')).toBe('video/mov');
    expect(geminiMimeType('application/octet-stream', 'clip.WEBM')).toBe('video/webm');
    expect(geminiMimeType('video/x-matroska', 'clip.mkv')).toBeNull();
  });
  it('parses file durations', () => {
    expect(parseDuration('12.5s')).toBe(12.5);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
  it('sorts moments chronologically and remaps tag evidence', () => {
    const result = validateTagging(defaultTagging, 20, 16);
    expect(result.sampled_timestamps).toEqual([2, 12.5]);
    expect(result.frame_descriptions[1].description).toMatch(/fold a blue towel/);
    expect(result.tags.find((t) => t.label === 'towel')!.frame_indices).toEqual([1]);
    expect(result.tags.find((t) => t.label === 'bedroom')!.frame_indices).toEqual([0, 1]);
  });
  it('merges duplicate tags and clamps timestamps to the duration', () => {
    const result = validateTagging({ summary: 's', moments: [{ timestamp_seconds: 99, description: 'd' }],
      tags: [{ label: 'Cat', category: 'object', frame_indices: [0] }, { label: 'cat ', category: 'object', frame_indices: [0] }] }, 10, 16);
    expect(result.tags).toHaveLength(1);
    expect(result.sampled_timestamps).toEqual([10]);
  });
  it('rejects evidence outside the moments and malformed output', () => {
    expect(() => validateTagging({ ...defaultTagging, tags: [{ label: 'x', category: 'object', frame_indices: [5] }] }, 20, 16)).toThrow(TaggerError);
    expect(() => validateTagging({ summary: '', tags: [], moments: [] }, 20, 16)).toThrow(TaggerError);
    expect(() => validateTagging({ ...defaultTagging, tags: [{ label: 'x', category: 'person', frame_indices: [0] }] }, 20, 16)).toThrow(TaggerError);
  });
  it('validates grounded answers like validate_answer', () => {
    expect(validateAnswer({ answer: 'A towel [1].', citations: [1] }, 2)).toBe('A towel [1].');
    expect(() => validateAnswer({ answer: 'A towel [3].', citations: [3] }, 2)).toThrow();
    expect(() => validateAnswer({ answer: 'A towel [1].', citations: [2] }, 2)).toThrow();
    expect(() => validateAnswer({ answer: 'A towel [1] [x].', citations: [1] }, 2)).toThrow();
    expect(() => validateAnswer({ answer: 'No citations', citations: [] }, 2)).toThrow();
  });
});

describe('Gemini client', () => {
  it('uploads with the resumable protocol and classifies errors', async () => {
    const { gemini, log } = fakeGemini();
    const file = await gemini.uploadFile(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); c.close(); } }), 4, 'video/mp4', 'x');
    expect(file.name).toBe('files/abc');
    expect(log).toEqual(['POST /upload/v1beta/files', 'POST https://upload.test/session']);
    const quota = fakeGemini({ tagStatus: 429 }).gemini;
    await expect(quota.tagVideo(file, 20, 16)).rejects.toMatchObject({ retryable: false });
    const outage = fakeGemini({ tagStatus: 503 }).gemini;
    await expect(outage.tagVideo(file, 20, 16)).rejects.toMatchObject({ retryable: true });
  });
});

describe('retrieval ranking (port of hybrid_search)', () => {
  const job = (id: string, tags: string[], description: string) => ({
    id, result: { summary: description, tags: tags.map((label) => ({ label, category: 'object', frame_indices: [0] })),
      frame_descriptions: [{ frame_index: 0, description }], sampled_timestamps: [1.5], frame_indices: [] },
  }) as any;

  it('normalizes conversational queries and stems plurals', () => {
    expect(normalizeQuery('Can you show me dogs running in action')).toBe('dogs running');
    expect([...tokens('Show me the dogs and glass')]).toEqual(['dog', 'glass']);
  });
  it('keeps semantically supported videos and explicit tag matches only', () => {
    const scores = new Map([['a\u00000', 0.8], ['b\u00000', 0.2], ['c\u00000', 0.2]]);
    const ranked = rank('grill', [
      { job: job('a', ['kitchen'], 'someone cleans a grill'), semantic: 0.8 },
      { job: job('b', ['grill'], 'outdoor scene'), semantic: 0.2 },
      { job: job('c', ['bedroom'], 'a bed'), semantic: 0.2 },
    ], scores, 0.6);
    // b is an explicit tag match but scores below 80% of the best result.
    expect(ranked.map((r) => r.job.id)).toEqual(['a']);
    expect(ranked[0].retrieval.citation).toMatchObject({ frame_index: 0, timestamp_seconds: 1.5, image_url: null });
    const alone = rank('grill', [{ job: job('b', ['grill'], 'outdoor scene'), semantic: 0.2 }], scores, 0.6);
    expect(alone.map((r) => r.job.id)).toEqual(['b']);
    expect(alone[0].retrieval.citation.source).toBe('model-attributed sampled frame');
  });
  it('drops results scoring below 80% of the best', () => {
    const scores = new Map([['a\u00000', 0.95], ['b\u00000', 0.62]]);
    const ranked = rank('towel', [
      { job: job('a', ['towel'], 'a towel'), semantic: 0.95 },
      { job: job('b', ['blanket'], 'a blanket'), semantic: 0.62 },
    ], scores, 0.6);
    expect(ranked.map((r) => r.job.id)).toEqual(['a']);
  });
});

describe('settings', () => {
  it('reads defaults and rejects invalid settings', () => {
    expect(readSettings({}).embeddingModel).toBe('@cf/baai/bge-small-en-v1.5');
    expect(() => readSettings({ MAX_FRAMES: '0' })).toThrow();
  });
});

describe('routes without a database', () => {
  it('serves health and reports missing configuration as 503', async () => {
    const deps = appDeps(null);
    expect(await (await handle(new Request('https://x/health'), deps)).json()).toEqual({ status: 'ok' });
    const res = await handle(new Request('https://x/videos'), deps);
    expect(res.status).toBe(503);
    expect((await handle(new Request('https://x/nope'), deps)).status).toBe(404);
    expect((await handle(new Request('https://x/videos', { method: 'POST' }), deps)).status).toBe(410);
  });
  it('enforces public-demo request size and disabled routes', async () => {
    const deps = appDeps(null, { settings: { ...appDeps(null).settings, publicLimits: true } });
    expect((await handle(new Request('https://x/videos/tag', { method: 'POST' }), deps)).status).toBe(403);
    const big = new Request('https://x/query', { method: 'POST', headers: { 'content-length': '20000' }, body: 'x'.repeat(20000) });
    expect((await handle(big, deps)).status).toBe(413);
  });
});
