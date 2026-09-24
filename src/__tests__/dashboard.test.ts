import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  sanitizeModel,
  maskKey,
  slugifyModelId,
  normalizeModelInput,
  resolveProviderUrl,
  buildDashboardHtml,
} from '../proxy/dashboard';

// ─── Key masking ───────────────────────────────────────────────────────────

describe('maskKey', () => {
  it('masks the middle of a real key, keeping only prefix/suffix', () => {
    expect(maskKey('sk-or-v1-abcdefghijklmnop')).toBe('sk-or-…mnop');
  });

  it('fully masks short keys', () => {
    expect(maskKey('abc123')).toBe('••••••');
  });

  it('labels empty and sentinel keys as none', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('none')).toBe('(none)');
    expect(maskKey('fallback:xyz')).toBe('(none)');
  });
});

// ─── Sanitization for the browser ─────────────────────────────────────────

describe('sanitizeModel', () => {
  it('never leaks the API key', () => {
    const out = sanitizeModel({
      name: 'models/gpt-4o',
      displayName: 'GPT-4o',
      description: 'd',
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      externalModelName: 'gpt-4o',
      apiKey: 'sk-super-secret-key-value-123',
    });
    expect(JSON.stringify(out)).not.toContain('super-secret');
    expect(out.keyMasked).toBe('sk-sup…-123');
  });

  it('falls back to name for a missing displayName', () => {
    expect(sanitizeModel({ name: 'models/x', provider: 'custom' }).displayName).toBe('models/x');
  });
});

// ─── Form input normalization ─────────────────────────────────────────────

describe('normalizeModelInput', () => {
  const form = {
    provider: 'openai',
    id: 'gpt-4o',
    apiKey: 'sk-test',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
  };

  it('builds a full model config from the form', () => {
    const { model, error } = normalizeModelInput(form);
    expect(error).toBeUndefined();
    expect(model!.name).toBe('models/gpt-4o');
    expect(model!.externalModelName).toBe('gpt-4o');
    expect(model!.provider).toBe('openai');
  });

  it('rejects unknown providers', () => {
    expect(normalizeModelInput({ ...form, provider: 'nope' }).error).toContain('provider');
  });

  it('requires a key for keyed providers but not for ollama', () => {
    expect(normalizeModelInput({ ...form, apiKey: '' }).error).toContain('API Key');
    const ollama = normalizeModelInput({
      provider: 'ollama',
      id: 'llama3',
      apiKey: '',
      apiUrl: 'http://localhost:11434/v1/chat/completions',
    });
    expect(ollama.error).toBeUndefined();
    expect(ollama.model!.apiKey).toBe('none');
  });

  it('rejects non-http URLs and empty ids', () => {
    expect(normalizeModelInput({ ...form, apiUrl: 'ftp://x' }).error).toContain('http');
    expect(normalizeModelInput({ ...form, id: '' }).error).toContain('required');
  });

  it('slugifies messy ids into model names', () => {
    const { model } = normalizeModelInput({ ...form, id: 'Qwen2.5 72B Instruct!!' });
    expect(model!.name).toBe('models/qwen2.5-72b-instruct');
  });
});

// ─── URL resolution (mirrors handleCustomModelRequest) ────────────────────

describe('resolveProviderUrl', () => {
  it('appends the chat path to bare base URLs', () => {
    expect(resolveProviderUrl('openai', 'https://x.ai/api', 'm', false)).toBe(
      'https://x.ai/api/v1/chat/completions',
    );
  });

  it('leaves complete endpoints untouched', () => {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    expect(resolveProviderUrl('openrouter', url, 'm', false)).toBe(url);
  });
});

// ─── Provider presets & HTML ──────────────────────────────────────────────

describe('dashboard presets and page', () => {
  it('ships presets for the major providers with sensible URLs', () => {
    expect(PROVIDERS.map((p) => p.id)).toContain('openrouter');
    expect(PROVIDERS.find((p) => p.id === 'openai')!.url).toContain('api.openai.com');
    expect(PROVIDERS.find((p) => p.id === 'ollama')!.needsKey).toBe(false);
  });

  it('renders a complete HTML page wired to the API', () => {
    const html = buildDashboardHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('/api/models');
    expect(html).toContain('Test Connection');
    // action dispatch (not class sniffing) + attr-safe buttons + key toggle + favicon
    expect(html).toContain('data-action="delete"');
    expect(html).toContain('data-action="toggle"');
    expect(html).toContain('id="keyToggle"');
    expect(html).toContain('rel="icon"');
  });
});
