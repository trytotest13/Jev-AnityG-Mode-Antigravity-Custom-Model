/**
 * Model Dashboard: a small web UI served by the proxy at /dashboard.
 *
 * The old Antigravity app had Settings -> Add Model; the new "Antigravity
 * IDE" 2.5.x packaging has no such UI, so the proxy serves one: list / add /
 * test / delete custom models in the browser, no JSON editing required.
 *
 * This module is intentionally Electron-free so it can be unit-tested
 * directly. File persistence stays in proxy.ts (cryptoStore lives there).
 */

import * as registry from './registry';

// ─── Provider presets ─────────────────────────────────────────────────────

export interface ProviderPreset {
  id: string;
  label: string;
  url: string;
  needsKey: boolean;
  keyHint: string;
}

export const PROVIDERS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI (ChatGPT)', url: 'https://api.openai.com/v1/chat/completions', needsKey: true, keyHint: 'sk-...' },
  { id: 'anthropic', label: 'Anthropic (Claude)', url: 'https://api.anthropic.com/v1/messages', needsKey: true, keyHint: 'sk-ant-...' },
  { id: 'google', label: 'Google AI Studio (Gemini)', url: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, keyHint: 'AIza...' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', needsKey: true, keyHint: 'sk-or-v1-...' },
  { id: 'ollama', label: 'Ollama (Local)', url: 'http://localhost:11434/v1/chat/completions', needsKey: false, keyHint: 'no key needed' },
  { id: 'free-router', label: 'Free Router (Local Gateway)', url: 'http://127.0.0.1:8787/v1', needsKey: false, keyHint: 'no key needed' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', url: '', needsKey: true, keyHint: "provider's API key" },
];

/** Provider ids accepted from the dashboard form (schemaValidator allows more; these are the ones we preset). */
const PRESET_IDS = new Set(PROVIDERS.map((p) => p.id));

// ─── Shape helpers ────────────────────────────────────────────────────────

export interface SafeModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiUrl: string;
  externalModelName: string;
  keyMasked: string;
  disabled: boolean;
}

/** Strips the API key before sending a model to the browser. */
export function sanitizeModel(m: {
  name?: string;
  displayName?: string;
  description?: string;
  provider?: string;
  apiUrl?: string;
  externalModelName?: string;
  apiKey?: string;
  disabled?: boolean;
}): SafeModel {
  return {
    name: m.name || '',
    displayName: m.displayName || m.name || '',
    description: m.description || '',
    provider: m.provider || 'custom',
    apiUrl: m.apiUrl || '',
    externalModelName: m.externalModelName || '',
    keyMasked: maskKey(m.apiKey || ''),
    disabled: !!m.disabled,
  };
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key === 'none' || key.startsWith('fallback:')) return '(none)';
  if (key.length <= 10) return '••••••';
  return key.slice(0, 6) + '…' + key.slice(-4);
}

export function slugifyModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface NewModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  disabled: boolean;
}

/**
 * Validates the dashboard form payload and fills provider defaults.
 * Returns { model } on success or { error } with a user-facing message.
 */
export function normalizeModelInput(body: unknown): { model?: NewModel; error?: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  const provider = String(b.provider || '').trim();
  if (!PRESET_IDS.has(provider)) return { error: 'Pick a provider from the list.' };

  const id = String(b.id || '').trim();
  if (!id) return { error: 'Model Name / ID is required.' };

  let apiKey = String(b.apiKey || '').trim();
  const preset = PROVIDERS.find((p) => p.id === provider)!;
  if (preset.needsKey && !apiKey) return { error: 'API Key is required for ' + preset.label + '.' };
  if (!preset.needsKey) apiKey = apiKey || 'none';

  let apiUrl = String(b.apiUrl || '').trim() || preset.url;
  if (!apiUrl) return { error: 'API URL is required for Custom / Other providers.' };
  if (!/^https?:\/\//i.test(apiUrl)) return { error: 'API URL must start with http:// or https://.' };

  const slug = slugifyModelId(id);
  if (!slug) return { error: 'Model Name / ID must contain letters or numbers.' };

  const displayName = String(b.displayName || '').trim() || id;
  return {
    model: {
      name: 'models/' + slug,
      displayName,
      description: 'Added via dashboard (' + preset.label + ')',
      provider,
      apiKey,
      apiUrl,
      externalModelName: id.trim(),
      disabled: false,
    },
  };
}

// ─── Connection test ──────────────────────────────────────────────────────

/** Same URL fix-ups handleCustomModelRequest applies before dialing a provider. */
export function resolveProviderUrl(provider: string, baseUrl: string, modelName: string, isStream: boolean): string {
  if (provider === 'google' || provider === 'ollama') {
    return registry.getProviderUrl(baseUrl, modelName, isStream, provider);
  }
  return registry.withChatCompletions(baseUrl);
}

export interface TestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
}

/** Sends a tiny "ping" generation through the real translator for this provider. */
export async function testModelConnection(input: {
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
}): Promise<TestResult> {
  const provider = input.provider === 'custom' || input.provider === 'openrouter' || input.provider === 'free-router' ? 'openai' : input.provider;
  const pingBody = {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: pong' }] }],
    generationConfig: { maxOutputTokens: 16 },
  };
  const payload = JSON.stringify(registry.translateRequest(provider, pingBody, input.externalModelName));
  const headers = registry.getProviderHeaders(provider, input.apiKey || 'none') as Record<string, string>;
  const urlStr = resolveProviderUrl(provider, input.apiUrl, input.externalModelName, false);

  const started = Date.now();
  try {
    const res = await fetch(urlStr, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - started;
    const body = await res.text();
    if (res.ok) {
      let reply = '';
      try {
        reply = extractReplyText(provider, JSON.parse(body) as Record<string, unknown>);
      } catch {
        /* keep empty reply */
      }
      return {
        ok: true,
        status: res.status,
        latencyMs,
        message: reply ? 'Connected (' + latencyMs + ' ms). Model replied: ' + reply : 'Connected (' + latencyMs + ' ms)',
      };
    }
    return { ok: false, status: res.status, latencyMs, message: 'HTTP ' + res.status + ': ' + extractError(body) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, message: (err as Error).message };
  }
}

function extractReplyText(provider: string, parsed: Record<string, unknown>): string {
  if (provider === 'anthropic') {
    const content = parsed.content as { type?: string; text?: string }[] | undefined;
    const text = (content || []).find((c) => c.type === 'text')?.text;
    return (text || '').slice(0, 80);
  }
  const choices = parsed.choices as { message?: { content?: string } }[] | undefined;
  return ((choices && choices[0]?.message?.content) || '').slice(0, 80);
}

function extractError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 200);
    if (parsed.error?.message) return parsed.error.message.slice(0, 200);
    if (parsed.message) return parsed.message.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200) || '(empty response)';
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────

export function buildDashboardHtml(): string {
  const providerOptions = PROVIDERS.map((p) => '<option value="' + p.id + '">' + p.label + '</option>').join('');
  const defaultUrls = JSON.stringify(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.url])));
  const needsKey = JSON.stringify(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.needsKey])));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev AnityG-Mode · Custom Models</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232f6fed'/%3E%3Ctext x='32' y='44' font-family='sans-serif' font-size='36' font-weight='bold' text-anchor='middle' fill='white'%3EJ%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
  color-scheme: dark;
  /* Black page base with deep blue washes */
  --bg-base: #04060b;
  --bg-top: #070a12;
  --wash: rgba(47, 111, 237, 0.14);
  --wash-soft: rgba(47, 111, 237, 0.09);
  /* Dark glass surfaces (white 4-8%) */
  --surface: rgba(255, 255, 255, 0.045);
  --surface-strong: rgba(10, 14, 23, 0.65);
  --surface-solid: #0d1119;
  --surface-hover: rgba(255, 255, 255, 0.07);
  --surface-active: rgba(255, 255, 255, 0.09);
  /* Barely-there light strokes, warming to blue on hover/focus */
  --border: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.12);
  --border-hover: rgba(74, 140, 255, 0.5);
  --border-glow: rgba(59, 125, 255, 0.5);
  --border-success: rgba(52, 211, 119, 0.4);
  --border-error: rgba(255, 92, 82, 0.4);
  /* Light text on black */
  --ink: #f5f8ff;
  --text: #e6ebf7;
  --text-secondary: #b6c0d4;
  --text-dim: #97a2b8;
  --text-faint: #7a8598;
  --text-muted: #5d6879;
  /* Primary blue family */
  --accent: #3b7dff;
  --accent-bright: #4a8cff;
  --accent-dark: #1e56d6;
  --accent-purple: #3b7dff;
  --accent-pink: #4a8cff;
  --accent-glow-soft: #4a8cff;
  --ok: #34d377;
  --ok-bright: #6fe3a1;
  --ok-glow: rgba(52, 211, 119, 0.12);
  --bad: #ff5c52;
  --bad-bright: #ff7b73;
  --bad-glow: rgba(255, 92, 82, 0.12);
  --warn: #f5a623;
  --warn-glow: rgba(245, 166, 35, 0.12);
  --info: #4a8cff;
  --info-glow: rgba(74, 140, 255, 0.14);
  /* Radii + dark shadows with blue glow accents */
  --radius-xs: 6px;
  --radius-sm: 10px;
  --radius: 14px;
  --radius-lg: 18px;
  --radius-xl: 24px;
  --shadow-xs: 0 1px 4px rgba(0, 0, 0, 0.5);
  --shadow-sm: 0 2px 12px rgba(0, 0, 0, 0.55);
  --shadow: 0 4px 14px rgba(0, 0, 0, 0.45), 0 12px 36px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(59, 125, 255, 0.05);
  --shadow-lg: 0 6px 18px rgba(0, 0, 0, 0.5), 0 18px 48px rgba(0, 0, 0, 0.55), 0 0 24px rgba(47, 111, 237, 0.1);
  --shadow-xl: 0 10px 24px rgba(0, 0, 0, 0.55), 0 28px 72px rgba(0, 0, 0, 0.6);
  --glow-accent: 0 0 32px rgba(59, 125, 255, 0.25);
  --glass-blur: blur(18px) saturate(1.35);
  --transition-fast: 0.12s ease;
  --transition: 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 0.45s cubic-bezier(0.4, 0, 0.2, 1);
}


  * { box-sizing: border-box; margin: 0; padding: 0; }

  html { scroll-behavior: smooth; }

  body {
    min-height: 100vh;
    color: var(--text);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.6;
    /* Black base with deep blue radial washes in the corners: glow without
       flatness, the dark counterpart of the reference's pale gradient. */
    background:
      radial-gradient(1100px 720px at 88% 4%, var(--wash) 0%, rgba(47, 111, 237, 0) 58%),
      radial-gradient(900px 640px at 4% 96%, var(--wash-soft) 0%, rgba(47, 111, 237, 0) 58%),
      linear-gradient(180deg, var(--bg-top) 0%, var(--bg-base) 100%);
    background-attachment: fixed;
    overflow-x: hidden;
  }

  ::selection { background: rgba(59, 125, 255, 0.35); color: #fff; }

  /* Dark, slim scrollbars */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: #232b3d;
    border-radius: 999px;
    border: 2px solid var(--bg-base);
  }
  ::-webkit-scrollbar-thumb:hover { background: #303b53; }

  /* Faint concentric wave linework in the upper-right: watermark-level,
     adds motion without competing with content. */
  body::after {
    content: '';
    position: fixed;
    top: -140px;
    right: -140px;
    width: 560px;
    height: 560px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600' fill='none' stroke='%234a8cff'%3E%3Ccircle cx='300' cy='300' r='70' stroke-opacity='0.09'/%3E%3Ccircle cx='300' cy='300' r='130' stroke-opacity='0.08'/%3E%3Ccircle cx='300' cy='300' r='190' stroke-opacity='0.07'/%3E%3Ccircle cx='300' cy='300' r='250' stroke-opacity='0.06'/%3E%3Ccircle cx='300' cy='300' r='296' stroke-opacity='0.05'/%3E%3C/svg%3E");
    background-size: contain;
    background-repeat: no-repeat;
    pointer-events: none;
    z-index: 0;
  }

  /* Slow-drifting blue glow behind the content (center-right) */
  body::before {
    content: '';
    position: fixed;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background:
      radial-gradient(ellipse 700px 700px at 70% 18%, rgba(74, 140, 255, 0.1), transparent 60%),
      radial-gradient(ellipse 600px 600px at 20% 80%, rgba(59, 125, 255, 0.07), transparent 60%),
      radial-gradient(ellipse 500px 500px at 55% 50%, rgba(30, 86, 214, 0.06), transparent 60%);
    animation: bgDrift 40s ease-in-out infinite alternate;
    pointer-events: none;
    z-index: 0;
  }

  @keyframes bgDrift {
    0% { transform: translate(0, 0) rotate(0deg) scale(1); }
    50% { transform: translate(-40px, -30px) rotate(2deg) scale(1.05); }
    100% { transform: translate(-20px, -15px) rotate(-1deg) scale(1.02); }
  }

  /* ── Floating micro-cubes (decorative layer) ── */
  .bg-decor {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    overflow: hidden;
  }

  .cube {
    position: absolute;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpolygon points='50,3 97,26.5 50,50 3,26.5' fill='%2379a7ff'/%3E%3Cpolygon points='3,26.5 50,50 50,97 3,73.5' fill='%232f6fed'/%3E%3Cpolygon points='97,26.5 50,50 50,97 97,73.5' fill='%231e56d6'/%3E%3C/svg%3E");
    background-size: contain;
    background-repeat: no-repeat;
    filter: drop-shadow(0 10px 14px rgba(0, 0, 0, 0.55)) drop-shadow(0 0 10px rgba(47, 111, 237, 0.35));
    animation: floaty 7s ease-in-out infinite alternate;
  }

  .cube.c1 { width: 30px; height: 30px; left: 4%;  top: 16%; opacity: 0.9; }
  .cube.c2 { width: 16px; height: 16px; left: 10%; top: 64%; opacity: 0.55; animation-delay: -2.2s; }
  .cube.c3 { width: 22px; height: 22px; right: 7%; top: 46%; opacity: 0.8; animation-delay: -3.8s; }
  .cube.c4 { width: 13px; height: 13px; right: 16%; top: 12%; opacity: 0.45; animation-delay: -1.4s; }
  .cube.c5 { width: 18px; height: 18px; right: 26%; bottom: 8%; opacity: 0.5; animation-delay: -5s; }
  .cube.c6 { width: 11px; height: 11px; left: 30%; bottom: 12%; opacity: 0.4; animation-delay: -3s; }

  @keyframes floaty {
    from { transform: translateY(-9px) rotate(-2deg); }
    to   { transform: translateY(9px) rotate(3deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .cube, body::before, .logo::after { animation: none !important; }
    * { scroll-behavior: auto !important; }
  }

  .wrap {
    position: relative;
    z-index: 1;
    max-width: 960px;
    margin: 0 auto;
    padding: 48px 28px 96px;
  }

  /* ─ Header ── */
  header {
    display: flex;
    align-items: center;
    gap: 24px;
    margin-bottom: 40px;
    padding-bottom: 32px;
    border-bottom: 1px solid var(--border);
    position: relative;
  }

  header::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(59, 125, 255, 0.55), transparent);
  }

  /* Right-side hero composition: soft glow + glossy cube stack. Purely
     decorative, hidden on narrow screens. */
  .hero-decor {
    position: absolute;
    right: -60px;
    top: -40px;
    width: 300px;
    height: 220px;
    pointer-events: none;
    z-index: 0;
  }

  .hero-glow {
    position: absolute;
    right: 0px;
    top: 66px;
    width: 240px;
    height: 160px;
    background: radial-gradient(closest-side, rgba(74, 140, 255, 0.4), rgba(74, 140, 255, 0.12) 62%, transparent);
    filter: blur(6px);
    border-radius: 50%;
  }

  .hero-decor .cube { animation: floaty 8s ease-in-out infinite alternate; }
  .hero-decor .cube.h1c { width: 68px; height: 68px; right: 42px; top: 112px; opacity: 1; }
  .hero-decor .cube.h2c { width: 32px; height: 32px; right: 118px; top: 152px; opacity: 0.85; animation-delay: -2.6s; }
  .hero-decor .cube.h3c { width: 22px; height: 22px; right: 132px; top: 106px; opacity: 0.7; animation-delay: -4.4s; }
  .hero-decor .cube.h4c { width: 16px; height: 16px; right: 10px; top: 30px; opacity: 0.55; animation-delay: -1.8s; }

  .logo-wrap {
    position: relative;
    flex-shrink: 0;
    z-index: 1;
  }

  .logo {
    width: 58px;
    height: 58px;
    border-radius: 16px;
    /* Glossy 3D cube tile: top-left light source, deep shadowed face */
    background: linear-gradient(145deg, #4a8cff 0%, #2f6fed 55%, #1e56d6 100%);
    display: grid;
    place-items: center;
    color: #fff;
    font-weight: 800;
    font-size: 26px;
    text-shadow: 0 2px 6px rgba(4, 6, 11, 0.4);
    box-shadow:
      0 10px 26px rgba(47, 111, 237, 0.45),
      0 0 24px rgba(59, 125, 255, 0.3),
      inset 0 2px 6px rgba(255, 255, 255, 0.5),
      inset 0 -7px 14px rgba(16, 42, 100, 0.35);
    position: relative;
    z-index: 1;
    transition: transform var(--transition), box-shadow var(--transition);
  }

  .logo-wrap:hover .logo {
    transform: scale(1.05) rotate(-2deg);
    box-shadow:
      0 14px 32px rgba(47, 111, 237, 0.55),
      0 0 32px rgba(59, 125, 255, 0.4),
      inset 0 2px 6px rgba(255, 255, 255, 0.55),
      inset 0 -7px 14px rgba(16, 42, 100, 0.35);
  }

  .logo::after {
    content: '';
    position: absolute;
    inset: -6px;
    border-radius: 22px;
    background: linear-gradient(135deg, #4a8cff, #1e56d6);
    opacity: 0.4;
    filter: blur(18px);
    z-index: 0;
    animation: logoGlow 3s ease-in-out infinite;
  }

  @keyframes logoGlow {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.5; }
  }

  .header-text { flex: 1; position: relative; z-index: 1; }

  h1 {
    font-size: 30px;
    font-weight: 800;
    letter-spacing: -0.6px;
    line-height: 1.25;
    color: var(--ink);
    margin-bottom: 6px;
  }

  /* The "Smarter Tomorrow" accent line */
  h1 .hl { color: var(--accent-bright); }

  .sub {
    color: var(--text-secondary);
    font-size: 14px;
    max-width: 560px;
    line-height: 1.65;
  }

  .head-right { margin-left: auto; position: relative; z-index: 1; }

  /* ── Glass Panel ── */
  .panel {
    background: var(--surface);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 28px;
    margin-top: 28px;
    box-shadow: var(--shadow);
    transition: all var(--transition);
    position: relative;
    overflow: hidden;
  }

  .panel::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.16), transparent);
  }

  .panel:hover {
    border-color: var(--border-hover);
    box-shadow: var(--shadow-lg);
  }

  .panel h2 {
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 8px;
    letter-spacing: -0.2px;
    color: var(--ink);
  }

  .panel .p-sub {
    color: var(--text-secondary);
    font-size: 13px;
    margin: 0 0 20px;
    line-height: 1.6;
  }

  /* ── Smart Router Toggle ── */
  .toggle-card {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 22px 28px;
    background: linear-gradient(135deg, rgba(59, 125, 255, 0.1), rgba(59, 125, 255, 0.03));
  }

  .t-info { flex: 1; min-width: 0; }

  .t-title {
    font-weight: 700;
    font-size: 15.5px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    color: var(--ink);
  }

  .t-title::before {
    content: '✨';
    font-size: 16px;
  }

  .t-sub {
    color: var(--text-muted);
    font-size: 12.5px;
    margin-top: 6px;
    line-height: 1.6;
  }

  .switch {
    position: relative;
    width: 56px;
    height: 32px;
    flex-shrink: 0;
    cursor: pointer;
  }

  .switch input {
    opacity: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    cursor: pointer;
    position: absolute;
    z-index: 2;
  }

  .switch .track {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    border: 2px solid var(--border-strong);
    transition: all var(--transition);
  }

  .switch .knob {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #aab6cf;
    transition: all var(--transition);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  }

  .switch input:checked ~ .track {
    background: linear-gradient(135deg, rgba(74, 140, 255, 0.4), rgba(30, 86, 214, 0.35));
    border-color: rgba(74, 140, 255, 0.6);
    box-shadow: 0 0 20px rgba(59, 125, 255, 0.25);
  }

  .switch input:checked ~ .knob {
    left: 28px;
    background: linear-gradient(135deg, var(--accent-glow-soft), var(--accent-dark));
    box-shadow: 0 0 16px rgba(59, 125, 255, 0.5);
  }

  .t-state {
    font-size: 10.5px;
    font-weight: 800;
    padding: 4px 12px;
    border-radius: 999px;
    letter-spacing: 1px;
    transition: all var(--transition);
    text-transform: uppercase;
  }

  .t-state.on {
    color: var(--ok);
    background: var(--ok-glow);
    border: 1px solid var(--border-success);
    box-shadow: 0 0 12px rgba(52, 211, 119, 0.15);
  }

  .t-state.off {
    color: var(--bad);
    background: var(--bad-glow);
    border: 1px solid var(--border-error);
  }

  .t-state.unknown {
    color: var(--warn);
    background: var(--warn-glow);
    border: 1px solid rgba(245, 166, 35, 0.35);
  }

  /* ── JEV Mode stats line ── */
  .jev-stats {
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-dim);
    font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    line-height: 1.6;
    letter-spacing: -0.2px;
  }

  .jev-stats .sep { color: var(--text-muted); padding: 0 6px; }

  /* ── Routing Activity panel ── */
  .route-row {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .route-row:last-child { border-bottom: none; }
  .route-time {
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 11px;
  }
  .route-asked { color: var(--text-secondary); }
  .route-arrow { color: var(--text-muted); }
  .route-final { font-weight: 700; color: var(--ink); }
  .route-final.ok { color: var(--ok); }
  .route-final.bad { color: var(--bad-bright); }
  .route-switches {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 11.5px;
    white-space: nowrap;
  }
  .route-detail {
    padding: 2px 12px 10px 58px;
    color: var(--text-dim);
    font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.7;
    word-break: break-word;
  }
  .route-detail .fail { color: var(--bad); opacity: 0.85; }

  .notice-opt {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 14px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    text-transform: none;
    letter-spacing: 0;
  }
  .notice-opt input { width: auto; accent-color: var(--accent); cursor: pointer; }

  /* ── Toolbar ── */
  .toolbar {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-top: 28px;
    flex-wrap: wrap;
  }

  .search {
    flex: 1;
    min-width: 220px;
    position: relative;
  }

  .search svg {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    width: 17px;
    height: 17px;
    stroke: var(--text-faint);
    fill: none;
    stroke-width: 2;
    transition: stroke var(--transition-fast);
  }

  .search:focus-within svg {
    stroke: var(--accent-bright);
  }

  .search input {
    width: 100%;
    padding: 12px 16px 12px 42px;
    background: var(--surface-strong);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1.5px solid var(--border);
    border-radius: var(--radius);
    color: var(--ink);
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: all var(--transition);
    box-shadow: var(--shadow-xs);
  }

  .search input:focus {
    border-color: var(--border-glow);
    box-shadow: 0 0 0 4px rgba(59, 125, 255, 0.15);
    background: var(--surface-solid);
  }

  .search input::placeholder { color: var(--text-muted); }

  #count {
    color: var(--text-muted);
    font-size: 13px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    padding: 0 4px;
  }

  /* ── Form Elements ── */
  label {
    display: block;
    font-size: 11.5px;
    font-weight: 700;
    color: var(--text-secondary);
    margin: 18px 0 8px;
    letter-spacing: 0.8px;
    text-transform: uppercase;
  }

  label:first-of-type { margin-top: 0; }

  label b {
    color: var(--bad);
    font-weight: 800;
  }

  input, select {
    width: 100%;
    background: var(--surface-strong);
    color: var(--ink);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: all var(--transition);
  }

  input:hover, select:hover {
    border-color: var(--border-hover);
  }

  input:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 4px rgba(59, 125, 255, 0.15);
    background: var(--surface-solid);
  }

  input::placeholder { color: var(--text-muted); }

  textarea {
    width: 100%;
    background: var(--surface-strong);
    color: var(--ink);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    font-size: 12.5px;
    line-height: 1.7;
    font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    outline: none;
    transition: all var(--transition);
    resize: vertical;
  }

  textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 4px rgba(59, 125, 255, 0.15);
  }

  select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%234a8cff' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 14px center;
    padding-right: 40px;
    cursor: pointer;
  }

  .frow {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  @media (max-width: 680px) {
    .frow { grid-template-columns: 1fr; }
  }

  /* ── Buttons ── */
  button {
    background: var(--surface);
    color: var(--text);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 20px;
    cursor: pointer;
    font-size: 13.5px;
    font-weight: 650;
    font-family: inherit;
    letter-spacing: 0.2px;
    transition: all var(--transition);
    white-space: nowrap;
    position: relative;
    overflow: hidden;
    box-shadow: var(--shadow-xs);
  }

  button::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(135deg, rgba(74, 140, 255, 0.12), transparent);
    opacity: 0;
    transition: opacity var(--transition);
  }

  button:hover::before {
    opacity: 1;
  }

  button:hover {
    background: var(--surface-hover);
    border-color: var(--border-hover);
    transform: translateY(-2px);
    box-shadow: var(--shadow-sm);
  }

  button:active {
    transform: translateY(0) scale(0.98);
  }

  button:focus-visible {
    outline: 2px solid var(--accent-bright);
    outline-offset: 2px;
  }

  button.primary {
    background: linear-gradient(135deg, #4a8cff 0%, #2f6fed 55%, #1e56d6 100%);
    color: #fff;
    border: none;
    font-weight: 700;
    text-shadow: 0 1px 4px rgba(4, 6, 11, 0.3);
    box-shadow: 0 6px 18px rgba(47, 111, 237, 0.4), 0 0 20px rgba(59, 125, 255, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.35);
  }

  button.primary:hover {
    filter: brightness(1.1);
    box-shadow: 0 8px 26px rgba(47, 111, 237, 0.5), 0 0 28px rgba(59, 125, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.4);
    transform: translateY(-2px);
  }

  button.primary:active {
    transform: translateY(0) scale(0.98);
  }

  button.danger {
    color: var(--bad);
    border-color: var(--border-error);
    background: rgba(255, 92, 82, 0.08);
  }

  button.danger:hover {
    background: rgba(255, 92, 82, 0.16);
    border-color: rgba(255, 92, 82, 0.6);
    box-shadow: 0 2px 16px rgba(255, 92, 82, 0.2);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .btn-sm {
    padding: 8px 14px;
    font-size: 12.5px;
    border-radius: var(--radius-xs);
  }

  .row {
    display: flex;
    gap: 14px;
    margin-top: 28px;
    align-items: center;
  }

  .spacer { flex: 1; }

  /* ── Toast ── */
  #toast {
    position: fixed;
    left: 50%;
    bottom: 40px;
    transform: translateX(-50%) translateY(20px);
    background: rgba(13, 17, 26, 0.95);
    border: 1.5px solid var(--border-strong);
    color: var(--ink);
    border-radius: var(--radius);
    padding: 14px 24px;
    font-size: 13.5px;
    font-weight: 600;
    font-family: inherit;
    box-shadow: var(--shadow-xl);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.35s ease, transform 0.35s ease;
    max-width: 92vw;
    z-index: 100;
    min-width: 200px;
    text-align: center;
  }

  #toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  #toast.ok {
    border-color: var(--border-success);
    box-shadow: var(--shadow-xl), 0 0 28px rgba(52, 211, 119, 0.15);
    background: linear-gradient(135deg, rgba(52, 211, 119, 0.1), rgba(13, 17, 26, 0.95));
  }

  #toast.bad {
    border-color: var(--border-error);
    box-shadow: var(--shadow-xl), 0 0 28px rgba(255, 92, 82, 0.15);
    background: linear-gradient(135deg, rgba(255, 92, 82, 0.1), rgba(13, 17, 26, 0.95));
  }

  #toast .ok { color: var(--ok); }
  #toast .bad { color: var(--bad); }

  /* ── Model Cards ── */
  #list {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 20px;
  }

  .card {
    background: var(--surface);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1.5px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 18px 20px;
    display: flex;
    align-items: center;
    gap: 18px;
    transition: all var(--transition);
    animation: cardIn 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
    position: relative;
    overflow: hidden;
  }

  .card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 3px;
    height: 100%;
    background: linear-gradient(180deg, #4a8cff, #1e56d6);
    opacity: 0;
    transition: opacity var(--transition);
  }

  .card:hover::before {
    opacity: 1;
  }

  .card:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
    box-shadow: var(--shadow);
    transform: translateY(-3px);
  }

  @keyframes cardIn {
    from { opacity: 0; transform: translateY(16px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .card.testing {
    border-color: var(--border-glow);
    box-shadow: 0 0 24px rgba(59, 125, 255, 0.2);
  }

  .card .info { flex: 1; min-width: 0; }

  .card .name {
    font-weight: 700;
    font-size: 15px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--ink);
  }

  .model-dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: linear-gradient(135deg, #4a8cff, #1e56d6);
    flex-shrink: 0;
    box-shadow: 0 0 10px rgba(59, 125, 255, 0.55);
    transition: all var(--transition);
  }

  .card:hover .model-dot {
    box-shadow: 0 0 14px rgba(59, 125, 255, 0.75);
    transform: scale(1.15);
  }

  .card.off .model-dot {
    background: var(--text-muted);
    box-shadow: none;
  }

  .badge {
    font-size: 10.5px;
    font-weight: 800;
    padding: 4px 11px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    background: rgba(59, 125, 255, 0.14);
    color: var(--accent-bright);
    border: 1px solid rgba(59, 125, 255, 0.3);
    transition: all var(--transition);
  }

  .card:hover .badge {
    border-color: rgba(74, 140, 255, 0.5);
    background: rgba(59, 125, 255, 0.2);
  }

  .card .url {
    color: var(--text-muted);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 5px;
    font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    letter-spacing: -0.2px;
  }

  .card .key {
    color: var(--text-muted);
    font-size: 11.5px;
    margin-top: 3px;
    font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  }

  .card .actions {
    display: flex;
    gap: 7px;
    align-items: center;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .card .actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    font-size: 12.5px;
  }

  .test-status {
    font-size: 11.5px;
    font-weight: 700;
    padding: 4px 12px;
    border-radius: 999px;
    white-space: nowrap;
    letter-spacing: 0.3px;
  }

  .test-status.pass {
    color: var(--ok);
    background: var(--ok-glow);
    border: 1px solid var(--border-success);
  }

  .test-status.fail {
    color: var(--bad);
    background: var(--bad-glow);
    border: 1px solid var(--border-error);
  }

  .test-status.none { display: none; }

  .spin {
    width: 13px;
    height: 13px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent-bright);
    border-radius: 50%;
    animation: rot 0.7s linear infinite;
    display: inline-block;
  }

  @keyframes rot {
    to { transform: rotate(360deg); }
  }

  .off-badge {
    font-size: 10px;
    font-weight: 800;
    padding: 3px 9px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-faint);
    border: 1px solid var(--border-strong);
  }

  button.offbtn {
    color: var(--warn);
    border-color: rgba(245, 166, 35, 0.35);
    background: rgba(245, 166, 35, 0.08);
  }

  button.offbtn:hover {
    background: rgba(245, 166, 35, 0.16);
    border-color: rgba(245, 166, 35, 0.55);
  }

  button.onbtn {
    color: var(--text-secondary);
    border-color: var(--border-strong);
    background: var(--surface);
  }

  button.onbtn:hover {
    background: var(--surface-hover);
    border-color: var(--border-hover);
    color: var(--ok);
  }

  .card.off .name span:not(.off-badge):not(.badge):not(.model-dot),
  .card.off .url,
  .card.off .key {
    opacity: 0.45;
  }

  /* ── Empty States ── */
  .empty {
    text-align: center;
    color: var(--text-muted);
    padding: 64px 20px;
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    background: rgba(255, 255, 255, 0.02);
    animation: fadeIn 0.5s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .empty .big {
    font-size: 42px;
    margin-bottom: 14px;
    display: block;
    filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.45));
  }

  .empty p {
    font-size: 14px;
    color: var(--text-secondary);
    margin-top: 6px;
    line-height: 1.6;
  }

  /* ── Status & Results ── */
  #status {
    min-height: 24px;
    font-size: 13.5px;
    margin: 20px 0 0;
    font-weight: 600;
  }

  #status .ok { color: var(--ok); }
  #status .bad { color: var(--bad); }

  #testResult {
    font-size: 13.5px;
    margin-top: 16px;
    min-height: 22px;
    font-weight: 600;
  }

  #testResult .ok { color: var(--ok); }
  #testResult .bad { color: var(--bad); }

  .hint {
    color: var(--text-muted);
    font-size: 12.5px;
    margin-top: 16px;
    font-style: italic;
    line-height: 1.6;
  }

  /* ── Responsive: stack cards + toolbar on narrow screens ── */
  .key-wrap { position: relative; }
  .key-wrap input { padding-right: 48px; }
  .key-toggle {
    position: absolute;
    right: 7px;
    top: 50%;
    transform: translateY(-50%);
    padding: 5px 11px;
    font-size: 12px;
    border-radius: var(--radius-xs);
  }
  @media (max-width: 1080px) {
    .hero-decor { display: none; }
  }
  @media (max-width: 680px) {
    .wrap { padding: 28px 16px 72px; }
    header { flex-wrap: wrap; gap: 16px; }
    .head-right { margin-left: 0; width: 100%; }
    .head-right button { width: 100%; }
    .card { flex-direction: column; align-items: stretch; }
    .card .actions { justify-content: flex-start; margin-top: 12px; }
    .toolbar { flex-direction: column; align-items: stretch; }
    .search { min-width: 0; }
    .bg-decor { display: none; }
  }
</style>
</head>
<body>
<div class="bg-decor" aria-hidden="true">
  <span class="cube c1"></span><span class="cube c2"></span><span class="cube c3"></span>
  <span class="cube c4"></span><span class="cube c5"></span><span class="cube c6"></span>
</div>
<div class="wrap">
  <header>
    <div class="hero-decor" aria-hidden="true">
      <span class="hero-glow"></span>
      <span class="cube h1c"></span><span class="cube h2c"></span>
      <span class="cube h3c"></span><span class="cube h4c"></span>
    </div>
    <div class="logo-wrap">
      <div class="logo">J</div>
    </div>
    <div class="header-text">
      <h1>Intelligent Models for a<br><span class="hl">Smarter Tomorrow</span></h1>
      <p class="sub">Manage your AI model connections right here: add, test, and organize without touching any config files.</p>
    </div>
    <div class="head-right">
      <button id="addBtn" class="primary">+ Add Model</button>
    </div>
  </header>

  <!-- Smart Router Toggle -->
  <div class="panel toggle-card">
    <div class="t-info">
      <div class="t-title">
        Auto Rotation / Smart Router
        <span class="t-state unknown" id="autoState">…</span>
      </div>
      <div class="t-sub">When ON, failed requests automatically rotate to another model, and "Auto (Smart Router)" picks the best option per request. When OFF, requests go straight to the selected model.</div>
    </div>
    <label class="switch" title="Toggle Auto Rotation / Smart Router">
      <input type="checkbox" id="autoToggle" checked>
      <span class="track"></span><span class="knob"></span>
    </label>
  </div>

  <!-- JEV Mode Toggle -->
  <div class="panel toggle-card">
    <div class="t-info">
      <div class="t-title">
        JEV Mode · Smart Context Compaction
        <span class="t-state unknown" id="jevState">…</span>
      </div>
      <div class="t-sub">When a request outgrows the best model's context window, JEV live-tests your models and asks the healthiest one which old tool calls and results are still needed. Everything kept stays verbatim (no lossy summaries). Unresponsive or failing models are detected and bypassed automatically. Falls back to local compression if every judge fails.</div>
      <div class="jev-stats" id="jevStats"></div>
    </div>
    <label class="switch" title="Toggle JEV Mode">
      <input type="checkbox" id="jevToggle" checked>
      <span class="track"></span><span class="knob"></span>
    </label>
  </div>

  <!-- Routing Activity -->
  <div class="panel">
    <h2>Routing Activity</h2>
    <p class="p-sub">What the smart router actually did per request. The IDE picker keeps showing the model you selected; switches happen here, invisibly. This panel shows who really answered.</p>
    <label class="notice-opt" title="Prepend a short routed-note as the answer's first thinking part, visible in the IDE">
      <input type="checkbox" id="noticeToggle" checked>
      Show switch note in the answer (default OFF, the IDE status bar shows the routing instead)
    </label>
    <div id="routingList"><div class="empty"><span class="big">🧭</span>No requests routed yet<p>Send a message in the IDE and it will show up here within a few seconds.</p></div></div>
  </div>

  <!-- Search Toolbar -->
  <div class="toolbar">
    <div class="search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="search" placeholder="Search models, providers, URLs…" autocomplete="off">
    </div>
    <div id="count"></div>
    <button class="btn-sm" id="testAllBtn" title="Ping every model and mark the ones that respond">⚡ Test All</button>
    <button class="btn-sm" id="refreshBtn" title="Refresh model list">↻ Refresh</button>
  </div>

  <div id="status" aria-live="polite"></div>
  <div id="list"><div class="empty"><span class="big">⏳</span>Loading models…</div></div>

  <!-- Unified Gateway -->
  <div class="panel" id="gatewayPanel">
    <h2>Unified API Key · Claude Code &amp; Any Tool</h2>
    <p class="p-sub">Point any Anthropic-compatible tool at this proxy. Any model name is accepted: <b>claude-sonnet-4-5</b> and other Claude names route to your best enabled model automatically; a custom model's exact name pins it.</p>

    <label>Base URL</label>
    <input id="gwBase" readonly>

    <label>API Key (sent as x-api-key or Authorization: Bearer)</label>
    <div class="key-wrap">
      <input id="gwKey" readonly type="password">
      <button type="button" class="key-toggle btn-sm" id="gwShow">Show</button>
    </div>

    <label>Claude Code setup (run in a NEW terminal, then start claude)</label>
    <textarea id="gwSnippet" readonly rows="7" spellcheck="false"></textarea>

    <div class="row">
      <button id="gwCopy">Copy snippet</button>
      <button id="gwRegen" class="danger">Regenerate Key</button>
      <div class="spacer"></div>
    </div>
    <p class="hint">Keep this key private: anyone with it can use your configured models. Regenerate if it leaks (tools must be updated with the new key).</p>
  </div>

  <!-- Add Model Form -->
  <div class="panel" id="addPanel">
    <h2>Add a New Model</h2>
    <p class="p-sub">Choose your provider, give the model an identifier, and paste your API key. Hit Test first to make sure everything works.</p>

    <label>API Provider</label>
    <select id="provider">${providerOptions}</select>

    <div class="frow">
      <div>
        <label>Model ID <b>*</b></label>
        <input id="id" placeholder="e.g. gpt-4o, claude-opus-4-20250514">
      </div>
      <div>
        <label>Display Name</label>
        <input id="displayName" placeholder="e.g. GPT-4o Production">
      </div>
    </div>

    <div class="frow">
      <div>
        <label>API Key <b id="keyReq">*</b></label>
        <div class="key-wrap">
          <input id="apiKey" type="password" placeholder="sk-…" autocomplete="off">
          <button type="button" class="key-toggle btn-sm" id="keyToggle" title="Show / hide API key">Show</button>
        </div>
      </div>
      <div>
        <label>API Endpoint</label>
        <input id="apiUrl" placeholder="https://api.openai.com/v1/chat/completions">
      </div>
    </div>

    <div class="row">
      <button id="testBtn">⟳ Test Connection</button>
      <div class="spacer"></div>
      <button id="saveBtn" class="primary">Save Model</button>
    </div>

    <div id="testResult" aria-live="polite"></div>
    <p class="hint">Endpoint URLs are pre-filled per provider. Only change them for custom gateways or self-hosted endpoints.</p>
  </div>
</div>

<div id="toast" role="status"></div>

<script>
(function () {
  var URLS = ${defaultUrls};
  var NEEDS_KEY = ${needsKey};
  var provider = document.getElementById('provider');
  var idEl = document.getElementById('id');
  var nameEl = document.getElementById('displayName');
  var keyEl = document.getElementById('apiKey');
  var urlEl = document.getElementById('apiUrl');
  var keyReq = document.getElementById('keyReq');
  var list = document.getElementById('list');
  var status = document.getElementById('status');
  var testResult = document.getElementById('testResult');
  var searchEl = document.getElementById('search');
  var countEl = document.getElementById('count');
  var toastEl = document.getElementById('toast');
  var testStatuses = {};
  var testingNames = {};
  var models = [];

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // ponytail: esc() leaves quotes intact (textContent path), which breaks
  // data-* attributes when a name contains " or '. Always use attr() there.
  function attr(s) { return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  var toastTimer = null;
  function toast(msg, cls) {
    toastEl.innerHTML = '<span class="' + (cls || '') + '">' + esc(msg) + '</span>';
    toastEl.className = 'show ' + (cls || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 3500);
  }

  // fetchJSON: fetch with a timeout + automatic retries, so a request that
  // fires during a proxy restart recovers instead of hanging forever.
  function fetchJSON(url, opts, tries) {
    opts = opts || {};
    var max = tries || 4;
    return new Promise(function (resolve, reject) {
      var attempt = 0;
      function go() {
        attempt++;
        var done = false;
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
        fetch(url, ctrl ? Object.assign({}, opts, { signal: ctrl.signal }) : opts).then(function (r) {
          if (timer) clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function (j) {
          if (done) return;
          done = true;
          resolve(j);
        }).catch(function (e) {
          if (done) return;
          done = true;
          if (attempt >= max) { reject(e); return; }
          setTimeout(go, 700);
        });
      }
      go();
    });
  }

  function note(msg, cls) { status.innerHTML = '<span class="' + (cls || '') + '">' + esc(msg) + '</span>'; }

  // ponytail: only auto-fill the endpoint when the field is empty or still
  // holds a known preset, never clobber a hand-typed custom URL.
  var KNOWN_URLS = {};
  Object.keys(URLS).forEach(function (k) { KNOWN_URLS[URLS[k]] = true; });
  function applyProvider() {
    var p = provider.value;
    var cur = (urlEl.value || '').trim();
    if (!cur || KNOWN_URLS[cur]) urlEl.value = URLS[p] || '';
    keyEl.placeholder = NEEDS_KEY[p] === false ? 'No key needed' : 'sk-…';
    keyReq.style.display = NEEDS_KEY[p] === false ? 'none' : 'inline';
  }
  provider.addEventListener('change', applyProvider);
  applyProvider();

  document.getElementById('addBtn').addEventListener('click', function () {
    document.getElementById('addPanel').scrollIntoView({ behavior: 'smooth' });
    setTimeout(function () { idEl.focus(); }, 400);
  });

  document.getElementById('refreshBtn').addEventListener('click', function () { load(); toast('Refreshing…', 'ok'); });

  function cardHtml(m) {
    var ts = testStatuses[m.name];
    var testing = testingNames[m.name];
    var statusHtml = '';
    if (testing) statusHtml = '<span class="test-status pass"><span class="spin"></span></span>';
    else if (ts === 'pass') statusHtml = '<span class="test-status pass">✓ Passed</span>';
    else if (ts === 'fail') statusHtml = '<span class="test-status fail">✕ Failed</span>';
    var offBadge = m.disabled ? ' <span class="off-badge">Disabled</span>' : '';
    return '<div class="card' + (testing ? ' testing' : '') + (m.disabled ? ' off' : '') + '" data-name="' + attr(m.name) + '">' +
      '<div class="info"><div class="name">' +
      '<span class="model-dot"></span>' +
      esc(m.displayName) + offBadge + ' <span class="badge">' + esc(m.provider) + '</span></div>' +
      '<div class="url" title="' + attr(m.apiUrl) + '">' + esc(m.apiUrl) + '</div>' +
      '<div class="key">' + esc(m.externalModelName) + (m.keyMasked ? ' · key ' + esc(m.keyMasked) : '') + '</div></div>' +
      '<div class="actions">' +
      '<button class="r btn-sm" data-action="reuse" data-name="' + attr(m.name) + '" data-provider="' + attr(m.provider) + '" data-url="' + attr(m.apiUrl) + '" data-extname="' + attr(m.externalModelName) + '" data-display="' + attr(m.displayName) + '" title="Reuse this model&#39;s settings">Reuse</button>' +
      '<button class="t btn-sm" data-action="test" data-name="' + attr(m.name) + '" title="Test connection">Test</button>' +
      '<button class="' + (m.disabled ? 'onbtn' : 'offbtn') + ' btn-sm" data-action="toggle" data-name="' + attr(m.name) + '" data-disabled="' + (m.disabled ? '1' : '') + '" title="' + (m.disabled ? 'Enable this model' : 'Disable this model') + '">' + (m.disabled ? 'Enable' : 'Disable') + '</button>' +
      statusHtml +
      '<button class="danger d btn-sm" data-action="delete" data-name="' + attr(m.name) + '" title="Delete this model">Delete</button>' +
      '</div></div>';
  }

  function matches(m, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (m.displayName + ' ' + m.name + ' ' + m.provider + ' ' + m.apiUrl + ' ' + m.externalModelName).toLowerCase().indexOf(q) !== -1;
  }

  function render() {
    var q = (searchEl.value || '').trim();
    var shown = models.filter(function (m) { return matches(m, q); });
    countEl.textContent = models.length ? (shown.length + ' of ' + models.length) : '';
    if (!models.length) {
      list.innerHTML = '<div class="empty"><span class="big">🧩</span>No models yet<p>Add your first model below to get started.</p></div>';
      return;
    }
    if (!shown.length) {
      list.innerHTML = '<div class="empty"><span class="big">🔍</span>No models match "<em>' + esc(q) + '</em>"</div>';
      return;
    }
    list.innerHTML = shown.map(cardHtml).join('');
  }

  function load() {
    fetchJSON('/api/models', {}, 6).then(function (data) {
      models = data.models || [];
      render();
    }).catch(function (e) {
      list.innerHTML = '<div class="empty"><span class="big">⚠️</span>Failed to load<p>' + esc(e.message) + '</p></div>';
      note('Failed to load models', 'bad');
    });
  }
  searchEl.addEventListener('input', render);

  // ── Routing Activity: who actually answered each request ──
  var routingList = document.getElementById('routingList');

  function fmtTime(ts) { var d = new Date(ts); return d.toTimeString().slice(0, 8); }

  function renderRouting(events) {
    if (!events.length) return; // keep the empty state
    routingList.innerHTML = events.map(function (e) {
      var pct = e.jev && e.jev.tokensBefore > 0
        ? Math.max(0, Math.round((1 - e.jev.tokensAfter / e.jev.tokensBefore) * 100))
        : 0;
      var head =
        '<div class="route-row">' +
        '<span class="route-time">' + fmtTime(e.ts) + '</span>' +
        '<span class="route-asked">' + esc(e.requested) + '</span>' +
        '<span class="route-arrow">&rarr;</span>' +
        '<span class="route-final ' + (e.ok ? 'ok' : 'bad') + '">' + esc(e.final) + '</span>' +
        (e.jev ? ' <span class="badge">JEV -' + pct + '%</span>' : '') +
        '<span class="route-switches">' +
        (e.attempts.length ? e.attempts.length + ' switch' + (e.attempts.length > 1 ? 'es' : '') : 'direct') +
        ' · ' + (e.durationMs / 1000).toFixed(1) + 's' +
        (e.isStream ? ' · stream' : '') +
        '</span></div>';
      var detail = e.attempts.length
        ? '<div class="route-detail">' +
          e.attempts.map(function (a) {
            return '<span class="fail">' + esc(a.model) + '</span>: ' + esc(a.reason);
          }).join(' &rarr; ') +
          '</div>'
        : '';
      return head + detail;
    }).join('');
  }

  function loadRouting() {
    fetchJSON('/api/routing/recent', {}, 2).then(function (d) {
      renderRouting(d.events || []);
    }).catch(function () { /* proxy restart etc, try again next tick */ });
  }
  setInterval(loadRouting, 4000);
  loadRouting();

  // ── Switch notice toggle (in-IDE routing note) ──
  var noticeToggle = document.getElementById('noticeToggle');
  noticeToggle.addEventListener('change', function () {
    var on = noticeToggle.checked;
    noticeToggle.disabled = true;
    fetch('/api/router/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ switchNotice: on }) }).then(function (r) { return r.json(); }).then(function (s) {
        noticeToggle.disabled = false;
        if (s.error) { toast('Toggle failed: ' + s.error, 'bad'); loadAutoState(); return; }
        noticeToggle.checked = !!s.switchNotice;
        toast('Switch note inside the IDE is now ' + (s.switchNotice ? 'ON' : 'OFF'), s.switchNotice ? 'ok' : 'bad');
      }).catch(function () { noticeToggle.disabled = false; toast('Network error', 'bad'); loadAutoState(); });
  });

  // ── Auto Rotation / Smart Router + JEV Mode switches ──
  var autoToggle = document.getElementById('autoToggle');
  var autoState = document.getElementById('autoState');
  var jevToggle = document.getElementById('jevToggle');
  var jevState = document.getElementById('jevState');
  var jevStats = document.getElementById('jevStats');

  function fmtK(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }

  function renderJevStats(s) {
    if (!s) { jevStats.style.display = 'none'; jevStats.innerHTML = ''; return; }
    jevStats.style.display = 'block';
    if (s.fellBack) {
      jevStats.innerHTML = 'Last JEV run: fell back to local compression<span class="sep">·</span>judge: ' + esc(s.judge);
      return;
    }
    jevStats.innerHTML =
      'Last JEV compaction: ~' + fmtK(s.tokensBefore) + ' &rarr; ~' + fmtK(s.tokensAfter) + ' tokens' +
      '<span class="sep">·</span>' + s.callsKept + ' calls kept, ' + s.callsDropped + ' dropped' +
      (s.resultsTruncated ? ', ' + s.resultsTruncated + ' truncated' : '') +
      '<span class="sep">·</span>judge: ' + esc(s.judge) +
      '<span class="sep">·</span>' + (s.durationMs / 1000).toFixed(1) + 's';
  }

  function renderAutoState(on) {
    autoToggle.checked = on;
    autoState.textContent = on ? 'ON' : 'OFF';
    autoState.className = 't-state ' + (on ? 'on' : 'off');
  }

  function renderJevState(on) {
    jevToggle.checked = on;
    jevState.textContent = on ? 'ON' : 'OFF';
    jevState.className = 't-state ' + (on ? 'on' : 'off');
  }

  function loadAutoState() {
    fetchJSON('/api/router/status', {}, 5).then(function (s) {
      renderAutoState(!!s.autoRouter);
      renderJevState(!!s.jevMode);
      renderJevStats(s.jev || null);
      noticeToggle.checked = !!s.switchNotice;
    }).catch(function () {
      autoState.className = 't-state unknown'; autoState.textContent = '?';
      jevState.className = 't-state unknown'; jevState.textContent = '?';
    });
  }
  autoToggle.addEventListener('change', function () {
    var turningOn = autoToggle.checked;
    autoToggle.disabled = true;
    toast(turningOn ? 'Enabling smart router…' : 'Disabling smart router…', 'ok');
    fetch('/api/router/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: turningOn }) }).then(function (r) { return r.json(); }).then(function (s) {
        autoToggle.disabled = false;
        if (s.error) { note('Toggle failed: ' + s.error, 'bad'); toast('Something went wrong', 'bad'); loadAutoState(); return; }
        renderAutoState(!!s.autoRouter);
        toast('Smart router is now ' + (s.autoRouter ? 'ON' : 'OFF'), s.autoRouter ? 'ok' : 'bad');
      }).catch(function (e) {
        autoToggle.disabled = false;
        toast('Network error', 'bad'); loadAutoState();
      });
  });
  jevToggle.addEventListener('change', function () {
    var turningOn = jevToggle.checked;
    jevToggle.disabled = true;
    toast(turningOn ? 'Enabling JEV mode…' : 'Disabling JEV mode…', 'ok');
    fetch('/api/router/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jevMode: turningOn }) }).then(function (r) { return r.json(); }).then(function (s) {
        jevToggle.disabled = false;
        if (s.error) { note('Toggle failed: ' + s.error, 'bad'); toast('Something went wrong', 'bad'); loadAutoState(); return; }
        renderJevState(!!s.jevMode);
        toast('JEV mode is now ' + (s.jevMode ? 'ON' : 'OFF'), s.jevMode ? 'ok' : 'bad');
      }).catch(function (e) {
        jevToggle.disabled = false;
        toast('Network error', 'bad'); loadAutoState();
      });
  });
  loadAutoState();

  // ── Test All: ping every model, mark responders, report failures ──
  var testAllBtn = document.getElementById('testAllBtn');
  testAllBtn.addEventListener('click', function () {
    if (!models.length) { toast('No models to test yet', 'bad'); return; }
    testAllBtn.disabled = true;
    var oldLabel = testAllBtn.textContent;
    var i = 0;
    var okCount = 0;
    function next() {
      if (i >= models.length) {
        testAllBtn.disabled = false;
        testAllBtn.textContent = oldLabel;
        var healthy = okCount === models.length;
        toast('Test All: ' + okCount + '/' + models.length + ' models healthy', healthy ? 'ok' : 'bad');
        note('Test All: ' + okCount + '/' + models.length + ' models healthy. Unresponsive models are avoided by the smart router.', healthy ? 'ok' : 'bad');
        load();
        return;
      }
      var m = models[i++];
      testAllBtn.textContent = 'Testing ' + i + '/' + models.length + '…';
      testingNames[m.name] = true;
      render();
      fetch('/api/models/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: m.name }) }).then(function (r) { return r.json(); }).then(function (res) {
          delete testingNames[m.name];
          testStatuses[m.name] = res.ok ? 'pass' : 'fail';
          if (res.ok) okCount++;
          next();
        }).catch(function () {
          delete testingNames[m.name];
          testStatuses[m.name] = 'fail';
          next();
        });
    }
    next();
  });

  list.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== list && !(t.getAttribute && t.getAttribute('data-action'))) t = t.parentElement;
    if (!t || t === list) return;
    var action = t.getAttribute('data-action');
    var name = t.getAttribute('data-name');
    if (action === 'delete') {
      if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
      fetch('/api/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }) }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.error) { toast('Delete failed: ' + res.error, 'bad'); return; }
          toast('Removed "' + name + '"', 'ok');
          load();
        });
    } else if (action === 'test') {
      testingNames[name] = true; render();
      toast('Testing connection…');
      fetch('/api/models/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }) }).then(function (r) { return r.json(); }).then(function (res) {
          delete testingNames[name];
          testStatuses[name] = res.ok ? 'pass' : 'fail';
          toast(res.ok ? 'Connection successful!' : 'Connection failed: ' + res.message, res.ok ? 'ok' : 'bad');
          load();
        }).catch(function () { delete testingNames[name]; render(); });
    } else if (action === 'toggle') {
      var wasDisabled = t.getAttribute('data-disabled') === '1';
      fetch('/api/models/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, disabled: !wasDisabled }) }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.error) { toast('Toggle failed: ' + res.error, 'bad'); return; }
          toast(wasDisabled
            ? '"' + name + '" is back on'
            : '"' + name + '" has been disabled', wasDisabled ? 'ok' : 'bad');
          load();
        }).catch(function (e) { toast('Network error', 'bad'); });
    } else if (action === 'reuse') {
      var p = t.getAttribute('data-provider') || 'custom';
      var u = t.getAttribute('data-url') || '';
      var ext = t.getAttribute('data-extname') || '';
      var disp = t.getAttribute('data-display') || '';
      // ponytail: getAttribute decodes entities, so attr() above round-trips losslessly.
      if (!URLS[p]) p = 'custom';
      provider.value = p;
      applyProvider();
      idEl.value = ext;
      nameEl.value = disp;
      urlEl.value = u;
      keyEl.value = '';
      document.getElementById('addPanel').scrollIntoView({ behavior: 'smooth' });
      toast('Loading settings for "' + disp + '"…', 'ok');
      fetch('/api/models/key', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }) }).then(function (r) { return r.json(); }).then(function (res) {
           if (res.apiKey) {
             keyEl.value = res.apiKey;
             toast('All settings loaded, just hit Save!', 'ok');
           } else {
             keyEl.focus();
             toast('Settings loaded, enter your API key to continue.', 'ok');
           }
         }).catch(function () {
           keyEl.focus();
           toast('Settings loaded, enter your API key manually.', 'ok');
         });
    }
  });

  document.getElementById('keyToggle').addEventListener('click', function () {
    var show = keyEl.type === 'password';
    keyEl.type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  });

  document.getElementById('testBtn').addEventListener('click', function () {
    testResult.innerHTML = '<span class="hint"><span class="spin" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span> Testing connection…</span>';
    fetch('/api/models/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider.value, id: idEl.value, apiKey: keyEl.value, apiUrl: urlEl.value,
        displayName: nameEl.value }) }).then(function (r) { return r.json(); }).then(function (res) {
        testResult.innerHTML = '<span class="' + (res.ok ? 'ok' : 'bad') + '">' + (res.ok ? '✓ Connected' : '✕ Failed') + ' · ' + esc(res.message) + '</span>';
      }).catch(function (e) {
        testResult.innerHTML = '<span class="bad">✕ Network error: ' + esc(e.message) + '</span>';
      });
  });

  document.getElementById('saveBtn').addEventListener('click', function () {
    var saveBtn = this;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider.value, id: idEl.value, apiKey: keyEl.value, apiUrl: urlEl.value,
        displayName: nameEl.value }) }).then(function (r) { return r.json(); }).then(function (res) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Model';
        if (res.error) { toast(res.error, 'bad'); note(res.error, 'bad'); return; }
        toast('Saved "' + res.saved + '". It will show up in the IDE shortly.', 'ok');
        note('Saved "' + res.saved + '"', 'ok');
        idEl.value = ''; nameEl.value = ''; keyEl.value = '';
        keyEl.type = 'password';
        document.getElementById('keyToggle').textContent = 'Show';
        applyProvider();
        testResult.innerHTML = '';
        load();
      }).catch(function (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Model';
        toast('Save failed: ' + e.message, 'bad');
      });
  });

  // ── Unified Gateway: key + Claude Code setup snippet ──
  var gwBase = document.getElementById('gwBase');
  var gwKey = document.getElementById('gwKey');
  var gwSnippet = document.getElementById('gwSnippet');
  function loadGateway() {
    fetchJSON('/api/gateway/key', {}, 5).then(function (s) {
      var base = location.origin + '/v1';
      gwBase.value = base;
      gwKey.value = s.key;
      gwSnippet.value =
        'Windows (cmd), permanent:\\n' +
        'setx ANTHROPIC_BASE_URL ' + base + '\\n' +
        'setx ANTHROPIC_AUTH_KEY ' + s.key + '\\n\\n' +
        'PowerShell, current session:\\n' +
        '$env:ANTHROPIC_BASE_URL = "' + base + '"\\n' +
        '$env:ANTHROPIC_AUTH_KEY = "' + s.key + '"\\n\\n' +
        'bash:\\n' +
        'export ANTHROPIC_BASE_URL=' + base + '\\n' +
        'export ANTHROPIC_AUTH_KEY=' + s.key + '\\n\\n' +
        'then run: claude';
    }).catch(function () { gwBase.value = '(proxy unreachable)'; });
  }
  document.getElementById('gwShow').addEventListener('click', function () {
    var show = gwKey.type === 'password';
    gwKey.type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  });
  document.getElementById('gwCopy').addEventListener('click', function () {
    gwSnippet.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    if (!copied && navigator.clipboard) {
      navigator.clipboard.writeText(gwSnippet.value).then(function () { toast('Setup copied', 'ok'); });
      return;
    }
    toast(copied ? 'Setup copied' : 'Select the text and copy manually', copied ? 'ok' : 'bad');
  });
  document.getElementById('gwRegen').addEventListener('click', function () {
    if (!confirm('Regenerate the unified key? Tools already configured must be updated with the new key.')) return;
    fetch('/api/gateway/regenerate', { method: 'POST' }).then(function () { loadGateway(); toast('New key generated', 'ok'); });
  });
  loadGateway();

  load();
})();
</script>
</body>
</html>`;
}