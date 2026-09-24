/**
 * JEV Mode — model-judged context compaction for the Auto Router.
 *
 * Instead of the local lossy digest (compressContents), JEV asks a configured
 * model (the "judge") which old tool calls and results are no longer needed.
 * Nothing is rewritten: kept tool calls and results stay verbatim, and user /
 * assistant text is never touched. Adapted from
 * tamaratran/fast-jev-compaction (MIT) to this proxy's Gemini-format bodies.
 *
 * Every probe doubles as a live health test: an unresponsive or failing judge
 * is reported to the shared circuit breaker (smartHealth) and the next best
 * candidate takes over automatically. When every judge fails — or the judge
 * keeps everything — jevCompact returns null and the caller falls back to the
 * local compression, never to a broken request.
 *
 * Compaction only runs when a request outgrows the best model's window, and
 * only tool calls/results outside the pinned zone (first message + the most
 * recent turns) are candidates, so probes stay rare and cheap.
 *
 * This module is intentionally Electron-free so it can be unit-tested
 * directly. The CustomModel import is type-only (erased at compile), keeping
 * the runtime dependency graph one-way (proxy -> autoRouter -> jevMode).
 */

import type { CustomModel } from '../proxy';
import { healthKey } from './modelUtils';
import { smartHealth } from './smartHealth';
import * as registry from './registry';
import log from 'electron-log';

// ─── Constants ────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;
const IMAGE_FLAT_TOKENS = 1100; // safe overestimate per image part
const ANSWER_HEADROOM = 2048; // room for the model's reply

export const JEV_DEFAULTS = {
  /** Contents pinned from the end (never modified, never asked about). */
  preserveRecent: 6,
  /** Probe prompt budget: the serialized state is squeezed under this. */
  maxStateTokens: 25_000,
  /** Per-probe request budget: state + batched questions must fit under this. */
  maxRequestTokens: 30_000,
  /** AbortSignal timeout for one judge request. */
  probeTimeoutMs: 15_000,
  /** How many judge candidates to try before giving up (falls back to local). */
  maxJudgeAttempts: 2,
  /** Kept-call-only: result truncated to this many chars. */
  resultHeadChars: 300,
};

// ─── Types (structural mirrors of the proxy Gemini body) ──────────────────

export interface JevPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  [key: string]: unknown;
}

export interface JevBody {
  systemInstruction?: { parts?: JevPart[] };
  contents?: { role?: string; parts?: JevPart[] }[];
}

export type JevOptions = Partial<typeof JEV_DEFAULTS>;

export interface JevStats {
  tokensBefore: number;
  tokensAfter: number;
  callsKept: number;
  callsDropped: number;
  resultsTruncated: number;
  judge: string;
  batches: number;
  durationMs: number;
  fellBack: boolean;
}

export interface JevOutcome {
  body: JevBody;
  stats: JevStats;
}

/** One removable tool call + its paired result, in conversation order. */
export interface JevCandidate {
  callIndex: number;
  callPartIndex: number;
  responseIndex: number;
  responsePartIndex: number;
  name: string;
  argsNote: string;
  resultNote: string;
}

let lastStats: JevStats | null = null;

/** Last compaction outcome, for the dashboard status endpoint. */
export function lastJevStats(): JevStats | null {
  return lastStats;
}

// ─── Token estimation (same heuristics as autoRouter) ─────────────────────

function partTokens(p: JevPart): number {
  if (typeof p.text === 'string') return Math.ceil(p.text.length / CHARS_PER_TOKEN);
  if (p.inlineData) return IMAGE_FLAT_TOKENS;
  if (p.functionCall) {
    return Math.ceil(safeStringify((p.functionCall as { args?: unknown }).args).length / CHARS_PER_TOKEN);
  }
  if (p.functionResponse) {
    return Math.ceil(safeStringify((p.functionResponse as { response?: unknown }).response).length / CHARS_PER_TOKEN);
  }
  return 0;
}

export function estimateJevTokens(body: JevBody): number {
  let total = 0;
  if (body.systemInstruction?.parts) {
    for (const p of body.systemInstruction.parts) total += partTokens(p);
  }
  for (const c of body.contents || []) {
    for (const p of c.parts || []) total += partTokens(p);
  }
  return total + ANSWER_HEADROOM;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? '');
  } catch {
    return String(v ?? '');
  }
}

// ─── Candidate discovery (pairing + pinning) ──────────────────────────────

function abridge(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 20) return s;
  return s.slice(0, head) + `…[${s.length - head - tail} chars omitted]…` + s.slice(-tail);
}

/**
 * Pairs every non-pinned functionCall with its functionResponse by name and
 * order. The first content and the last `preserveRecent` contents are pinned:
 * a call whose response lands in the pinned zone is NOT a candidate (removing
 * one side of a pinned pair would corrupt the context).
 */
export function findCandidates(body: JevBody, preserveRecent = JEV_DEFAULTS.preserveRecent): JevCandidate[] {
  const contents = body.contents || [];
  if (contents.length <= preserveRecent + 1) return [];
  const lastEditable = contents.length - preserveRecent; // exclusive bound
  const candidates: JevCandidate[] = [];

  for (let i = 1; i < lastEditable; i++) {
    const parts = contents[i]?.parts || [];
    for (let j = 0; j < parts.length; j++) {
      const fc = parts[j]?.functionCall as { name?: string; args?: unknown } | undefined;
      if (!fc?.name) continue;
      const resp = findResponse(contents, i, lastEditable, String(fc.name));
      if (!resp) continue; // call without a (non-pinned) result: unsafe to touch
      const argsJson = safeStringify(fc.args);
      const respJson = safeStringify(
        (contents[resp.index].parts![resp.part].functionResponse as { response?: unknown }).response,
      );
      candidates.push({
        callIndex: i,
        callPartIndex: j,
        responseIndex: resp.index,
        responsePartIndex: resp.part,
        name: String(fc.name),
        argsNote: abridge(argsJson, 300, 0),
        resultNote: `${respJson.length} chars; starts: ${abridge(respJson, 160, 0)}`,
      });
    }
  }
  return candidates;
}

function findResponse(
  contents: { role?: string; parts?: JevPart[] }[],
  fromCall: number,
  lastEditable: number,
  name: string,
): { index: number; part: number } | null {
  for (let i = fromCall + 1; i < contents.length; i++) {
    const parts = contents[i]?.parts || [];
    const hasCall = parts.some((p) => p.functionCall);
    for (let j = 0; j < parts.length; j++) {
      const fr = parts[j]?.functionResponse as { name?: string } | undefined;
      if (fr && String(fr.name || '') === name) {
        // Responses in the pinned zone count as found-but-pinned: the caller
        // treats "response beyond the editable range" as non-removable.
        if (i >= lastEditable) return null;
        return { index: i, part: j };
      }
    }
    if (hasCall) break; // a new call round started; this result never arrived
  }
  return null;
}

// ─── State construction (staged truncation) ───────────────────────────────

function serializeContents(body: JevBody, textHead: number, argsHead: number): string[] {
  const lines: string[] = [];
  (body.contents || []).forEach((c, i) => {
    const rendered: string[] = [];
    for (const p of c.parts || []) {
      if (typeof p.text === 'string') {
        rendered.push(abridge(p.text, textHead, 200));
      } else if (p.functionCall) {
        const fc = p.functionCall as { name?: string; args?: unknown };
        rendered.push(`tool call ${fc.name ?? '?'}(${abridge(safeStringify(fc.args), argsHead, 0)})`);
      } else if (p.functionResponse) {
        const fr = p.functionResponse as { name?: string; response?: unknown };
        rendered.push(`[tool ${fr.name ?? '?'} result: ok, ${safeStringify(fr.response).length} chars (omitted)]`);
      } else if (p.inlineData) {
        rendered.push(`[image: ${(p.inlineData as { mimeType?: string }).mimeType || 'unknown'}]`);
      }
    }
    if (rendered.length > 0) lines.push(`#${i} ${c.role || 'user'}: ${rendered.join(' | ')}`);
  });
  return lines;
}

function linesTokens(lines: string[]): number {
  return Math.ceil(lines.join('\n').length / CHARS_PER_TOKEN);
}

/**
 * Serializes the whole conversation with tool results replaced by short
 * notes, squeezing it under maxStateTokens through staged truncation:
 * abridge long texts, then shrink harder, then collapse the oldest lines.
 */
export function buildState(body: JevBody, maxStateTokens = JEV_DEFAULTS.maxStateTokens): { state: string; stateTokens: number } {
  const stages: [number, number][] = [
    [1200, 600],
    [400, 200],
    [160, 80],
  ];
  let lines: string[] = [];
  for (const [t, a] of stages) {
    lines = serializeContents(body, t, a);
    if (linesTokens(lines) <= maxStateTokens) return { state: lines.join('\n'), stateTokens: linesTokens(lines) };
  }
  // Last resort: collapse the oldest lines head-first until it fits.
  while (lines.length > 4 && linesTokens(['[earlier messages collapsed]', ...lines.slice(1)]) > maxStateTokens) {
    lines = lines.slice(1);
  }
  const collapsed = ['[earlier messages collapsed]', ...lines.slice(1)];
  return { state: collapsed.join('\n'), stateTokens: linesTokens(collapsed) };
}

// ─── Probe batching ───────────────────────────────────────────────────────

export function itemLines(cands: JevCandidate[]): string[] {
  return cands.map((c, i) => `#${i + 1} ${c.name} — args: ${c.argsNote} | result: ${c.resultNote}`);
}

/**
 * Packs candidate numbers into batches so state + questions stay under
 * maxRequestTokens. The state is resent with every batch (known trade-off
 * from fast-jev-compaction).
 */
export function batchItems(cands: JevCandidate[], stateTokens: number, maxRequestTokens = JEV_DEFAULTS.maxRequestTokens): number[][] {
  const budget = Math.max(200, maxRequestTokens - stateTokens - 400);
  const costs = itemLines(cands).map((l) => Math.ceil(l.length / CHARS_PER_TOKEN) + 20);
  const batches: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (let i = 0; i < cands.length; i++) {
    if (current.length > 0 && used + costs[i] > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(i + 1);
    used += costs[i];
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function renderProbePrompt(state: string, items: string[]): string {
  return (
    'You are curating an agent conversation that has grown too large.\n' +
    'Older tool calls and their results are candidates for removal.\n' +
    'The first message and the most recent messages are pinned and will be kept no matter what.\n\n' +
    'For each numbered tool call below answer two yes/no questions:\n' +
    '- keep: does the agent still need to know this tool RAN at all?\n' +
    '- verbatim: is the full RESULT still needed for later steps?\n' +
    'When in doubt answer no - the agent can re-run a tool if truly needed.\n\n' +
    'Reply with EXACTLY one line per number in this format and nothing else:\n' +
    '1: keep=yes verbatim=no\n\n' +
    '[CONVERSATION STATE]\n' +
    state +
    '\n\n[TOOL CALLS]\n' +
    items.join('\n')
  );
}

// ─── Verdict parsing ──────────────────────────────────────────────────────

function isYes(s: string): boolean {
  return /^(yes|true|1|keep|y)$/i.test(s.trim());
}

/**
 * Tolerant parser for judge replies. Accepts "12: keep=yes verbatim=no" and
 * the positional "12: yes no". Unparseable lines are ignored; the caller
 * treats missing numbers conservatively (keep everything - never silently
 * drop context because the judge was sloppy).
 */
export function parseVerdicts(reply: string): Map<number, [boolean, boolean]> {
  const out = new Map<number, [boolean, boolean]>();
  for (const raw of String(reply || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^#?(\d+)\s*:\s*keep\s*=\s*(\S+)\s*[,;\s]+verbatim\s*=\s*(\S+)/i);
    if (!m) m = line.match(/^#?(\d+)\s*:\s*(\S+)\s*[,;\s]+(\S+)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n <= 0) continue;
    out.set(n, [isYes(m[2]), isYes(m[3])]);
  }
  return out;
}

// ─── Judge selection: auto-test, skip the sick ────────────────────────────

function latencyOf(key: string): number {
  return smartHealth.latency(key);
}

/**
 * Judge candidates ranked by live health: breaker penalty first (failure /
 * rate-limit history), then latency EWMA (fast responders win), then name.
 * Reports nothing here - the probe itself is the test.
 */
export function judgeOrder(models: CustomModel[]): CustomModel[] {
  return models
    .filter((m) => m && m.apiUrl && (m.externalModelName || '') !== 'auto-router')
    .sort(
      (a, b) =>
        smartHealth.penalty(healthKey(a)) - smartHealth.penalty(healthKey(b)) ||
        latencyOf(healthKey(a)) - latencyOf(healthKey(b)) ||
        a.displayName.localeCompare(b.displayName),
    );
}

// ─── Judge I/O ────────────────────────────────────────────────────────────

function providerOf(m: CustomModel): string {
  return m.provider === 'custom' || m.provider === 'openrouter' || m.provider === 'free-router' ? 'openai' : m.provider;
}

function resolveJudgeUrl(m: CustomModel): string {
  const provider = providerOf(m);
  if (provider === 'google' || provider === 'ollama') {
    return registry.getProviderUrl(m.apiUrl, m.externalModelName, false, provider);
  }
  return registry.withChatCompletions(m.apiUrl);
}

function extractReplyText(provider: string, parsed: Record<string, unknown>): string {
  if (provider === 'anthropic') {
    const content = parsed.content as { type?: string; text?: string }[] | undefined;
    return (content || [])
      .map((c) => c.text || '')
      .join('\n')
      .trim();
  }
  const choices = parsed.choices as { message?: { content?: string } }[] | undefined;
  if (choices && choices[0]?.message?.content) return String(choices[0].message.content).trim();
  const candidates = parsed.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
  if (candidates && candidates[0]?.content?.parts) {
    return candidates[0].content.parts
      .map((p) => p.text || '')
      .join('')
      .trim();
  }
  return '';
}

/** Sends one batched probe to a judge. Throws on HTTP/network/empty errors. */
async function askJudge(judge: CustomModel, promptText: string, probeTimeoutMs: number): Promise<string> {
  const provider = providerOf(judge);
  const probeBody = {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { maxOutputTokens: 2048 },
  };
  const payload = registry.translateRequest(provider, probeBody, judge.externalModelName);
  const headers = registry.getProviderHeaders(provider, judge.apiKey || 'none') as Record<string, string>;
  const res = await fetch(resolveJudgeUrl(judge), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(probeTimeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
  }
  const parsed = JSON.parse(await res.text()) as Record<string, unknown>;
  const text = extractReplyText(provider, parsed);
  if (!text) throw new Error('empty judge reply');
  return text;
}

/**
 * Runs all batches against one judge concurrently. Any batch failure throws
 * (the caller moves to the next judge); per-number answers the judge skipped
 * default to keep-verbatim so a sloppy reply never drops context.
 */
async function probeJudge(
  judge: CustomModel,
  state: string,
  batches: number[][],
  cands: JevCandidate[],
  opts: typeof JEV_DEFAULTS,
): Promise<Map<number, [boolean, boolean]>> {
  const lines = itemLines(cands);
  const settled = await Promise.allSettled(
    batches.map((b) => askJudge(judge, renderProbePrompt(state, b.map((n) => lines[n - 1])), opts.probeTimeoutMs)),
  );
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  const merged = new Map<number, [boolean, boolean]>();
  for (const s of settled) {
    for (const [k, v] of parseVerdicts((s as PromiseFulfilledResult<string>).value)) merged.set(k, v);
  }
  return merged;
}

// ─── Decision application ─────────────────────────────────────────────────

export interface AppliedDecisions {
  body: JevBody;
  kept: number;
  dropped: number;
  truncated: number;
}

/**
 * Applies keep/drop verdicts to a deep clone of the body:
 *   result kept verbatim -> call + result untouched
 *   call kept only       -> result truncated to resultHeadChars
 *   neither kept         -> call part and result part removed
 * Pinned contents are never touched (candidates are pre-filtered).
 */
export function applyDecisions(
  body: JevBody,
  cands: JevCandidate[],
  verdicts: Map<number, [boolean, boolean]>,
  resultHeadChars = JEV_DEFAULTS.resultHeadChars,
): AppliedDecisions {
  const clone = JSON.parse(JSON.stringify(body)) as JevBody;
  const contents = clone.contents || [];
  const removeCall = new Set<string>();
  const removeResp = new Set<string>();
  const truncateResp = new Map<string, string>(); // key -> tool name
  let kept = 0;
  let dropped = 0;
  let truncated = 0;

  cands.forEach((c, i) => {
    const [keep, verbatim] = verdicts.get(i + 1) ?? [true, true];
    if (verbatim) {
      kept++;
      return;
    }
    if (keep) {
      truncated++;
      truncateResp.set(`${c.responseIndex}:${c.responsePartIndex}`, c.name);
      return;
    }
    dropped++;
    removeCall.add(`${c.callIndex}:${c.callPartIndex}`);
    removeResp.add(`${c.responseIndex}:${c.responsePartIndex}`);
  });

  const filterParts = (parts: JevPart[] | undefined, drop: Set<string>, trunc: Map<string, string>, idx: number): JevPart[] => {
    const out: JevPart[] = [];
    (parts || []).forEach((p, j) => {
      const key = `${idx}:${j}`;
      if (drop.has(key)) return;
      if (trunc.has(key) && p.functionResponse) {
        const fr = p.functionResponse as { name?: string; response?: unknown };
        const head = safeStringify(fr.response).slice(0, resultHeadChars);
        out.push({ functionResponse: { name: fr.name, response: { note: `[truncated] ${head}` } } });
        return;
      }
      out.push(p);
    });
    return out;
  };

  const drop = new Set<string>([...removeCall, ...removeResp]);
  const keptContents: { role?: string; parts?: JevPart[] }[] = [];
  contents.forEach((c, i) => {
    const parts = filterParts(c.parts, drop, truncateResp, i);
    if (parts.length > 0) keptContents.push({ role: c.role, parts });
  });

  return { body: { ...clone, contents: keptContents }, kept, dropped, truncated };
}

// ─── Main entry ───────────────────────────────────────────────────────────

/**
 * Compacts `body` so it fits `targetTokens`, using the healthiest configured
 * model as judge. Returns null (caller keeps its current plan) when:
 *   - there is nothing compactable (no old tool call pairs, small conversation)
 *   - the request already fits
 *   - every judge failed (auto-tested and reported to the circuit breaker)
 *   - the judge kept everything (insufficient reduction)
 */
export async function jevCompact(
  models: CustomModel[],
  body: JevBody,
  targetTokens: number,
  opts?: JevOptions,
): Promise<JevOutcome | null> {
  const o = { ...JEV_DEFAULTS, ...opts };
  const started = Date.now();
  const contents = body?.contents || [];
  if (contents.length <= o.preserveRecent + 1) return null;

  const cands = findCandidates(body, o.preserveRecent);
  if (cands.length === 0) return null;

  const tokensBefore = estimateJevTokens(body);
  if (tokensBefore <= targetTokens) return null; // fits already - never waste a probe

  const judges = judgeOrder(models).slice(0, o.maxJudgeAttempts);
  if (judges.length === 0) return null;

  for (const judge of judges) {
    const t0 = Date.now();
    try {
      const { state, stateTokens } = buildState(body, o.maxStateTokens);
      const batches = batchItems(cands, stateTokens, o.maxRequestTokens);
      const verdicts = await probeJudge(judge, state, batches, cands, o);
      const applied = applyDecisions(body, cands, verdicts, o.resultHeadChars);
      const tokensAfter = estimateJevTokens(applied.body);
      smartHealth.reportSuccess(healthKey(judge), Date.now() - t0);

      if (applied.dropped === 0 && applied.truncated === 0) {
        log.info(`[JEV] judge "${judge.displayName}" kept everything - insufficient reduction, falling back`);
        lastStats = {
          tokensBefore,
          tokensAfter,
          callsKept: applied.kept,
          callsDropped: 0,
          resultsTruncated: 0,
          judge: judge.displayName,
          batches: batches.length,
          durationMs: Date.now() - started,
          fellBack: true,
        };
        return null;
      }

      const stats: JevStats = {
        tokensBefore,
        tokensAfter,
        callsKept: applied.kept,
        callsDropped: applied.dropped,
        resultsTruncated: applied.truncated,
        judge: judge.displayName,
        batches: batches.length,
        durationMs: Date.now() - started,
        fellBack: false,
      };
      lastStats = stats;
      log.info(
        `[JEV] compacted by "${judge.displayName}": ~${tokensBefore} -> ~${tokensAfter} tokens ` +
          `(${applied.dropped} calls dropped, ${applied.truncated} results truncated, ${batches.length} probe batch(es))`,
      );
      return { body: applied.body, stats };
    } catch (err) {
      // The probe IS the health test: report the failure so routing avoids
      // this model, and let the next candidate take over.
      smartHealth.reportFailure(healthKey(judge));
      log.warn(`[JEV] judge "${judge.displayName}" failed: ${(err as Error).message} - trying next candidate`);
    }
  }

  lastStats = {
    tokensBefore,
    tokensAfter: tokensBefore,
    callsKept: 0,
    callsDropped: 0,
    resultsTruncated: 0,
    judge: '(all judges failed)',
    batches: 0,
    durationMs: Date.now() - started,
    fellBack: true,
  };
  return null;
}
