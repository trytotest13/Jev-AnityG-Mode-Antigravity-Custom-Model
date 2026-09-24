/**
 * Unified Gateway unit tests: Anthropic->Gemini request mapping, Gemini->
 * Anthropic response mapping, the SSE framer state machine, and key checks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  anthropicToGemini,
  geminiToAnthropicResponse,
  AnthropicStreamFramer,
  hasUnifiedKey,
  getUnifiedKey,
  estimateTokens,
} from '../proxy/unifiedGateway';

const keyFile = path.join(os.tmpdir(), 'jev-gw-key-' + Date.now() + '.json');

beforeAll(() => {
  process.env.JEV_UNIFIED_KEY_FILE = keyFile;
});
afterAll(() => {
  fs.rmSync(keyFile, { force: true });
  delete process.env.JEV_UNIFIED_KEY_FILE;
});

// ─── Request mapping ──────────────────────────────────────────────────────

describe('anthropicToGemini', () => {
  it('maps system, string contents, roles and max_tokens', () => {
    const out = anthropicToGemini({
      system: 'you are helpful',
      max_tokens: 1234,
      temperature: 0.5,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'continue' },
      ],
    });
    expect(out.systemInstruction?.parts[0].text).toBe('you are helpful');
    expect(out.contents).toHaveLength(3);
    expect(out.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
    expect(out.contents[1].role).toBe('model');
    expect(out.generationConfig?.maxOutputTokens).toBe(1234);
    expect(out.generationConfig?.temperature).toBe(0.5);
  });

  it('maps tool_use / tool_result blocks with id->name pairing', () => {
    const out = anthropicToGemini({
      messages: [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'read_file', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'file body' }] },
      ],
    });
    const assistant = out.contents[1];
    expect(assistant.role).toBe('model');
    expect(assistant.parts[0].functionCall).toEqual({ name: 'read_file', args: { path: 'a.ts' } });
    const result = out.contents[2].parts[0].functionResponse;
    expect(result?.name).toBe('read_file');
    expect(result?.response).toEqual({ result: 'file body' });
  });

  it('maps tools to functionDeclarations', () => {
    const out = anthropicToGemini({
      tools: [{ name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'go' }],
    });
    const decl = (out.tools?.[0].functionDeclarations as { name: string }[])[0];
    expect(decl.name).toBe('Bash');
  });
});

// ─── Response mapping ─────────────────────────────────────────────────────

describe('geminiToAnthropicResponse', () => {
  it('maps text parts and usage', () => {
    const out = geminiToAnthropicResponse(
      {
        candidates: [{ content: { parts: [{ text: 'Hello' }, { text: ' world' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
      },
      'claude-sonnet-4-5',
    );
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.model).toBe('claude-sonnet-4-5');
    expect(out.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect((out.usage as { input_tokens: number }).input_tokens).toBe(12);
  });

  it('maps functionCall to a tool_use block with stop_reason tool_use', () => {
    const out = geminiToAnthropicResponse(
      { candidates: [{ content: { parts: [{ functionCall: { name: 'Bash', args: { cmd: 'ls' } } }], role: 'model' }, finishReason: 'TOOL_CALL' }] },
      'claude-sonnet-4-5',
    );
    const block = (out.content as { type: string; name?: string; input?: unknown }[])[0];
    expect(block.type).toBe('tool_use');
    expect(block.name).toBe('Bash');
    expect(block.input).toEqual({ cmd: 'ls' });
    expect(out.stop_reason).toBe('tool_use');
    expect((out.id as string).startsWith('msg_')).toBe(true);
  });

  it('maps MAX_TOKENS finish reason', () => {
    const out = geminiToAnthropicResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }, 'm');
    expect(out.stop_reason).toBe('max_tokens');
  });
});

// ─── SSE framer ───────────────────────────────────────────────────────────

describe('AnthropicStreamFramer', () => {
  it('emits message_start once, block start, deltas, and a proper finish', () => {
    const f = new AnthropicStreamFramer('claude-sonnet-4-5');
    const first = f.feed({ candidates: [{ content: { parts: [{ text: 'He' }] } }] });
    expect(first).toContain('event: message_start');
    expect(first).toContain('"type":"content_block_start"');
    expect(first).toContain('"text_delta"');
    const second = f.feed({ candidates: [{ content: { parts: [{ text: 'y' }] } }] });
    expect(second).not.toContain('message_start'); // no second message_start
    expect(second).toContain('"text":"y"');
    expect(second).not.toContain('content_block_start'); // same open text block
    const end = f.finish();
    expect(end).toContain('event: content_block_stop');
    expect(end).toContain('"stop_reason":"end_turn"');
    expect(end).toContain('event: message_stop');
    // message_start appears exactly once across everything
    const all = first + second + end;
    expect(all.match(/event: message_start/g)?.length).toBe(1);
  });

  it('emits a complete tool_use block and sets stop_reason tool_use', () => {
    const f = new AnthropicStreamFramer('m');
    const out = f.feed({ candidates: [{ content: { parts: [{ functionCall: { name: 'Bash', args: { cmd: 'ls' } } }] }, finishReason: 'TOOL_CALL' }] });
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"Bash"');
    expect(out).toContain('"input_json_delta"');
    const end = f.finish();
    expect(end).toContain('"stop_reason":"tool_use"');
  });

  it('finish() on an empty stream still emits a valid message', () => {
    const f = new AnthropicStreamFramer('m');
    const out = f.finish();
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: message_stop');
  });
});

// ─── Key checks ───────────────────────────────────────────────────────────

describe('unified key', () => {
  it('generates, persists, and validates the key via x-api-key or Bearer', () => {
    const key = getUnifiedKey();
    expect(key.startsWith('sk-jev-')).toBe(true);
    expect(getUnifiedKey()).toBe(key); // stable across calls
    expect(hasUnifiedKey({ 'x-api-key': key })).toBe(true);
    expect(hasUnifiedKey({ authorization: 'Bearer ' + key })).toBe(true);
    expect(hasUnifiedKey({ 'x-api-key': 'wrong' })).toBe(false);
    expect(hasUnifiedKey({})).toBe(false);
  });

  it('estimateTokens gives a positive estimate', () => {
    expect(estimateTokens({ messages: [{ role: 'user', content: 'hello world' }] })).toBeGreaterThan(0);
  });
});
