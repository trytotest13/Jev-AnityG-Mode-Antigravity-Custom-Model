/**
 * Rotation regression tests (Parts 16-19, 25).
 * Drives the real handleCustomModelRequest with a mocked http module and a
 * fake ServerResponse, asserting retry-vs-switch behavior end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// Throwaway home: the context-overflow recovery path reads router settings
// and custom_models.json, and must never touch the real user config.
const h = vi.hoisted(() => ({ home: '' }));
vi.mock('electron', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  h.home = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'jev-rot-'));
  return { app: { getPath: (name: string) => (name === 'home' ? h.home : pathMod.join(h.home, name)) } };
});
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../cryptoStore', () => ({
  encryptModels: (m: unknown[]) => m,
  decryptModels: (m: unknown[]) => m,
}));

type Responder = () => {
  status: number;
  body: string;
  headers?: Record<string, string>;
  destroy?: boolean;
};

let responder: Responder = () => ({ status: 200, body: '{}' });
const dials: { url: string; body: string }[] = [];

vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  return {
    ...actual,
    default: actual,
    request: (url: URL, _opts: unknown, cb: (res: unknown) => void) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      const req = {
        wrote: '' as string,
        write(b: string) { this.wrote += b; return this; },
        end(b?: string) {
          if (b) this.wrote += b;
          dials.push({ url: String(url), body: this.wrote });
          const r = responder();
          // Network failure: no response ever arrives, only the request error.
          if (r.destroy) {
            setImmediate(() => (listeners['error'] || []).forEach((f) => f(new Error('ECONNREFUSED'))));
            return;
          }
          const res = {
            statusCode: r.status,
            headers: r.headers ?? {},
            on(ev: string, fn: (c?: Buffer) => void) {
              if (ev === 'data') fn(Buffer.from(r.body));
              if (ev === 'end') fn();
              return this;
            },
          };
          cb(res);
        },
        setTimeout(_ms: number, _fn: () => void) { return this; },
        destroy() { return this; },
        on(ev: string, fn: (e?: Error) => void) { (listeners[ev] ||= []).push(fn as never); return this; },
      };
      return req;
    },
  };
});

vi.mock('https', async () => {
  const actual = await vi.importActual<typeof import('https')>('https');
  const httpMod = await import('http');
  return { ...actual, default: actual, request: (httpMod as unknown as { request: unknown }).request };
});

import { handleCustomModelRequest, stripRouteNotes } from '../proxy';
import { smartHealth } from '../proxy/smartHealth';
import { healthKey } from '../proxy/modelUtils';
import { clearRouting, recentRouting } from '../proxy/routingLog';

const OK = JSON.stringify({ choices: [{ message: { content: 'pong' } }] });

// Anthropic models: 200k detected window, so a ~226k-token body overflows.
function mk(name: string, provider = 'openai'): import('../proxy').CustomModel {
  return {
    name: 'models/' + name,
    displayName: name,
    description: '',
    provider,
    apiKey: 'none',
    apiUrl: 'http://127.0.0.1:1/v1/chat/completions',
    externalModelName: name,
    maxRetries: 0,
    timeout: 5000,
  };
}

function fakeRes(): http.ServerResponse {
  const out = {
    headersSent: false,
    statusCode: 200,
    chunks: [] as string[],
    ended: false,
    writeHead(code: number) { this.headersSent = true; this.statusCode = code; return this; },
    write(c: string) { this.chunks.push(String(c)); return true; },
    end(c?: string) { if (c) this.chunks.push(String(c)); this.ended = true; },
    on(_ev: string, _fn: () => void) { return this; },
    once(_ev: string, _fn: () => void) { return this; },
    emit(_ev: string) { return true; },
  };
  return out as unknown as http.ServerResponse;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(() => r())));
}

beforeEach(() => {
  dials.length = 0;
  responder = () => ({ status: 200, body: OK });
  smartHealth.clear();
  clearRouting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeAll(() => {
  const dir = path.join(h.home, '.gemini', 'antigravity');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'custom_models.json'),
    JSON.stringify({ models: [mk('model-a', 'anthropic'), mk('model-b', 'anthropic')] }),
    'utf-8',
  );
});

afterAll(() => {
  fs.rmSync(h.home, { recursive: true, force: true });
});

describe('rotation (Part 16-18)', () => {
  it('429 on A -> B receives the SAME original body and its response reaches the client', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: OK };
    };
    const body = { contents: [{ role: 'user', parts: [{ text: 'original request' }] }] };
    const res = fakeRes();
    handleCustomModelRequest(res, A, body as never, false, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(dials[1].body).toContain('original request');
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('pong');
  });

  it.each([401, 403, 404])('%s on A -> A dialed exactly once, B attempted', async (status) => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(dials[0].body).toContain('model-a');
    expect(dials[1].body).toContain('model-b');
  });

  it('503 with maxRetries>0 -> retries A, then falls back to B', async () => {
    const A = { ...mk('model-a'), maxRetries: 1 };
    const B = mk('model-b');
    responder = () => ({ status: 503, body: '{"error":{}}' });
    const res = fakeRes();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
      // Advance past the exponential backoff delay so the scheduled retry runs.
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(dials.filter((d) => d.body.includes('model-a')).length).toBe(2);
      expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hard-quota body on 500 -> skips retry budget, switches immediately', async () => {
    const A = { ...mk('model-a'), maxRetries: 3 };
    const B = mk('model-b');
    responder = () => ({ status: 500, body: '{"error":{"message":"quota exceeded for this project"}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.filter((d) => d.body.includes('model-a')).length).toBe(1);
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
  });

  it('ECONNREFUSED on A -> B receives the same request (Part 18)', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 200, body: OK, destroy: true });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [{ role: 'user', parts: [{ text: 'same body' }] }] } as never, false, 0, [B]);
    await flush();
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
    expect(dials.find((d) => d.body.includes('model-b'))!.body).toContain('same body');
  });

  it('plain 400 -> fails fast, does NOT burn the chain', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 400, body: '{"error":{"message":"bad request"}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.length).toBe(1);
    expect(res.statusCode).toBe(400);
  });

  it('all models fail -> final error lists every attempt (Part 25)', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 401, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    const out = res.chunks.join('');
    expect(out).toContain('All configured AI providers failed');
    expect(out).toContain('model-a');
    expect(out).toContain('model-b');
    expect(out).not.toContain('apiKey');
  });
});

describe('streaming rotation (Part 19)', () => {
  it('429 before headers -> B stream reaches the client', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n' };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('data:');
  });

  it('partial output then death -> no second dial, no concatenation', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 200, body: OK, destroy: true });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    // Simulate headers already sent (partial output streamed) before the error lands.
    (res as unknown as { headersSent: boolean }).headersSent = true;
    await flush();
    expect(dials.length).toBe(1); // B never dialed
  });
});

describe('Free Router (Part 20)', () => {
  it('online -> OpenAI-family translation and success', async () => {
    const FR = mk('free-best', 'free-router');
    responder = () => ({ status: 200, body: OK });
    const res = fakeRes();
    handleCustomModelRequest(res, FR, { contents: [] } as never, false, 0, []);
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('pong');
  });

  it('offline (ECONNREFUSED) -> no crash, error surfaces', async () => {
    const FR = mk('free-best', 'free-router');
    responder = () => ({ status: 200, body: OK, destroy: true });
    const res = fakeRes();
    handleCustomModelRequest(res, FR, { contents: [] } as never, false, 0, []);
    await flush();
    expect((res as unknown as { ended: boolean }).ended).toBe(true);
  });
});

describe('cooldown-aware switching (free-router rule 9)', () => {
  it('breaker-open fallback is skipped: A 401 -> B (open) skipped -> C dialed', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    const C = mk('model-c');
    for (let i = 0; i < 3; i++) smartHealth.reportFailure(healthKey(B));
    responder = () => ({ status: 401, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B, C]);
    await flush();
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(false);
    expect(dials.some((d) => d.body.includes('model-c'))).toBe(true);
  });

  it('ALL remaining fallbacks on cooldown -> dialed anyway instead of giving up', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    for (let i = 0; i < 3; i++) smartHealth.reportFailure(healthKey(B));
    responder = () => ({ status: 401, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
  });
});

describe('empty-stream rotation (free-router rule 11)', () => {
  const STREAM_OK = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

  it('200 stream that closes with NO content -> rotates to B instead of shipping an empty stream', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 200, body: '' };
      return { status: 200, body: STREAM_OK };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(dials[1].body).toContain('model-b');
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('data:');
  });

  it('200 stream with no fallback left -> valid empty SSE completion, not a broken stream', async () => {
    const A = mk('model-a');
    responder = () => ({ status: 200, body: '' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, []);
    await flush();
    expect(dials.length).toBe(1);
    expect(res.statusCode).toBe(200);
    expect((res as unknown as { ended: boolean }).ended).toBe(true);
    expect(res.chunks.join('')).toContain('finishReason');
  });

  it('stream 429 with Retry-After: 5 -> same-model retry waits 5s, not 1s', async () => {
    const A = { ...mk('model-a'), maxRetries: 2 };
    responder = () => {
      if (dials.length <= 1) {
        return { status: 429, body: '{"error":{"message":"rate limit"}}', headers: { 'retry-after': '5' } };
      }
      return { status: 200, body: STREAM_OK };
    };
    const res = fakeRes();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, []);
      await vi.advanceTimersByTimeAsync(1000);
      expect(dials.length).toBe(1); // 1s elapsed - Retry-After says wait 5s
      await vi.advanceTimersByTimeAsync(4500);
      expect(dials.length).toBe(2); // 5.5s total - retry fired
      await flush();
      expect(res.statusCode).toBe(200);
      expect(res.chunks.join('')).toContain('data:');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('empty-completion rotation (Part 26, non-stream side)', () => {
  const EMPTY = JSON.stringify({ choices: [{ message: { content: '' } }] });

  it('200 with no content -> rotates to B instead of shipping a dead completion', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => (dials.length <= 1 ? { status: 200, body: EMPTY } : { status: 200, body: OK });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(dials[1].body).toContain('model-b');
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('pong');
  });

  it('200 with no content and no fallback -> retries same model, then answers', async () => {
    const A = { ...mk('model-a'), maxRetries: 1 };
    responder = () => (dials.length <= 1 ? { status: 200, body: EMPTY } : { status: 200, body: OK });
    const res = fakeRes();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, []);
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(dials.length).toBe(2);
      expect(res.statusCode).toBe(200);
      expect(res.chunks.join('')).toContain('pong');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('in-IDE switch notice (first line of the answer text)', () => {
  const STREAM_OK2 = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const settingsPath = path.join(h.home, '.gemini', 'antigravity', 'router_settings.json');

  // The note is opt-in by default (the IDE status bar shows routing instead).
  beforeAll(() => {
    fs.mkdirSync(path.join(h.home, '.gemini', 'antigravity'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ autoRouter: true, jevMode: true, switchNotice: true }), 'utf-8');
  });
  afterAll(() => fs.rmSync(settingsPath, { force: true }));


  it('rotated stream: first chunk is a visible text note showing requested -> final', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: STREAM_OK2 };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    await flush();
    const out = res.chunks.join('');
    expect(out).toContain('routed: model-a');
    expect(out).toContain('1 switch');
    // the note leads, the real answer follows, and it is NOT a hidden thought part
    expect(out.indexOf('routed:')).toBeLessThan(out.indexOf('"text":"hi"'));
    expect(out).not.toContain('"thought":true');
  });

  it('rotated non-stream: notice text part prepended before the answer', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: OK };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    const parsed = JSON.parse(res.chunks.join(''));
    const parts = parsed.response.candidates[0].content.parts;
    expect(parts[0].thought).toBeUndefined();
    expect(parts[0].text).toContain('routed: model-a');
    expect(parts[0].text).toContain('model-b');
    expect(parts[1].text).toContain('pong');
  });

  it('direct hit, nothing switched -> no note', async () => {
    const A = mk('model-a');
    responder = () => ({ status: 200, body: OK });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, []);
    await flush();
    const parsed = JSON.parse(res.chunks.join(''));
    const parts = parsed.response.candidates[0].content.parts;
    expect(parts[0].text).toContain('pong');
    expect(JSON.stringify(parts)).not.toContain('routed:');
  });

  it('switchNotice OFF -> no note even after switching', async () => {
    const settingsPath = path.join(h.home, '.gemini', 'antigravity', 'router_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ autoRouter: true, jevMode: true, switchNotice: false }), 'utf-8');
    try {
      const A = mk('model-a');
      const B = mk('model-b');
      responder = () => {
        if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
        return { status: 200, body: OK };
      };
      const res = fakeRes();
      handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
      await flush();
      const parsed = JSON.parse(res.chunks.join(''));
      const parts = parsed.response.candidates[0].content.parts;
      expect(parts[0].text).toContain('pong');
      expect(JSON.stringify(parts)).not.toContain('routed:');
    } finally {
      fs.rmSync(settingsPath, { force: true });
    }
  });

  it('notes in HISTORY are stripped before dialing: the agent never sees them', async () => {
    // a sibling test may have removed/overwritten the settings file
    fs.writeFileSync(settingsPath, JSON.stringify({ autoRouter: true, jevMode: true, switchNotice: true }), 'utf-8');
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: OK };
    };
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'first question' }] },
        { role: 'model', parts: [{ text: '⇄ routed: model-x → model-y · 3 switches\n\n' }, { text: 'earlier answer' }] },
        { role: 'user', parts: [{ text: 'follow up please' }] },
      ],
    };
    stripRouteNotes(body as never);
    const res = fakeRes();
    handleCustomModelRequest(res, A, body as never, false, 0, [B]);
    await flush();
    // history dialed upstream is clean, everything else intact
    expect(dials[1].body).not.toContain('⇄ routed:');
    expect(dials[1].body).toContain('earlier answer');
    expect(dials[1].body).toContain('follow up please');
    // and a FRESH note is still written into this answer for the user
    expect(res.chunks.join('')).toContain('⇄ routed:');
  });

  it('stripRouteNotes keeps note-only turns and user text untouched', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: '⇄ routed: my own words start like that' }] },
        { role: 'model', parts: [{ text: '⇄ routed: a → b\n\n' }] },
      ],
    };
    stripRouteNotes(body as never);
    // user text is never touched (same prefix, but user turns are theirs)
    expect(body.contents![0].parts![0].text).toContain('my own words');
    // note-only model turn keeps its shape instead of becoming an empty turn
    expect(body.contents![1].parts!.length).toBe(1);
  });
});

describe('routing activity recording (dashboard shows who really answered)', () => {
  it('records requested -> final with every switch and reason', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: OK };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    const events = recentRouting();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      requested: 'model-a',
      final: 'model-b',
      ok: true,
      isStream: false,
    });
    expect(events[0].attempts).toEqual([{ model: 'model-a', reason: '429 rate limited' }]);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records the honest all-failed event listing every dead model', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 401, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    const events = recentRouting();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ requested: 'model-a', final: '(all failed)', ok: false });
    expect(events[0].attempts).toEqual([
      { model: 'model-a', reason: '401 auth failure' },
      { model: 'model-b', reason: 'HTTP 401' },
    ]);
  });

  it('records streaming successes with the answering model', async () => {
    const A = mk('model-a');
    responder = () => ({ status: 200, body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, []);
    await flush();
    const events = recentRouting();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ requested: 'model-a', final: 'model-a', ok: true, isStream: true });
  });

  it('chain exhausted via empty streams -> event lists EVERY dead model', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 200, body: '' }); // every upstream: 200 then closed, no content
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    await flush();
    const events = recentRouting();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ requested: 'model-a', final: '(all failed)', ok: false });
    expect(events[0].attempts).toEqual([
      { model: 'model-a', reason: 'upstream closed without content' },
      { model: 'model-b', reason: 'upstream closed without content' },
    ]);
  });

  it('rotated stream: records the fallback as the final answerer, primary as a switch', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 200, body: '' }; // empty stream
      return { status: 200, body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n' };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    await flush();
    const events = recentRouting();
    expect(events.length).toBe(1); // the fallback's event, not the dead primary's
    expect(events[0]).toMatchObject({ requested: 'model-a', final: 'model-b', ok: true, isStream: true });
    expect(events[0].attempts).toEqual([{ model: 'model-a', reason: 'upstream closed without content' }]);
  });
});

describe('context-overflow recovery (auto-switch instead of agent termination)', () => {
  // ~226k estimated tokens with an old removable tool pair; anthropic models
  // detect a 200k window, so this genuinely overflows.
  function overflowBody() {
    return {
      contents: [
        { role: 'user', parts: [{ text: 'audit this repo' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'big.log' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'x'.repeat(900_000) } } }] },
        { role: 'user', parts: [{ text: 'recent one' }] },
        { role: 'model', parts: [{ text: 'recent two' }] },
        { role: 'user', parts: [{ text: 'recent three' }] },
        { role: 'model', parts: [{ text: 'recent four' }] },
        { role: 'user', parts: [{ text: 'recent five' }] },
        { role: 'model', parts: [{ text: 'recent six' }] },
      ],
    };
  }
  const PROMPT_TOO_LONG = JSON.stringify({
    error: { message: 'prompt is too long: 226000 tokens > 200000 maximum' },
  });
  // Success body in Anthropic shape (the fixture models are anthropic).
  const OK_ANTH = JSON.stringify({ content: [{ type: 'text', text: 'pong' }] });
  const anthropicReply = (text: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ content: [{ type: 'text', text }] }),
  });

  it('400 prompt-too-long, judges unreachable -> rotates to B instead of failing (was: agent dies)', async () => {
    const A = mk('model-a', 'anthropic');
    const B = mk('model-b', 'anthropic');
    responder = () => {
      const d = dials[dials.length - 1];
      return d && d.body.includes('"model-a"') ? { status: 400, body: PROMPT_TOO_LONG } : { status: 200, body: OK_ANTH };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, overflowBody() as never, false, 0, [B]);
    await flush();
    await flush();
    expect(dials.some((d) => d.body.includes('"model-b"'))).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('pong');
  });

  it('400 prompt-too-long -> JEV compacts and re-dials A with the smaller body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicReply('1: keep=no verbatim=no'));
    vi.stubGlobal('fetch', fetchMock);
    const A = mk('model-a', 'anthropic');
    responder = () => {
      const d = dials[dials.length - 1];
      return d && d.body.includes('x'.repeat(1000))
        ? { status: 400, body: PROMPT_TOO_LONG }
        : { status: 200, body: OK_ANTH };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, overflowBody() as never, false, 0, []);
    await flush();
    await flush();
    const aDials = dials.filter((d) => d.body.includes('"model-a"'));
    expect(aDials.length).toBe(2); // original + compacted retry
    expect(aDials[1].body).not.toContain('x'.repeat(1000)); // huge result dropped
    expect(fetchMock).toHaveBeenCalled(); // the judge was probed
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('pong');
  });

  it('compaction still too long -> does not loop, rotates to B', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicReply('1: keep=no verbatim=no'));
    vi.stubGlobal('fetch', fetchMock);
    const A = mk('model-a', 'anthropic');
    const B = mk('model-b', 'anthropic');
    responder = () => {
      const d = dials[dials.length - 1];
      return d && d.body.includes('"model-a"') ? { status: 400, body: PROMPT_TOO_LONG } : { status: 200, body: OK_ANTH };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, overflowBody() as never, false, 0, [B]);
    await flush();
    await flush();
    expect(dials.filter((d) => d.body.includes('"model-a"')).length).toBe(2); // exactly one JEV retry
    expect(dials.some((d) => d.body.includes('"model-b"'))).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('JEV Mode OFF -> prompt-too-long rotates directly to B (no probe)', async () => {
    const settingsPath = path.join(h.home, '.gemini', 'antigravity', 'router_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ autoRouter: true, jevMode: false }), 'utf-8');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const A = mk('model-a', 'anthropic');
      const B = mk('model-b', 'anthropic');
      responder = () => {
        const d = dials[dials.length - 1];
        return d && d.body.includes('"model-a"') ? { status: 400, body: PROMPT_TOO_LONG } : { status: 200, body: OK_ANTH };
      };
      const res = fakeRes();
      handleCustomModelRequest(res, A, overflowBody() as never, false, 0, [B]);
      await flush();
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dials.filter((d) => d.body.includes('"model-a"')).length).toBe(1);
      expect(dials.some((d) => d.body.includes('"model-b"'))).toBe(true);
      expect(res.statusCode).toBe(200);
    } finally {
      fs.rmSync(settingsPath, { force: true });
    }
  });
});
