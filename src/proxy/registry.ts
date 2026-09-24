/**
 * Provider Translator Registry.
 * Static map of translator modules with a unified interface for request/response mapping.
 *
 * To add a new provider:
 *   1. Create a file in ./translators/ named <provider>.ts
 *   2. Export: mapGeminiTo<Provider>, map<Provider>ToGemini, map<Provider>ChunkToGemini
 *   3. Register it in `translators` below + `providerFamily`.
 */

import log from 'electron-log';
import * as openai from './translators/openai';
import * as anthropic from './translators/anthropic';
import * as google from './translators/google';
import * as ollama from './translators/ollama';
import { getGoogleApiUrl } from './translators/google';
import { getOllamaApiUrl } from './translators/ollama';

// ─── Types ────────────────────────────────────────────────────────────────

export interface TranslatorModule {
  mapGeminiToOpenAI?: (body: unknown, modelName: string) => unknown;
  mapOpenAIToGemini?: (res: unknown, modelName: string) => unknown;
  mapOpenAIChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  mapGeminiToAnthropic?: (body: unknown, modelName: string) => unknown;
  mapAnthropicToGemini?: (res: unknown, modelName: string) => unknown;
  mapAnthropicChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  mapGoogleChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
}

export interface ProviderHeaders {
  'Content-Type': string;
  Authorization?: string;
  'x-api-key'?: string;
  'anthropic-version'?: string;
  'x-goog-api-key'?: string;
  'HTTP-Referer'?: string;
  'X-Title'?: string;
  [key: string]: string | undefined;
}

// ─── Registry State ───────────────────────────────────────────────────────

const translators = new Map<string, TranslatorModule>([
  ['openai', openai],
  ['ollama', ollama],
  ['anthropic', anthropic],
  ['google', google],
]);

// Single source of truth for transport compatibility.
export type ProviderFamily = 'openai' | 'anthropic' | 'google' | 'unknown';

const OPENAI_FAMILY = new Set([
  'openai',
  'ollama',
  'openrouter',
  'custom',
  'groq',
  'mistral',
  'cerebras',
  'nvidia',
  'opencode',
  'codestral',
  'free-router',
]);
const ANTHROPIC_FAMILY = new Set([
  'anthropic',
  'deepseek',
  'kimi',
  'fireworks',
  'lmstudio',
  'llamacpp',
  'wafer',
  'zai',
]);

export function providerFamily(provider: string): ProviderFamily {
  if (OPENAI_FAMILY.has(provider)) return 'openai';
  if (ANTHROPIC_FAMILY.has(provider)) return 'anthropic';
  if (provider === 'google') return 'google';
  return 'unknown';
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getTranslator(provider: string): TranslatorModule | null {
  const family = providerFamily(provider);
  if (family === 'openai') return translators.get(provider === 'ollama' ? 'ollama' : 'openai') || null;
  if (family === 'anthropic') return translators.get('anthropic') || null;
  if (family === 'google') return translators.get('google') || null;
  return translators.get('openai') || null;
}

export function translateRequest(provider: string, geminiBody: unknown, modelName: string): unknown {
  const t = getTranslator(provider);
  const family = providerFamily(provider);

  if (family === 'google') return geminiBody;
  if (family === 'openai') return t?.mapGeminiToOpenAI ? t.mapGeminiToOpenAI(geminiBody, modelName) : geminiBody;
  if (family === 'anthropic')
    return t?.mapGeminiToAnthropic ? t.mapGeminiToAnthropic(geminiBody, modelName) : geminiBody;

  log.warn(`[TranslatorRegistry] No request translator for provider "${provider}", passing through`);
  return geminiBody;
}

export function translateResponse(provider: string, providerRes: unknown, modelName: string): unknown {
  const t = getTranslator(provider);
  const family = providerFamily(provider);

  if (family === 'google') return providerRes;
  if (family === 'openai') return t?.mapOpenAIToGemini ? t.mapOpenAIToGemini(providerRes, modelName) : providerRes;
  if (family === 'anthropic')
    return t?.mapAnthropicToGemini ? t.mapAnthropicToGemini(providerRes, modelName) : providerRes;

  log.warn(`[TranslatorRegistry] No response translator for provider "${provider}", passing through`);
  return providerRes;
}

export function translateStreamChunk(provider: string, chunk: unknown, modelName: string): unknown {
  const t = getTranslator(provider);
  const family = providerFamily(provider);

  if (family === 'google') return t?.mapGoogleChunkToGemini ? t.mapGoogleChunkToGemini(chunk, modelName) : null;
  if (family === 'openai') return t?.mapOpenAIChunkToGemini ? t.mapOpenAIChunkToGemini(chunk, modelName) : null;
  if (family === 'anthropic')
    return t?.mapAnthropicChunkToGemini ? t.mapAnthropicChunkToGemini(chunk, modelName) : null;

  return null;
}

export function getProviderHeaders(provider: string, apiKey: string): ProviderHeaders {
  const headers: ProviderHeaders = { 'Content-Type': 'application/json' };
  if (!apiKey || apiKey === 'none') return headers;

  const family = providerFamily(provider);
  if (provider === 'anthropic' || family === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2025-04-01';
  } else if (family === 'google') {
    headers['x-goog-api-key'] = apiKey;
  } else if (provider === 'openrouter') {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['HTTP-Referer'] = 'https://antigravity.google';
    headers['X-Title'] = 'Antigravity';
  } else if (provider !== 'ollama') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

export function supportsStreaming(provider: string): boolean {
  return providerFamily(provider) !== 'unknown';
}

// ─── URL Helpers ──────────────────────────────────────────────────────────

export function getProviderUrl(baseUrl: string, modelName: string, isStream: boolean, provider: string): string {
  if (provider === 'google' || providerFamily(provider) === 'google') return getGoogleApiUrl(baseUrl, modelName, isStream);
  if (provider === 'ollama') return getOllamaApiUrl(baseUrl);
  return baseUrl;
}

/**
 * Single source for appending /v1/chat/completions to a bare OpenAI-family
 * base URL. Callers keep their own gating (proxy dials vs dashboard tester
 * differ in which providers this applies to); the append rules live here.
 */
export function withChatCompletions(baseUrl: string): string {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('/chat/completions') || lower.includes('/completions')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return baseUrl + '/chat/completions';
  if (baseUrl.endsWith('/')) return baseUrl + 'v1/chat/completions';
  return baseUrl + '/v1/chat/completions';
}
