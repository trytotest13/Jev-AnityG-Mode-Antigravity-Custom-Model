/**
 * End-to-end rotation test over REAL sockets (no http-module mocks).
 *
 * Starts the actual proxy server with Electron/electron-log stubbed and the
 * home directory pointed at a throwaway temp dir, plus three real mock
 * upstream servers. IDE-shaped requests then go through the whole path:
 * server -> model match -> rotation chain -> upstream dial -> client response.
 * Nothing here touches the user's real ~/.gemini/antigravity config.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ home: '' }));

vi.mock('electron', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  h.home = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'jev-e2e-'));
  // isolate the unified gateway key file inside the temp home
  process.env.JEV_UNIFIED_KEY_FILE = pathMod.join(h.home, 'unified_key.json');
  return {
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'home' ? h.home : pathMod.join(h.home, name)),
    },
    safeStorage: { isEncryptionAvailable: () => false },
  };
});
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// cryptoStore pulls electron via CJS require(), which vi.mock('electron')
// cannot intercept. Plain (non-encrypted) keys pass through unchanged in the
// real implementation too, so a passthrough mock is faithful.
vi.mock('../cryptoStore', () => ({
  encryptModels: (m: unknown[]) => m,
  decryptModels: (m: unknown[]) => m,
  backupFile: () => {},
  encryptString: (s: string) => s,
  decryptString: (s: string) => s,
}));

import { startProxy, stopProxy, getProxyPort, generateModelPlaceholderId } from '../proxy';
import { smartHealth } from '../proxy/smartHealth';
import type { CustomModel } from '../types';
import * as crypto from 'crypto';

// ─── Mock upstreams ───────────────────────────────────────────────────────

type Handler = (res: http.ServerResponse) => void;

interface Upstream {
  name: string;
  port: number;
  state: { dials: number; handler: Handler };
  server: http.Server;
}

const okJson = (name: string): Handler => (res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'pong-' + name } }] }));
};
const sse = (name: string): Handler => (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'pong-' + name } }] }) + '\n\n');
  res.end();
};
const status = (code: number): Handler => (res) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'upstream ' + code } }));
};
const sseEmpty: Handler = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end();
};

function makeUpstream(name: string, handler: Handler): Upstream {
  const state = { dials: 0, handler };
  const server = http.createServer((req, res) => {
    state.dials++;
    // Drain the request body, then answer.
    req.resume();
    req.on('end', () => state.handler(res));
  });
  return { name, port: 0, state, server };
}

const upA = makeUpstream('model-a', okJson('model-a'));
const upB = makeUpstream('model-b', okJson('model-b'));
const upC = makeUpstream('model-c', okJson('model-c'));
// model-d is configured but DISABLED (Off Model): it must never be listed in
// the IDE, never routed to by Auto, and a stale picker pick of it must
// redirect to an enabled model instead of erroring.
const upD = makeUpstream('model-d', okJson('model-d'));
const upstreams = [upA, upB, upC, upD];

function modelCfg(name: string, port: number) {
  return {
    name: 'models/' + name,
    displayName: name,
    description: 'e2e test model',
    provider: 'openai',
    apiKey: 'test-key-' + name,
    apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    externalModelName: name,
    maxRetries: 0,
    timeout: 5000,
  };
}

beforeAll(async () => {
  await Promise.all(
    upstreams.map(
      (u) =>
        new Promise<void>((resolve) => {
          u.server.listen(0, '127.0.0.1', () => {
            u.port = (u.server.address() as import('net').AddressInfo).port;
            resolve();
          });
        }),
    ),
  );

  const geminiDir = path.join(h.home, '.gemini', 'antigravity');
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(
    path.join(geminiDir, 'custom_models.json'),
    JSON.stringify({
      models: [
        modelCfg('model-a', upA.port),
        modelCfg('model-b', upB.port),
        modelCfg('model-c', upC.port),
        { ...modelCfg('model-d', upD.port), disabled: true },
      ],
    }),
    'utf-8',
  );

  await startProxy();
}, 15_000);

afterAll(async () => {
  await stopProxy();
  await Promise.all(upstreams.map((u) => new Promise<void>((r) => u.server.close(() => r()))));
  fs.rmSync(h.home, { recursive: true, force: true });
});

beforeEach(() => {
  smartHealth.clear();
  upstreams.forEach((u) => {
    u.state.dials = 0;
    u.state.handler = okJson(u.name);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function post(urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: getProxyPort(),
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
      },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => (out += c.toString('utf-8')));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: out }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function get(urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http.get(
      { host: '127.0.0.1', port: getProxyPort(), path: urlPath, headers },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => (out += c.toString('utf-8')));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: out }));
      },
    ).on('error', reject);
  });
}

function gatewayKey(): string {
  return JSON.parse(fs.readFileSync(path.join(h.home, 'unified_key.json'), 'utf-8')).key;
}

const chatBody = { contents: [{ role: 'user', parts: [{ text: 'hello there' }] }] };

// ─── Tests ────────────────────────────────────────────────────────────────

// The real IDE dials /v1internal:*generateContent (lowercase g, as the proxy
// matches it) with the model named in the JSON body: { model, request }.
function cloudPost(model: string, stream: boolean, body: unknown): Promise<{ status: number; text: string }> {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  return post(`/v1internal:${action}`, { model, request: body });
}

describe('proxy end-to-end rotation (real sockets)', () => {
  it('non-stream: 429 -> 401 down the chain -> fallback answers the client', async () => {
    upA.state.handler = status(429);
    upB.state.handler = status(401);
    // upC keeps the default 200 "pong-model-c"

    const r = await cloudPost('custom-openai-model-a', false, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toContain('pong-model-c');
    expect(upA.state.dials).toBe(1);
    expect(upB.state.dials).toBe(1);
    expect(upC.state.dials).toBe(1);
  }, 15_000);

  it('stream: 200-but-empty stream from primary -> fallback SSE reaches the client', async () => {
    upA.state.handler = sseEmpty;
    upB.state.handler = sse('model-b');

    const r = await cloudPost('custom-openai-model-a', true, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toContain('data:');
    expect(r.text).toContain('pong-model-b');
    expect(upA.state.dials).toBe(1);
    expect(upB.state.dials).toBe(1);
    expect(upC.state.dials).toBe(0);
  }, 15_000);

  it('stream: fast-fail statuses rotate before anything is committed', async () => {
    upA.state.handler = status(503);
    upB.state.handler = sse('model-b');

    const r = await cloudPost('custom-openai-model-a', true, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toContain('pong-model-b');
    expect(upA.state.dials).toBe(1);
    expect(upC.state.dials).toBe(0);
  }, 15_000);

  it('Auto (Smart Router): virtual model serves the request through exactly one upstream', async () => {
    const r = await cloudPost('custom-auto-router', false, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/pong-model-(a|b|c)/);
    const totalDials = upstreams.reduce((n, u) => n + u.state.dials, 0);
    expect(totalDials).toBe(1);
  }, 15_000);

  it('Auto (Smart Router) toggle OFF -> clear actionable error, no upstream dials', async () => {
    const settingsPath = path.join(h.home, '.gemini', 'antigravity', 'router_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ autoRouter: false }), 'utf-8');
    try {
      const r = await cloudPost('custom-auto-router', false, chatBody);
      expect(r.status).toBe(400);
      expect(r.text).toContain('turned OFF');
      const totalDials = upstreams.reduce((n, u) => n + u.state.dials, 0);
      expect(totalDials).toBe(0);
    } finally {
      fs.rmSync(settingsPath, { force: true });
    }
  }, 15_000);

  // ── Off Model (disabled) safety net ──────────────────────────────────────

  it('dashboard list marks the disabled model, routing excludes it', async () => {
    const r = await get('/api/models');
    expect(r.status).toBe(200);
    // Management view keeps the entry (so it can be re-enabled) with disabled: true.
    expect(r.text).toContain('"disabled":true');
    // The IDE-facing picks must never reach it.
    expect(upD.state.dials).toBe(0);
  });

  it('stale picker picks a disabled model -> redirects to the best enabled model', async () => {
    const r = await cloudPost('custom-openai-model-d', false, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/pong-model-(a|b|c)/);
    expect(upD.state.dials).toBe(0); // the disabled model itself is never dialed
  }, 15_000);

  it('stale disabled pick announces the Off Model reroute even with the switch notice off', async () => {
    // switchNotice defaults to OFF (no router_settings.json in the temp home),
    // so this note can only come from the forced Off-Model announcement: a
    // silently rerouted answer reads as "the disable didn't work".
    const r = await cloudPost('custom-openai-model-d', false, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/⇄ routed: model-d is Off Model → model-(a|b|c)/);
    expect(r.text).toMatch(/pong-model-(a|b|c)/);
    expect(upD.state.dials).toBe(0);
  }, 15_000);

  it('Auto router never routes to disabled models', async () => {
    const r = await cloudPost('custom-auto-router', false, chatBody);
    expect(r.status).toBe(200);
    expect(upD.state.dials).toBe(0);
    const totalDials = upstreams.reduce((n, u) => n + u.state.dials, 0);
    expect(totalDials).toBe(1);
  }, 15_000);

  // ── Unified Gateway (Anthropic-compatible API, Claude Code flow) ─────────

  it('gateway: /v1/messages without a key -> 401 anthropic error', async () => {
    const r = await post('/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(401);
    expect(r.text).toContain('"type":"error"');
    expect(r.text).toContain('authentication_error');
  });

  it('gateway: claude model name -> auto-routed Anthropic message (non-stream)', async () => {
    const r = await post(
      '/v1/messages',
      { model: 'claude-sonnet-4-5-20250929', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] },
      { 'x-api-key': gatewayKey() },
    );
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.text);
    expect(parsed.type).toBe('message');
    expect(parsed.role).toBe('assistant');
    expect(parsed.model).toBe('claude-sonnet-4-5-20250929');
    expect(parsed.stop_reason).toBe('end_turn');
    expect(JSON.stringify(parsed.content)).toContain('pong-model-');
  }, 15_000);

  it('gateway: streaming claude request -> valid Anthropic SSE frames', async () => {
    // whichever upstream Auto picks must answer as SSE (the request streams)
    upstreams.forEach((u) => (u.state.handler = sse(u.name)));
    const r = await post(
      '/v1/messages',
      { model: 'claude-3-5-haiku-latest', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] },
      { 'x-api-key': gatewayKey() },
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain('event: message_start');
    expect(r.text).toContain('event: content_block_delta');
    expect(r.text).toContain('event: message_stop');
    expect(r.text).toContain('pong-model-');
    expect(r.text.match(/event: message_start/g)?.length).toBe(1);
  }, 15_000);

  it('gateway: exact custom model name pins that model (with rotation)', async () => {
    upB.state.handler = status(429); // pinned pick fails -> rotation kicks in
    const r = await post(
      '/v1/messages',
      { model: 'model-b', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] },
      { 'x-api-key': gatewayKey() },
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain('pong-model-');
    expect(upB.state.dials).toBe(1); // the pinned model was dialed first
  }, 15_000);

  it('gateway: count_tokens and /v1/models', async () => {
    const key = { 'x-api-key': gatewayKey() };
    const ct = await post('/v1/messages/count_tokens', { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello world' }] }, key);
    expect(ct.status).toBe(200);
    expect(JSON.parse(ct.text).input_tokens).toBeGreaterThan(0);
    const models = await get('/v1/models', key);
    expect(models.status).toBe(200);
    expect(models.text).toContain('model-a');
    expect(models.text).not.toContain('"id":"model-d"'); // disabled models are not offered
  });
});

// ─── Off Model toggle must not reshuffle placeholder IDs ────────────────────
// The IDE caches placeholder IDs across toggles and proxy restarts. The
// assignment used to sort disabled models last, so disabling the base-slot
// owner of a colliding pair handed its ID to the other model - a stale pick of
// the disabled model then silently resolved to the WRONG model, which reads
// exactly as "the disable didn't work".

describe('placeholder ID stability across Off Model toggles', () => {
  const slotOf = (displayName: string): number => {
    const input = `openai:${displayName}:${displayName}`.toLowerCase();
    return 400 + (crypto.createHash('sha1').update(input).digest().readUInt32BE(0) % 200);
  };

  // Deterministic brute-force: two display names that share one legacy slot.
  const colliding: string[] = [];
  const buckets = new Map<number, string[]>();
  for (let i = 0; colliding.length < 2 && i < 50_000; i++) {
    const dn = `collider-${i}`;
    const slot = slotOf(dn);
    const bucket = buckets.get(slot) || [];
    bucket.push(dn);
    buckets.set(slot, bucket);
    if (bucket.length === 2) colliding.push(...bucket);
  }
  const [dnA, dnB] = colliding;

  const mk = (displayName: string) =>
    ({
      name: 'models/' + displayName,
      displayName,
      description: 'stability test model',
      provider: 'openai',
      apiKey: 'test-key',
      apiUrl: 'http://127.0.0.1:9/v1/chat/completions',
      externalModelName: displayName,
    }) as CustomModel;

  it('found a colliding pair to exercise the legacy-slot disambiguation', () => {
    expect(colliding.length).toBe(2);
    expect(slotOf(dnA)).toBe(slotOf(dnB));
  });

  it('disabling/re-enabling one of two colliding models keeps every ID stable', () => {
    const a = mk(dnA);
    const b = mk(dnB);
    const bothOn = [a, b];
    const aOff = [{ ...a, disabled: true }, b];

    const idA = generateModelPlaceholderId(a, bothOn);
    const idB = generateModelPlaceholderId(b, bothOn);
    expect(idA).not.toBe(idB); // still disambiguated despite the shared slot

    expect(generateModelPlaceholderId(a, aOff)).toBe(idA);
    expect(generateModelPlaceholderId(b, aOff)).toBe(idB);
    expect(generateModelPlaceholderId(a, bothOn)).toBe(idA); // re-enable: back to the same IDs
  });
});
