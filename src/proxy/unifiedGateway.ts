/**
 * Unified Gateway: an Anthropic-compatible API surface over the configured
 * custom models, so tools that ONLY speak Anthropic (Claude Code rejects any
 * model name that is not claude-sonnet-4-5 etc.) can use every model the
 * proxy routes.
 *
 *   POST /v1/messages            (stream + non-stream, text + tool_use)
 *   POST /v1/messages/count_tokens
 *   GET  /v1/models
 *
 * Auth: one unified local key (x-api-key or Authorization: Bearer), stored in
 * ~/.gemini/antigravity/unified_key.json and shown in the dashboard.
 * ANY model name is accepted: an exact match routes to that model, anything
 * else (claude-sonnet-4-5, ...) routes through the Auto Smart Router.
 *
 * Electron-free so it can be unit-tested directly.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Unified key store ────────────────────────────────────────────────────

/** Path is overridable so tests can isolate their key file. Resolved lazily:
 *  tests set the env var in beforeAll, after this module has been imported. */
function keyFile(): string {
  return process.env.JEV_UNIFIED_KEY_FILE || path.join(os.homedir(), '.gemini', 'antigravity', 'unified_key.json');
}

/** Reads the unified key, generating and persisting one on first use. */
export function getUnifiedKey(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(keyFile(), 'utf-8')) as { key?: string };
    if (parsed.key && typeof parsed.key === 'string') return parsed.key;
  } catch {
    /* first use */
  }
  const key = 'sk-jev-' + crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), JSON.stringify({ key }, null, 2), 'utf-8');
  } catch {
    /* unwritable - key still works for this process lifetime */
  }
  return key;
}

/** Deletes the stored key and returns a freshly generated one. */
export function resetUnifiedKey(): string {
  try {
    fs.unlinkSync(keyFile());
  } catch {
    /* nothing stored */
  }
  return getUnifiedKey();
}

/** True when the request carries the unified key (x-api-key or Bearer). */
export function hasUnifiedKey(headers: Record<string, string | string[] | undefined>): boolean {
  const expected = getUnifiedKey();
  const apiKey = headers['x-api-key'];
  const auth = headers['authorization'];
  const provided = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (provided && provided.trim() === expected) return true;
  const bearer = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '').trim() : '';
  return bearer === expected;
}

// ─── Anthropic request -> Gemini body ─────────────────────────────────────

export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | unknown[];
  source?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

export interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  temperature?: number;
  [key: string]: unknown;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  [key: string]: unknown;
}

/** Maps an Anthropic /v1/messages body to the proxy's internal Gemini shape. */
export function anthropicToGemini(body: AnthropicMessagesRequest): {
  contents: { role?: string; parts: GeminiPart[] }[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: { maxOutputTokens?: number; temperature?: number };
  tools?: { functionDeclarations: unknown[] }[];
} {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // tool_use ids appear in assistant turns; tool_results reference them.
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.id) toolNames.set(b.id, b.name || b.id);
    }
  }

  const contents: { role?: string; parts: GeminiPart[] }[] = [];
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'text') {
          if (b.text) parts.push({ text: b.text });
        } else if (b.type === 'tool_use') {
          parts.push({ functionCall: { name: b.name, args: (b.input as unknown) ?? {} } });
        } else if (b.type === 'tool_result') {
          const name = (b.tool_use_id && toolNames.get(b.tool_use_id)) || b.tool_use_id || 'tool';
          const value = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          parts.push({ functionResponse: { name, response: { result: value } } });
        } else if (b.type === 'image') {
          parts.push({ text: '[image attached]' });
        }
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }

  const out: ReturnType<typeof anthropicToGemini> = { contents };
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system : body.system.map((b) => b.text || '').join('\n');
    if (text) out.systemInstruction = { parts: [{ text }] };
  }
  out.generationConfig = {
    maxOutputTokens: typeof body.max_tokens === 'number' ? body.max_tokens : 8192,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = [
      {
        functionDeclarations: body.tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        })),
      },
    ];
  }
  return out;
}

// ─── Gemini response -> Anthropic response ────────────────────────────────

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

function stopReasonOf(finishReason: string | undefined): string {
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  if (finishReason === 'TOOL_CALL' || finishReason === 'OTHER') return 'end_turn';
  return 'end_turn';
}

/** Maps one Gemini candidate's parts to Anthropic content blocks. */
export function geminiPartsToAnthropicContent(parts: GeminiPart[] | undefined): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const p of parts || []) {
    if (typeof p.text === 'string' && p.text) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'text') last.text += p.text;
      else blocks.push({ type: 'text', text: p.text });
    } else if (p.functionCall && p.functionCall.name) {
      blocks.push({
        type: 'tool_use',
        id: 'toolu_' + crypto.randomBytes(12).toString('hex'),
        name: p.functionCall.name,
        input: (p.functionCall.args as unknown) ?? {},
      });
    }
    // thought parts and non-content parts are gateway-invisible
  }
  return blocks;
}

/** Maps a translated Gemini response (candidates shape) to an Anthropic message. */
export function geminiToAnthropicResponse(
  geminiResponse: { candidates?: GeminiCandidate[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } } | null | undefined,
  model: string,
): Record<string, unknown> {
  const cand = geminiResponse?.candidates?.[0];
  const content = geminiPartsToAnthropicContent(cand?.content?.parts);
  const usage = geminiResponse?.usageMetadata || {};
  return {
    id: 'msg_' + crypto.randomBytes(12).toString('hex'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : stopReasonOf(cand?.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount ?? 0,
      output_tokens: usage.candidatesTokenCount ?? usage.totalTokenCount ?? 0,
    },
  };
}

// ─── Gemini stream chunks -> Anthropic SSE frames ─────────────────────────

/**
 * Stateful framer: feed it the same mapped Gemini candidate chunks the proxy
 * already produces, and it emits valid Anthropic SSE frames
 * (message_start -> content_block_start/delta/stop -> message_delta -> message_stop).
 */
export class AnthropicStreamFramer {
  private started = false;
  private openBlock = -1; // index of the currently open text block, -1 = none
  private blockCount = 0;
  private outputChars = 0;
  private stopReason = 'end_turn';
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  private frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private messageStart(): string {
    this.started = true;
    return this.frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_' + crypto.randomBytes(12).toString('hex'),
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        usage: { input_tokens: 0, output_tokens: 1 },
      },
    });
  }

  private closeOpenBlock(): string {
    if (this.openBlock < 0) return '';
    const out = this.frame('content_block_stop', { type: 'content_block_stop', index: this.openBlock });
    this.openBlock = -1;
    return out;
  }

  /** Feed one mapped Gemini candidate chunk. Returns the SSE text to write. */
  feed(chunk: { candidates?: GeminiCandidate[] }): string {
    let out = this.started ? '' : this.messageStart();
    const cand = chunk?.candidates?.[0];
    if (!cand) return out;
    if (cand.finishReason) this.stopReason = stopReasonOf(cand.finishReason);
    for (const p of cand.content?.parts || []) {
      if (typeof p.text === 'string' && p.text) {
        if (this.openBlock < 0) {
          this.openBlock = this.blockCount++;
          out += this.frame('content_block_start', {
            type: 'content_block_start',
            index: this.openBlock,
            content_block: { type: 'text', text: '' },
          });
        }
        this.outputChars += p.text.length;
        out += this.frame('content_block_delta', {
          type: 'content_block_delta',
          index: this.openBlock,
          delta: { type: 'text_delta', text: p.text },
        });
      } else if (p.functionCall && p.functionCall.name) {
        out += this.closeOpenBlock();
        const idx = this.blockCount++;
        const blockId = 'toolu_' + crypto.randomBytes(12).toString('hex');
        out += this.frame('content_block_start', {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: blockId, name: p.functionCall.name, input: {} },
        });
        this.outputChars += JSON.stringify(p.functionCall.args ?? {}).length;
        out += this.frame('content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.functionCall.args ?? {}) },
        });
        out += this.frame('content_block_stop', { type: 'content_block_stop', index: idx });
        this.stopReason = 'tool_use';
      }
      // thought parts are gateway-invisible
    }
    return out;
  }

  /** End of upstream stream: closes blocks and finishes the message. */
  finish(): string {
    let out = this.started ? '' : this.messageStart();
    out += this.closeOpenBlock();
    out += this.frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: Math.ceil(this.outputChars / 4) },
    });
    out += this.frame('message_stop', { type: 'message_stop' });
    return out;
  }
}

/** Rough token estimate for /v1/messages/count_tokens. */
export function estimateTokens(body: unknown): number {
  return Math.ceil(JSON.stringify(body ?? '').length / 4);
}
