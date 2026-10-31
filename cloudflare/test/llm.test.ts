/** Bring your own key: each provider's request shape and error mapping, with fetch mocked. */
import { describe, expect, it } from 'vitest';
import { Gemini, TaggerError } from '../src/gemini';
import { decryptSecret, encryptSecret } from '../src/google';
import { cleanKey, cleanModel } from '../src/keys';
import { makeLlm, Provider, PROVIDERS } from '../src/llm';

const frames = [{ index: 0, t: 1.5, jpeg: new Uint8Array([1, 2, 3]), transcript: 'hi' }];
const KEY = 'sk-test-0123456789abcd';

/** A fetch that records each call and answers with `reply` (status 200) unless `status` is given. */
function recorder(reply: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return Response.json(reply, { status, headers });
  }) as typeof fetch;
  return { fetcher, calls };
}

const describeJson = JSON.stringify({ frames: [{ index: 0, description: 'A red ball on grass.' }] });
const replies: Record<Provider, unknown> = {
  gemini: { candidates: [{ content: { parts: [{ text: describeJson }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
  openai: { choices: [{ message: { content: describeJson } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  openrouter: { choices: [{ message: { content: '```json\n' + describeJson + '\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  anthropic: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: describeJson }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
};

describe('provider request shaping', () => {
  it('Gemini: x-goog-api-key, inline JPEG, JSON mime type (unchanged for the owner)', async () => {
    const r = recorder(replies.gemini);
    const out = await makeLlm('gemini', KEY, 'gemini-3.1-flash-lite', r.fetcher).describeFrames(frames, null);
    expect(out.descriptions).toEqual([{ frame_index: 0, description: 'A red ball on grass.' }]);
    expect(r.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    expect(r.calls[0].headers['x-goog-api-key']).toBe(KEY);
    expect(r.calls[0].body).toEqual(Gemini.describeRequest(frames, null));
    expect(r.calls[0].body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AQID' } });
  });

  it('OpenAI: bearer key, image as a data URL, json_object', async () => {
    const r = recorder(replies.openai);
    const llm = makeLlm('openai', KEY, 'gpt-6-luna', r.fetcher);
    const out = await llm.describeFrames(frames, null);
    expect(out).toMatchObject({ descriptions: [{ frame_index: 0 }], usage: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const call = r.calls[0];
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(call.body.model).toBe('gpt-6-luna');
    expect(call.body.response_format).toEqual({ type: 'json_object' });
    expect(call.body.messages[0]).toMatchObject({ role: 'system' });
    expect(call.body.messages[0].content).toContain('80-180 words');
    expect(call.body.messages[1].content).toEqual([
      { type: 'text', text: 'Frame index 0 at 1.5 s. Speech near this moment: "hi"' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
    ]);
  });

  it('OpenRouter: OpenAI-compatible endpoint with attribution headers; a fenced JSON reply still parses', async () => {
    const r = recorder(replies.openrouter);
    const out = await makeLlm('openrouter', KEY, 'google/gemini-3.1-flash-lite', r.fetcher, 'https://spotted.test').describeFrames(frames, null);
    expect(out.descriptions[0].description).toBe('A red ball on grass.');
    expect(r.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(r.calls[0].headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'HTTP-Referer': 'https://spotted.test', 'X-Title': 'Spotted' });
    expect(r.calls[0].body.model).toBe('google/gemini-3.1-flash-lite');
  });

  it('Anthropic: x-api-key + anthropic-version, base64 image block, text blocks only, no sampling params', async () => {
    const r = recorder(replies.anthropic);
    const out = await makeLlm('anthropic', KEY, 'claude-haiku-5-5', r.fetcher).describeFrames(frames, null);
    expect(out).toMatchObject({ descriptions: [{ frame_index: 0 }], usage: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const call = r.calls[0];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2026-10-21', 'Content-Type': 'application/json' });
    expect(call.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16000 });
    expect(call.body.system).toContain('80-180 words');
    expect(call.body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQID' } });
    for (const k of ['temperature', 'top_p', 'top_k']) expect(call.body).not.toHaveProperty(k);
  });

  it('only Gemini hears the soundtrack; other providers get no audio and no sound tags', async () => {
    const summary = JSON.stringify({ summary: 'A dog barks.', tags: [{ label: 'dog', category: 'object', frame_indices: [0] }], labels: ['dog'], sounds: ['barking'] });
    const r = recorder({ choices: [{ message: { content: summary } }] });
    const out = await makeLlm('openai', KEY, 'gpt-6-luna', r.fetcher).summarize([{ frame_index: 0, description: 'A dog.', t: 0 }], [], 5, new Uint8Array([9, 9]));
    expect(out.sounds).toEqual([]);
    expect(JSON.stringify(r.calls[0].body)).not.toContain('SOUNDTRACK');
    expect(r.calls[0].body.messages[0].content).not.toContain('soundtrack');
    expect(Object.values(PROVIDERS).filter((p) => p.audio).map((p) => p.id)).toEqual(['gemini']);
  });

  it('maps errors: 401 -> auth (not retryable), 429 + Retry-After -> quota wait, 529 -> retryable; keys never in messages', async () => {
    for (const provider of ['openai', 'anthropic', 'openrouter'] as Provider[]) {
      const denied = makeLlm(provider, KEY, 'm', recorder({ error: { message: `bad key ${KEY}` } }, 401).fetcher);
      const error = await denied.describeFrames(frames, null).catch((e) => e);
      expect(error).toBeInstanceOf(TaggerError);
      expect(error).toMatchObject({ auth: true, retryable: false });
      expect(error.message).not.toContain(KEY);
      await expect(makeLlm(provider, KEY, 'm', recorder({}, 429, { 'retry-after': '30' }).fetcher).ping()).rejects.toMatchObject({ quota: true, retryAfterSeconds: 30 });
    }
    await expect(makeLlm('anthropic', KEY, 'm', recorder({}, 529).fetcher).ping()).rejects.toMatchObject({ retryable: true, quota: false });
  });

  it('ping is one small request', async () => {
    const r = recorder(replies.anthropic);
    await makeLlm('anthropic', KEY, 'claude-haiku-5-5', r.fetcher).ping();
    expect(r.calls).toHaveLength(1);
    expect(JSON.stringify(r.calls[0].body).length).toBeLessThan(400);
  });
});

describe('stored keys', () => {
  const ENC = 'a'.repeat(64);

  it('encryption round-trips, and a sealed key opens only for its own user', async () => {
    const sealed = await encryptSecret(KEY, ENC, 'llm-api-key:g:1');
    expect(sealed).not.toContain(KEY);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(await decryptSecret(sealed, ENC, 'llm-api-key:g:1')).toBe(KEY);
    await expect(decryptSecret(sealed, ENC, 'llm-api-key:g:2')).rejects.toThrow();
    await expect(decryptSecret(sealed, 'b'.repeat(64), 'llm-api-key:g:1')).rejects.toThrow();
  });

  it('cleans pasted keys and model ids', () => {
    expect(cleanKey(`  ${KEY}\n`)).toBe(KEY);
    expect(cleanKey('short')).toBeNull();
    expect(cleanKey('has space inside key')).toBeNull();
    expect(cleanModel(undefined, 'anthropic')).toBe('claude-haiku-5-5');
    expect(cleanModel('google/gemini-3.1-flash-lite', 'openrouter')).toBe('google/gemini-3.1-flash-lite');
    expect(cleanModel('a b', 'openai')).toBeNull();
  });
});
