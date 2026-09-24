/**
 * Google AI Studio Translator.
 *
 * Google AI Studio speaks Gemini format natively, so request/response
 * translation is a passthrough. The main addition is SSE streaming chunk
 * parsing and proper endpoint URL handling.
 */

import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

interface GeminiContent {
  parts?: GeminiPart[];
  role?: string;
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
  safetyRatings?: unknown[];
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: unknown;
  modelVersion?: string;
}

// ─── Request/Response Translation (Passthrough: Google speaks Gemini natively;
// see registry.translateRequest/translateResponse, which return the body as-is) ─

// ─── Streaming Chunk Translation ──────────────────────────────────────────

/**
 * Parse a Google AI Studio SSE streaming chunk into a Gemini candidate.
 *
 * Google AI Studio streams JSON chunks like:
 *   {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},...}]}
 *
 * Each chunk contains complete candidate objects (not deltas).
 */
export function mapGoogleChunkToGemini(chunk: unknown, _modelName: string): GeminiCandidate | null {
  if (!chunk || typeof chunk !== 'object') return null;

  const data = chunk as GeminiStreamChunk;

  // Extract first candidate
  if (!data.candidates || data.candidates.length === 0) return null;

  const candidate = data.candidates[0];

  // Check if there's actual content to emit
  const parts = candidate.content?.parts;
  if (!parts || parts.length === 0) {
    // Might be a final chunk with just finishReason
    if (candidate.finishReason) {
      return {
        content: { parts: [], role: 'model' },
        finishReason: candidate.finishReason,
        index: candidate.index ?? 0,
      };
    }
    return null;
  }

  return {
    content: candidate.content,
    finishReason: candidate.finishReason || 'OTHER',
    index: candidate.index ?? 0,
    safetyRatings: candidate.safetyRatings,
  };
}

// ─── URL Helpers ──────────────────────────────────────────────────────────

/**
 * Constructs the correct Google AI Studio endpoint URL based on streaming mode.
 *
 * Google AI Studio uses different endpoints:
 *   - Non-streaming: :generateContent
 *   - Streaming:     :streamGenerateContent
 *
 * If the user's URL already contains one of these endpoints, it's kept as-is.
 */
export function getGoogleApiUrl(baseUrl: string, modelName: string, isStream: boolean): string {
  let url = baseUrl;

  // If the URL doesn't already specify a method, append one
  if (!url.includes(':generateContent') && !url.includes(':streamGenerateContent')) {
    // Strip trailing slash if present
    url = url.replace(/\/$/, '');

    // Check if the URL ends with the model path (e.g. /models/gemini-1.5-pro)
    const modelPathPattern = /\/models\/([^\/]+)$/;
    const modelMatch = modelPathPattern.exec(url);

    if (modelMatch) {
      // URL like .../v1beta/models/gemini-1.5-pro → append :method
      const method = isStream ? ':streamGenerateContent' : ':generateContent';
      url += method;
    } else if (modelName) {
      // Append full path with model name
      const method = isStream ? ':streamGenerateContent' : ':generateContent';
      url += `models/${modelName}${method}`;
    } else {
      // Fallback: assume the URL is already complete
      log.warn('[GoogleTranslator] Could not determine model name for URL construction');
    }
  }

  return url;
}
