/**
 * Bring your own LLM key, on Miniflare D1 and the real VideoDO:
 *   - keys are sealed in D1 and never returned;
 *   - provider selection: the owner -> the server key, a guest -> their own key, a guest without
 *     a key -> analysis waits and search answers from retrieval, with no LLM call at all;
 *   - saving a key resumes the waiting videos.
 */
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/api';
import { Gemini } from '../../src/gemini';
import { keyInfo, llmFor, NEEDS_KEY, openKey, saveKey } from '../../src/keys';
import { Llm } from '../../src/llm';
import * as store from '../../src/store';
import { IngestState, VideoDO } from '../../src/video';
import { appDeps, authed, fakeBucket, fakeEmbedder, fakeGemini, fakeMedia, fakeMp4, FakeObject, fakeTranscriber, fakeVectorize, settings, signIn } from '../helpers';

const db: D1Database = env.DB;
const ns = env.VIDEO as DurableObjectNamespace;
const ENC = '0f'.repeat(32);
const GUEST_KEY = 'sk-guest-key-123456789WXYZ';
const SERVER_KEY = 'server-gemini-key-0000';

beforeEach(async () => {
  await db.batch(['videos', 'usage_counters', 'usage_events', 'sessions', 'users', 'llm_keys'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

/** A fetch standing in for every provider: records the key header it was called with. */
function providerFetch(status = 200) {
  const calls: { url: string; auth: string | null }[] = [];
  const answer = JSON.stringify({ answer: 'A crocodile rests by the lake [1].', citations: [1] });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>;
    calls.push({ url: String(input), auth: h['x-goog-api-key'] ?? h['x-api-key'] ?? h.Authorization ?? null });
    if (status !== 200) return Response.json({}, { status });
    if (String(input).includes('anthropic')) return Response.json({ content: [{ type: 'text', text: answer }] });
    if (String(input).includes('googleapis')) return Response.json({ candidates: [{ content: { parts: [{ text: answer }] } }] });
    return Response.json({ choices: [{ message: { content: answer } }] });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('provider selection', () => {
  it('the owner gets the server Gemini key; a guest gets only their own key; a guest without one gets nothing', async () => {
    const p = providerFetch();
    const ctx = { db, encKey: ENC, serverKey: SERVER_KEY, serverModel: 'gemini-3.1-flash-lite', fetcher: p.fetcher };
    const owner = (await llmFor(ctx, 'owner'))!;
    expect(owner).toBeInstanceOf(Gemini);
    await owner.ping();
    expect(p.calls.at(-1)!.auth).toBe(SERVER_KEY);

    expect(await llmFor(ctx, 'g:1')).toBeNull(); // never the server key

    await saveKey(db, ENC, 'g:1', 'openai', 'gpt-6-luna', GUEST_KEY);
    const guest = (await llmFor(ctx, 'g:1'))!;
    expect([guest.provider, guest.modelName]).toEqual(['openai', 'gpt-6-luna']);
    await guest.ping();
    expect(p.calls.at(-1)!).toEqual({ url: 'https://api.openai.com/v1/chat/completions', auth: `Bearer ${GUEST_KEY}` });
    expect(p.calls.filter((c) => c.auth === SERVER_KEY)).toHaveLength(1); // only the owner's own ping

    // Another user's sealed key never opens for this user.
    await db.prepare("INSERT INTO llm_keys SELECT 'g:2', provider, model, key_enc, key_last4, status, error, checked_at, created_at, updated_at FROM llm_keys WHERE user_id='g:1'").run();
    expect(await openKey(db, ENC, 'g:2')).toBeNull();
    expect(await llmFor(ctx, 'g:2')).toBeNull();
  });

  it('stores the key sealed: D1 holds no plaintext, only the last 4 characters', async () => {
    await saveKey(db, ENC, 'g:1', 'anthropic', 'claude-haiku-5-5', GUEST_KEY);
    const row = await db.prepare('SELECT * FROM llm_keys').first<any>();
    expect(JSON.stringify(row)).not.toContain(GUEST_KEY);
    expect(row.key_last4).toBe('WXYZ');
    expect(await openKey(db, ENC, 'g:1')).toMatchObject({ provider: 'anthropic', key: GUEST_KEY });
    expect(await keyInfo(db, 'g:1')).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', last4: 'WXYZ', status: 'ok' });
  });
});

describe('settings API', () => {
  it('validates with one call, stores, shows only provider/model/last 4, tests, replaces and removes', async () => {
    const p = providerFetch();
    const app = appDeps(db, { encKey: ENC, llmFetch: p.fetcher });
    const guest = authed(await signIn(db, { id: 'g:7', email: 'g7@example.com' }));
    const put = (body: unknown) => handle(guest('https://x/settings/llm', { method: 'PUT', body: JSON.stringify(body) }), app);

    expect((await (await handle(guest('https://x/settings/llm'), app)).json<any>())).toMatchObject({ owner: false, key: null, available: true });
    const saved = await put({ provider: 'anthropic', key: ` ${GUEST_KEY} ` });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(GUEST_KEY);
    expect(JSON.parse(text).key).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', last4: 'WXYZ', status: 'ok' });
    expect(p.calls).toHaveLength(1); // one validation call
    expect(p.calls[0]).toEqual({ url: 'https://api.anthropic.com/v1/messages', auth: GUEST_KEY });

    // Change only the model: the stored key is reused (validated again).
    expect((await (await put({ provider: 'anthropic', model: 'claude-sonnet-5-5' })).json<any>()).key).toMatchObject({ model: 'claude-sonnet-5-5', last4: 'WXYZ' });
    // A different provider needs its own key.
    expect((await put({ provider: 'openai' })).status).toBe(422);

    const tested = await (await handle(guest('https://x/settings/llm/test', { method: 'POST' }), app)).json<any>();
    expect(tested).toMatchObject({ ok: true, detail: 'Anthropic accepted the key.' });
    expect((await (await handle(guest('https://x/me'), app)).json<any>()).llm).toMatchObject({ source: 'own', ready: true, provider: 'anthropic', audio: false });

    expect((await (await handle(guest('https://x/settings/llm', { method: 'DELETE' }), app)).json<any>()).key).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM llm_keys').first('n')).toBe(0);
  });

  it('rejects a key the provider refuses, without storing it; the owner cannot store one', async () => {
    const app = appDeps(db, { encKey: ENC, llmFetch: providerFetch(401).fetcher });
    const guest = authed(await signIn(db, { id: 'g:8', email: 'g8@example.com' }));
    const res = await handle(guest('https://x/settings/llm', { method: 'PUT', body: JSON.stringify({ provider: 'openai', key: GUEST_KEY }) }), app);
    expect([res.status, (await res.json<any>()).detail]).toEqual([422, 'OpenAI rejected this key.']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM llm_keys').first('n')).toBe(0);
    const owner = authed(await signIn(db));
    expect((await handle(owner('https://x/settings/llm', { method: 'PUT', body: JSON.stringify({ provider: 'openai', key: GUEST_KEY }) }), app)).status).toBe(409);
  });
});

describe('search answers', () => {
  async function seed(userId: string) {
    const { index } = fakeVectorize();
    await db.prepare(`INSERT INTO videos (id, filename, object_key, content_type, status, created_at, updated_at, result, user_id)
      VALUES (?1, ?1, ?2, 'video/mp4', 'completed', '2026-10-01', '2026-10-01', ?3, ?4)`).bind(`v-${userId}`, `videos/v/source`,
      JSON.stringify({ summary: 'A crocodile in a lake.', labels: ['crocodile'], sampled_timestamps: [0], thumbs: [0] }), userId).run();
    const [values] = await fakeEmbedder().embed(['crocodile']);
    await index.upsert([{ id: `s:v-${userId}`, values, metadata: { user_id: userId, kind: 'summary', video_id: `v-${userId}` } }]);
    return index;
  }

  it('a guest without a key gets the retrieval-only answer and no LLM call; with a key, their own key answers', async () => {
    const p = providerFetch();
    const owner = fakeGemini({ answer: { answer: 'Owner answer [1].', citations: [1] } });
    const guest = authed(await signIn(db, { id: 'g:9', email: 'g9@example.com' }));
    const app = appDeps(db, { index: await seed('g:9'), gemini: owner.gemini, encKey: ENC, llmFetch: p.fetcher });
    const ask = async () => (await handle(guest('https://x/query', { method: 'POST', body: '{"q":"crocodile"}' }), app)).json<any>();

    const without = await ask();
    expect(without).toMatchObject({ answer_source: 'retrieval', answer_warning: expect.stringContaining('Add your API key in Settings') });
    expect(without.items).toHaveLength(1);
    expect(owner.counts.answer).toBe(0); // the owner's key was never used
    expect(p.calls).toHaveLength(0);

    await saveKey(db, ENC, 'g:9', 'openrouter', 'google/gemini-3.1-flash-lite', GUEST_KEY);
    const withKey = await ask();
    expect(withKey).toMatchObject({ answer: 'A crocodile rests by the lake [1].', answer_source: 'llm', answer_model: 'google/gemini-3.1-flash-lite' });
    expect(p.calls).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', auth: `Bearer ${GUEST_KEY}` }]);
    expect(owner.counts.answer).toBe(0);
  });

  it('the owner still answers with the server Gemini key', async () => {
    const owner = fakeGemini({ answer: { answer: 'Owner answer [1].', citations: [1] } });
    const req = authed(await signIn(db));
    const app = appDeps(db, { index: await seed('owner'), gemini: owner.gemini, encKey: ENC });
    const res = await (await handle(req('https://x/query', { method: 'POST', body: '{"q":"crocodile"}' }), app)).json<any>();
    expect(res).toMatchObject({ answer: 'Owner answer [1].', answer_source: 'gemini', answer_model: 'gemini-test' });
    expect(owner.counts.answer).toBe(1);
  });
});

describe('VideoDO on a guest\'s own key', () => {
  async function guestVideo(llm: () => Llm | null) {
    const video = await store.createVideo(db, { userId: 'g:5', filename: 'clip.mp4', contentType: 'video/mp4', size: 4096 });
    await store.markUploaded(db, video.id);
    const bytes = fakeMp4(30, 4096);
    const objects: Record<string, FakeObject> = { [video.object_key]: { size: bytes.length, contentType: 'video/mp4', bytes } };
    const media = fakeMedia();
    const whisper = fakeTranscriber();
    const users: string[] = [];
    VideoDO.testDeps.set(video.id, () => ({ db, bucket: fakeBucket(objects), index: fakeVectorize().index, media: media.port, transcriber: whisper.transcriber,
      embedder: fakeEmbedder(), google: null, settings, llmFor: async (userId: string) => { users.push(userId); return userId === 'owner' ? fakeGemini().gemini : llm(); } }));
    const stub = ns.get(ns.idFromName(video.id)) as any;
    const state = (): Promise<IngestState> => stub.getState();
    const drive = async () => {
      for (let i = 0; i < 40; i++) {
        const s = await state();
        if (s && (['done', 'failed', 'skipped'].includes(s.step) || s.needs_key)) return s;
        await runDurableObjectAlarm(stub);
      }
      return state();
    };
    return { video, stub, state, drive, media, whisper, objects, users };
  }

  it('without a key the video waits before any work (no copy, no Whisper, no LLM); saving a key resumes it on that key', async () => {
    let guestLlm: ReturnType<typeof fakeGemini> | null = null;
    const t = await guestVideo(() => guestLlm?.gemini ?? null);
    await t.stub.start(t.video.id);
    const waiting = await t.drive();
    expect(waiting).toMatchObject({ step: 'probe', needs_key: true, last_error: NEEDS_KEY, attempts: 0 });
    expect([t.media.counts.sprites, t.whisper.counts.calls]).toEqual([0, 0]);
    expect(t.users).toEqual(['g:5']); // resolved for the guest, never as the owner
    expect(await store.getVideo(db, t.video.id)).toMatchObject({ status: 'pending', error: NEEDS_KEY, progress: { stage: 'Waiting for your API key' } });
    // A status read (start) does not re-arm it.
    await t.stub.start(t.video.id);
    expect(await runDurableObjectAlarm(t.stub)).toBe(false);

    guestLlm = fakeGemini();
    expect(await t.stub.resume(t.video.id)).toBe(true);
    const done = await t.drive();
    expect(done.step).toBe('done');
    expect(guestLlm.counts).toMatchObject({ describe: 2, summary: 1 });
  });

  it('a provider without audio gets no soundtrack (no Media audio call) and no sound tags', async () => {
    const llm = fakeGemini();
    Object.assign(llm.gemini, { audio: false });
    const t = await guestVideo(() => llm.gemini);
    await t.stub.start(t.video.id);
    expect((await t.drive()).step).toBe('done');
    expect(t.media.counts.audio).toBe(0);
    expect(t.objects[`videos/${t.video.id}/sound.m4a`]).toBeUndefined();
    expect((await store.getVideo(db, t.video.id))!.result.sounds).toEqual([]);
    const summary = llm.requests.find((r) => JSON.stringify(r.systemInstruction).includes('summarise'));
    expect(JSON.stringify(summary)).not.toContain('audio/mp4');
  });

  it('a key the provider rejects mid-analysis marks it invalid and waits instead of failing', async () => {
    await saveKey(db, ENC, 'g:5', 'gemini', 'gemini-test', GUEST_KEY);
    const t = await guestVideo(() => fakeGemini({ describeStatus: 401 }).gemini);
    await t.stub.start(t.video.id);
    const s = await t.drive();
    expect(s).toMatchObject({ step: 'describe', needs_key: true, last_error: expect.stringContaining('rejected') });
    expect(await keyInfo(db, 'g:5')).toMatchObject({ status: 'invalid' });
    expect((await store.getVideo(db, t.video.id))!.status).toBe('pending');
  });

  it('guests have a shorter video length limit than the owner', async () => {
    const t = await guestVideo(() => fakeGemini().gemini);
    VideoDO.testDeps.set(t.video.id, ((base) => () => ({ ...base(), settings: { ...settings, guestMaxVideoSeconds: 20 } }))(VideoDO.testDeps.get(t.video.id)!));
    await t.stub.start(t.video.id);
    expect(await t.drive()).toMatchObject({ step: 'skipped', last_error: expect.stringMatching(/^Video is longer than/) });
  });
});

describe('guest daily video limit', () => {
  it('counts new uploads per guest per day', async () => {
    const app = appDeps(db, { bucket: fakeBucket({}), settings: { ...settings, guestDailyVideos: 1 } });
    const guest = authed(await signIn(db, { id: 'g:6', email: 'g6@example.com' }));
    const upload = () => handle(guest('https://x/videos/uploads', { method: 'POST', body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10 }) }), app);
    expect((await upload()).status).toBe(201);
    const second = await upload();
    expect([second.status, (await second.json<any>()).detail]).toEqual([429, "You've added today's 1 videos. You can add more after midnight UTC."]);
  });
});
