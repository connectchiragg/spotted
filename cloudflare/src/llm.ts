/**
 * Bring your own LLM key: the providers a person can use, and their request shapes. Prompts,
 * request content and validation are shared (src/gemini.ts, LlmClient); each class here only
 * turns (system prompt, parts) into its provider's HTTP request and reads the reply text.
 *
 *   gemini      Google AI Studio generateContent (src/gemini.ts); the only one that hears audio
 *   openai      Chat Completions, images as data: URLs, response_format json_object
 *   anthropic   Messages API, base64 image blocks, JSON asked for in the prompt
 *   openrouter  OpenAI-compatible Chat Completions at openrouter.ai
 *
 * Non-Gemini providers get no audio, so their videos have no sound tags (frames and the Whisper
 * transcript still work). Keys are never logged; error messages never contain them.
 */
import { base64, Gemini, LlmClient, Part, TaggerError, TokenUsage } from './gemini';

export type Provider = 'gemini' | 'openai' | 'anthropic' | 'openrouter';
export type Llm = LlmClient;

export interface ProviderInfo { id: Provider; label: string; defaultModel: string; audio: boolean; keyHint: string }

/**
 * Defaults: a cheap model that reads images, per provider (checked 2026-10-31: OpenAI's model page,
 * Anthropic's model table, OpenRouter's /api/v1/models with image input).
 */
export const PROVIDERS: Record<Provider, ProviderInfo> = {
  gemini: { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-3.1-flash-lite', audio: true, keyHint: 'aistudio.google.com/apikey' },
  openai: { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-6-luna', audio: false, keyHint: 'platform.openai.com/api-keys' },
  anthropic: { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-haiku-5-5', audio: false, keyHint: 'console.anthropic.com/settings/keys' },
  openrouter: { id: 'openrouter', label: 'OpenRouter', defaultModel: 'google/gemini-3.1-flash-lite', audio: false, keyHint: 'openrouter.ai/settings/keys' },
};

export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && Object.hasOwn(PROVIDERS, value);

const dataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${base64(bytes)}`;

/** Parts as Chat Completions content (audio is never sent: these providers have audio = false). */
function chatContent(parts: Part[]) {
  return parts.flatMap((p): object[] => ('text' in p ? [{ type: 'text', text: p.text }] : 'image' in p ? [{ type: 'image_url', image_url: { url: dataUrl(p.image) } }] : []));
}

function chatText(json: any, label: string): { text: string; usage: TokenUsage | null } {
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : '';
  if (!text) throw new TaggerError(`${label} returned no response; it may have blocked the request`, 502, false);
  const u = json?.usage;
  return { text, usage: u ? { promptTokenCount: u.prompt_tokens, candidatesTokenCount: u.completion_tokens, totalTokenCount: u.total_tokens } : null };
}

export class OpenAi extends LlmClient {
  readonly provider: Provider = 'openai';
  readonly label: string = 'OpenAI';
  readonly audio = false;
  protected url = 'https://api.openai.com/v1/chat/completions';

  static body(model: string, system: string, parts: Part[]) {
    return { model, messages: [{ role: 'system', content: system }, { role: 'user', content: chatContent(parts) }], response_format: { type: 'json_object' } };
  }

  protected extraHeaders(): Record<string, string> { return {}; }

  protected async generate(system: string, parts: Part[]) {
    const json = await this.post(this.url, { Authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders() }, OpenAi.body(this.model, system, parts));
    return chatText(json, this.label);
  }
}

export class OpenRouter extends OpenAi {
  readonly provider: Provider = 'openrouter';
  readonly label: string = 'OpenRouter';
  protected url = 'https://openrouter.ai/api/v1/chat/completions';
  constructor(apiKey: string, model: string, fetcher?: typeof fetch, private referer = 'https://spotted.haciensus.com') {
    super(apiKey, model, fetcher);
  }
  /** OpenRouter's optional app attribution headers. */
  protected extraHeaders() { return { 'HTTP-Referer': this.referer, 'X-Title': 'Spotted' }; }
}

export const ANTHROPIC_VERSION = '2026-10-21';

export class Anthropic extends LlmClient {
  readonly provider = 'anthropic' as const;
  readonly label = 'Anthropic';
  readonly audio = false;

  static body(model: string, system: string, parts: Part[]) {
    const content = parts.flatMap((p): object[] => ('text' in p ? [{ type: 'text', text: p.text }]
      : 'image' in p ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64(p.image) } }] : []));
    // No sampling parameters: API version 2026-10-21 rejects temperature/top_p/top_k.
    return { model, max_tokens: 16000, system, messages: [{ role: 'user', content }] };
  }

  protected async generate(system: string, parts: Part[]) {
    const json = await this.post('https://api.anthropic.com/v1/messages', { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      Anthropic.body(this.model, system, parts));
    if (json?.stop_reason === 'refusal') throw new TaggerError('Anthropic declined the request', 502, false);
    const text = (json?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('');
    if (!text) throw new TaggerError('Anthropic returned no response', 502, false);
    const u = json?.usage;
    return { text, usage: u ? { promptTokenCount: u.input_tokens, candidatesTokenCount: u.output_tokens } : null };
  }
}

/** A client for one person's key. `referer` is the app origin (OpenRouter attribution only). */
export function makeLlm(provider: Provider, apiKey: string, model: string, fetcher?: typeof fetch, referer?: string): Llm {
  switch (provider) {
    case 'gemini': return new Gemini(apiKey, model, fetcher);
    case 'openai': return new OpenAi(apiKey, model, fetcher);
    case 'anthropic': return new Anthropic(apiKey, model, fetcher);
    case 'openrouter': return new OpenRouter(apiKey, model, fetcher, referer);
  }
}
