/**
 * Auto Smart Router.
 *
 * Provides the virtual "Auto (Smart Router)" model: when the IDE routes a
 * request to it, the proxy inspects the Gemini request (images, code, math,
 * length, tool calls) and picks the best user-configured custom model for the
 * job, with a fallback chain and local context compression when no window fits.
 *
 * Classification is a weighted multi-signal score, not a first-match regex:
 * strong signals (fenced code blocks, error traces, tool calls) dominate,
 * soft signals (code keywords, file paths, reasoning phrases) accumulate, and
 * the winner's score is explainable in the reason string the proxy logs.
 *
 * This module is intentionally Electron-free so it can be unit-tested
 * directly. Type-only import of CustomModel keeps the runtime dependency
 * graph one-way (proxy -> autoRouter).
 */

import type { CustomModel } from '../proxy';
import { detectModelCapabilities, healthKey } from './modelUtils';
import { smartHealth } from './smartHealth';
import { jevCompact, type JevOptions } from './jevMode';

// ─── Constants ────────────────────────────────────────────────────────────

export const AUTO_EXTERNAL_NAME = 'auto-router';
export const AUTO_DISPLAY_NAME = 'Auto (Smart Router)';

const IMAGE_FLAT_TOKENS = 1100; // safe overestimate per image part
const ANSWER_HEADROOM = 2048; // room for the model's reply
const CHARS_PER_TOKEN = 4; // rough average for code+prose
// 12 deep: with many configured models, most of them can be dead at once
// (dead keys, empty-stream endpoints) - the chain must be able to reach the
// one healthy model even on a cold start when the breaker has no history
// yet. Across requests the circuit breaker then skips the dead ones fast.
const MAX_CHAIN = 12;

// Task -> name hints, most-specific first. Matched against externalModelName +
// displayName (lowercased) of the configured models. Index i earns
// TASK_BASE - i * TASK_STEP points, so earlier (more specific) hints win.
const FAMILY_HINTS: Record<string, string[]> = {
  code: ['deepseek', 'coder', 'codestral', 'qwen3', 'claude', 'gpt-4o', 'llama-3.3', 'gemini'],
  reasoning: ['r1', 'reasoner', 'o1-', 'o3-', 'thinking', 'deepseek', 'claude', 'gemini', 'gpt-4o', 'qwen3'],
  vision: ['gemini', 'gpt-4o', 'claude', 'vision', 'llava', 'pixtral'],
  long: ['gemini', 'gpt-4o', 'claude', 'llama-3.3', 'deepseek'],
  quick: ['mini', 'flash', 'nano', 'haiku', '8b', '3b', 'small', 'lite'],
  // Balanced chat: no single family dominates; deepseek demoted from 1st so
  // generic chat rotates among claude/gpt/gemini instead of always DeepSeek.
  chat: ['claude', 'gpt-4o', 'gemini', 'deepseek', 'llama', 'qwen'],
};

const TASK_BASE = 60;
const TASK_STEP = 10;
const THINKING_BONUS = 8; // reward real reasoning models for brainy tasks
const HEALTH_WEIGHT = 12; // points lost per unit of breaker penalty
const WASTE_STEP = 200_000; // 1 point lost per 200k tokens of unused window
const WASTE_CAP = 10;
// Risky requests: strength must dominate family fit (max 60) plus the waste
// discount (max 10), so the strongest tier always serves dangerous work.
const RISKY_STRENGTH_WEIGHT = 20;

// Tie rotation (Part 6): candidates within this epsilon of the top score are
// "equivalent" and the winner rotates among them. Clear winners stay fixed.
const TIE_EPSILON = 12;
let tieRotationCursor = 0;

// Name-based reasoner detection: the provider-based isThinking flag marks
// every openai/anthropic/openrouter model as thinking, so it differentiates
// nothing. Real reasoners carry the name signal.
const REASONER_PATTERN = /r1|reasoner|o1-|o3-|thinking|deepseek-r/i;

// Strong code signals: essentially unambiguous on their own. One pattern per
// signal - countMatches weighs per pattern, so alternatives must be split out.
const CODE_STRONG: RegExp[] = [
  /```/, // fenced code block
  /\btraceback\b/i,
  /\bstack\s?trace\b|\bstacktrace\b/i,
  /\b(?:TypeError|ReferenceError|SyntaxError|NameError|KeyError|IndexError|AttributeError)\b/,
  /\bNullPointerException\b|\bSegmentationFault\b|\bpanic:/,
  /\b(?:compile|compilation|build|lint)\s+(?:error|failed|fails)\b/i,
];

// Soft code signals: each adds weight; a single one is suggestive, several are sure.
const CODE_SOFT: RegExp[] = [
  /\b(?:function|method|class|variable|array)\b/i,
  /\b(?:api|endpoint|regex|script|library|framework|compiler|runtime|snippet|algorithm)\b/i,
  /\b(?:debug|refactor|implement|optimize)\b/i,
  /\bfix(?:es|ing)?\b/i,
  /\bunit\s?tests?\b|\btest\s+cases?\b/i,
  /\b(?:def |class |import |export |const |let |var |async |await )\b/,
  /\b(?:#include|public |private |fn |func |package )\b/,
  /=>/,
  /;\s*$|\{\s*$/m,
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|java|c|cpp|h|go|rs|rb|php|cs|swift|kt|sql|sh|yml|yaml|json)\b/i,
  /\b(?:src|lib|app|components?|utils?|tests?|services?|controllers?)\/[\w/.-]+\.\w+/i,
];

// Reasoning / math signals: prefer models that think.
const REASONING_SOFT: RegExp[] = [
  /\bstep[- ]by[- ]step\b/i,
  /\b(?:derive|proof|prove)\b/i,
  /\bexplain\s+why\b/i,
  /\b(?:reason|think)\s+(?:this\s+)?(?:through|it\s+through)\b/i,
  /\bwork\s+through\b/i,
  /\b(?:calculate|compute|solve)\b/i,
  /\b(?:equation|theorem|probability|permutation|combinatoric(?:s)?)\b/i,
  /\b(?:time|space)\s+complexity\b|\bbig[- ]?o\b/i,
  /\btrade[- ]?offs?\b/i,
  /\barchitecture\b/i,
  /\bdesign\s+(?:decision|pattern|review)\b/i,
  /\bpros\s+and\s+cons\b/i,
  /\broot\s+cause\b/i,
  /\d+\s*[+\-*/^]\s*\d+/,
  /\\frac|\\int|\\sum|\\lim/,
];

// Risk signals (Jev rule): production data, money flows, credentials and
// destructive operations. One decisive signal or two soft ones set the risky
// flag; deliberately tight, because the flag biases routing toward the
// strongest tier and a false positive only wastes a little money.
const RISKY_STRONG: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+-rf\b|\bdel\s+\/[sq]\b/i, why: 'destructive delete' },
  { re: /\bdrop\s+(?:table|database|schema|index)\b/i, why: 'drop schema' },
  { re: /\btruncate\s+table\b/i, why: 'truncate table' },
  { re: /\b(?:force[- ]push|reset\s+--hard)\b/i, why: 'force push / hard reset' },
  { re: /\bprod(?:uction)?\s+(?:db|database|server|env|environment|data|system)\b/i, why: 'production system' },
  { re: /\bdelete\s+(?:all|every|the\s+(?:whole|entire))\b/i, why: 'bulk delete' },
  { re: /\brotate\s+(?:the\s+)?(?:api[- ]?)?keys?\b/i, why: 'key rotation' },
];
const RISKY_SOFT: Array<{ re: RegExp; why: string }> = [
  { re: /\bproduction\b|\bgo[- ]live\b|\blive\s+traffic\b/i, why: 'production' },
  { re: /\bmigrat(?:e|ion|ing)\b/i, why: 'migration' },
  { re: /\b(?:deploy|rollout)\b/i, why: 'deploy' },
  { re: /\b(?:stripe|paypal|billing|refund)\b/i, why: 'payments' },
  { re: /\b(?:private\s+key|secret\s+key|credentials?|rotate\s+keys?)\b/i, why: 'credentials' },
];

/** Decisive risk hit, or two soft ones together. Empty when not risky. */
function detectRisk(text: string): string[] {
  const hits: string[] = [];
  for (const { re, why } of RISKY_STRONG) if (re.test(text)) hits.push(why);
  if (hits.length > 0) return hits;
  const soft: string[] = [];
  for (const { re, why } of RISKY_SOFT) if (re.test(text)) soft.push(why);
  return soft.length >= 2 ? soft.slice(0, 2) : [];
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface AutoGeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
  thought?: boolean;
  [key: string]: unknown;
}

export interface AutoGeminiBody {
  systemInstruction?: { parts?: AutoGeminiPart[] };
  contents?: { parts?: AutoGeminiPart[]; role?: string }[];
}

export interface RoutePlan {
  chain: CustomModel[];
  task: string;
  reason: string;
  tokens: number;
  compressed: boolean;
  body: AutoGeminiBody;
}

// ─── Virtual model ────────────────────────────────────────────────────────

export function buildAutoModel(): CustomModel {
  return {
    name: 'models/' + AUTO_EXTERNAL_NAME,
    displayName: AUTO_DISPLAY_NAME,
    description:
      'Routes each request to the best model you configured (vision / code / reasoning / long context / quick), with automatic fallback.',
    provider: 'custom',
    apiKey: 'none',
    apiUrl: 'http://127.0.0.1/' + AUTO_EXTERNAL_NAME,
    externalModelName: AUTO_EXTERNAL_NAME,
  };
}

export function isAutoModel(m: CustomModel): boolean {
  return m.provider === 'custom' && m.externalModelName === AUTO_EXTERNAL_NAME;
}

// ─── Token estimation ─────────────────────────────────────────────────────

function safeJsonLen(v: unknown): number {
  try {
    return JSON.stringify(v ?? '').length;
  } catch {
    return String(v ?? '').length;
  }
}

function partTokens(p: AutoGeminiPart): number {
  if (typeof p.text === 'string') return Math.ceil(p.text.length / CHARS_PER_TOKEN);
  const mime = (p.inlineData?.mimeType || p.fileData?.mimeType || '').toLowerCase();
  if (p.inlineData || mime.startsWith('image/')) return IMAGE_FLAT_TOKENS;
  // Tool traffic counts: call args and results are real context (often the
  // bulk of agent turns) - treating structured parts as free made the router
  // skip compression on oversized agent conversations.
  const fc = p.functionCall as { args?: unknown } | undefined;
  if (fc) return Math.ceil(safeJsonLen(fc.args) / CHARS_PER_TOKEN);
  const fr = p.functionResponse as { response?: unknown } | undefined;
  if (fr) return Math.ceil(safeJsonLen(fr.response) / CHARS_PER_TOKEN);
  return 0;
}

export function estimateTokens(body: AutoGeminiBody): number {
  let total = 0;
  if (body.systemInstruction?.parts) {
    for (const p of body.systemInstruction.parts) total += partTokens(p);
  }
  for (const c of body.contents || []) {
    for (const p of c.parts || []) total += partTokens(p);
  }
  return total + ANSWER_HEADROOM;
}

// ─── Task classification ──────────────────────────────────────────────────

function allParts(body: AutoGeminiBody): AutoGeminiPart[] {
  const parts: AutoGeminiPart[] = [];
  if (body.systemInstruction?.parts) parts.push(...body.systemInstruction.parts);
  for (const c of body.contents || []) {
    if (c.parts) parts.push(...c.parts);
  }
  return parts;
}

function allText(body: AutoGeminiBody): string {
  return allParts(body)
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join(' ');
}

function hasImages(body: AutoGeminiBody): boolean {
  return allParts(body).some((p) => {
    if (p.inlineData) return true;
    const mime = (p.fileData?.mimeType || '').toLowerCase();
    return mime.startsWith('image/');
  });
}

function hasToolCalls(body: AutoGeminiBody): boolean {
  return allParts(body).some((p) => 'functionCall' in p || 'functionResponse' in p);
}

function countMatches(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const re of patterns) {
    if (re.test(text)) hits++;
  }
  return hits;
}

export interface RequestClass {
  task: 'vision' | 'code' | 'reasoning' | 'long' | 'quick' | 'chat' | 'forced';
  reason: string;
  forcedModel?: string;
  /**
   * Jev rule: the request touches production data, money, credentials or
   * destructive operations. Orthogonal to the task kind (a request can be
   * vision AND risky): it adds a strength bonus to scoring and disables the
   * right-sizing discount, so the strongest tier serves dangerous work.
   */
  risky?: boolean;
}

export function classifyRequest(body: AutoGeminiBody): RequestClass {
  const text = allText(body);

  const forced = text.match(/#model:(\S+)/);
  if (forced) return { task: 'forced', reason: 'tag #model:', forcedModel: forced[1] };

  // Risk rides along on any task kind (a request can be quick AND risky), so
  // it is detected once here and attached to every classification below.
  const riskHits = detectRisk(text);
  const risky = riskHits.length > 0;
  const riskNote = risky ? `; risky: ${riskHits.join(', ')}` : '';
  const withRisk = (r: RequestClass): RequestClass => (risky ? { ...r, risky: true } : r);

  if (text.includes('#:code')) return withRisk({ task: 'code', reason: 'tag #:code' + riskNote });
  if (text.includes('#:vision')) return withRisk({ task: 'vision', reason: 'tag #:vision' + riskNote });

  if (hasImages(body)) return withRisk({ task: 'vision', reason: 'image part in request' + riskNote });

  // Weighted signals: tool calls are agent traffic (always code-shaped);
  // fenced blocks / error traces are decisive; keywords only suggest.
  let codeScore = countMatches(text, CODE_STRONG) * 3 + countMatches(text, CODE_SOFT) * 1.5;
  if (hasToolCalls(body)) codeScore += 3;
  const reasoningScore = countMatches(text, REASONING_SOFT) * 1.5;
  const len = text.length;

  if (codeScore >= 3) {
    const why: string[] = [];
    if (hasToolCalls(body)) why.push('tool call in request');
    if (/```/.test(text)) why.push('code block');
    if (countMatches(text, CODE_STRONG) > 0) why.push('error/trace patterns');
    if (why.length === 0) why.push(`${countMatches(text, CODE_SOFT)} code signals`);
    return withRisk({ task: 'code', reason: 'code detected (' + why.join(', ') + ')' + riskNote });
  }
  if (reasoningScore >= 3) return withRisk({ task: 'reasoning', reason: 'reasoning/math request' + riskNote });
  if (len > 8000) return withRisk({ task: 'long', reason: 'long input (>8k chars)' + riskNote });
  if (len < 200) return withRisk({ task: 'quick', reason: 'short input' + riskNote });
  if (codeScore >= 1.5) return withRisk({ task: 'code', reason: 'code keywords detected' + riskNote });
  return withRisk({ task: 'chat', reason: 'general chat' + riskNote });
}

// ─── Model ranking ────────────────────────────────────────────────────────

function nameOf(m: CustomModel): string {
  return (m.externalModelName + ' ' + m.displayName).toLowerCase();
}

function capOf(m: CustomModel): { maxTokens: number; supportsImages: boolean; isThinking: boolean } {
  const cap = detectModelCapabilities(m, true);
  return { maxTokens: cap.maxTokens, supportsImages: cap.supportsImages, isThinking: cap.isThinking };
}

// ─── Certainty gate (asymmetric upgrade / downgrade, Jev rule) ────────────

// Cheap-tier names never count as "strong", however big their window.
const QUICK_TIER = /mini|flash|nano|haiku|8b|3b|small|lite/i;

/**
 * Coarse model strength for the risky path and the certainty gate: reasoner
 * flag plus window size, quick-tier names capped at zero. It only has to
 * separate obvious tiers, not rank fine differences.
 */
function strengthOf(m: CustomModel): number {
  const n = nameOf(m);
  if (QUICK_TIER.test(n)) return 0;
  return (REASONER_PATTERN.test(n) ? 2 : 0) + Math.min(2, capOf(m).maxTokens / 200_000);
}

// Below this score gap the classifier is not sure which candidate fits, and
// per the Jev rule an unsure router must not serve LESS: the stronger model
// takes the lead. A weaker model only keeps the top seat with a confident
// margin. Chat and quick tasks are excluded - rotating balanced families and
// picking fast models there is the intended behavior, not a downgrade.
const UNCERTAIN_MARGIN = 8;
const CAPABILITY_TASKS = new Set(['code', 'reasoning', 'long', 'vision']);

interface ScoredModel {
  m: CustomModel;
  score: number;
  bits: string[];
}

/**
 * Reorders a score-sorted (descending) list so that, within the uncertain
 * band, a stronger rival displaces a weaker leader. Health is already inside
 * the score, so a sick model rarely sits in the band, and the breaker still
 * skips dead models at dial time. No-op for chat/quick and clear winners.
 */
function applyCertaintyGate(scored: ScoredModel[], task: string): ScoredModel[] {
  if (scored.length < 2 || !CAPABILITY_TASKS.has(task)) return scored;
  const top = scored[0];
  let strongest: ScoredModel | null = null;
  for (const s of scored) {
    if (top.score - s.score > UNCERTAIN_MARGIN) break; // sorted desc: the rest are further behind
    if (strengthOf(s.m) > strengthOf(top.m) && (!strongest || strengthOf(s.m) > strengthOf(strongest.m))) {
      strongest = s;
    }
  }
  if (!strongest) return scored;
  return [
    { m: strongest.m, score: strongest.score, bits: [...strongest.bits, 'certainty: stronger model within margin'] },
    ...scored.filter((s) => s !== strongest),
  ];
}

/**
 * Additive routing score for one model against one task. Higher wins.
 * The `bits` describe what earned the points, for the reason string.
 */
function scoreFor(
  m: CustomModel,
  task: string,
  need: number,
  risky = false,
): { score: number; bits: string[] } {
  const n = nameOf(m);
  const cap = capOf(m);
  const hints = FAMILY_HINTS[task] || [];
  const bits: string[] = [];
  let score = 0;

  // 1. Task-family name fit: 60 for the most-specific hint, sliding to 0.
  const QUICK_HINTS = new Set(['mini', 'flash', 'nano', 'haiku', '8b', '3b', 'small', 'lite']);
  for (let i = 0; i < hints.length; i++) {
    if (n.includes(hints[i])) {
      score += TASK_BASE - i * TASK_STEP;
      bits.push(QUICK_HINTS.has(hints[i]) ? 'fast model' : `${hints[i]} family`);
      break;
    }
  }

  // 2. Actual capability: real reasoners (by name, not provider) get extra
  //    credit on brainy tasks. Provider flags mark everything thinking, which
  //    made the bonus universal and useless for ranking.
  if ((task === 'code' || task === 'reasoning' || task === 'long') && REASONER_PATTERN.test(n)) {
    score += THINKING_BONUS;
    bits.push('reasoner');
  }

  // 3. Health: the breaker's penalty (failures, slow EWMA) pulls a model down.
  score -= smartHealth.penalty(healthKey(m)) * HEALTH_WEIGHT;

  // 4. Risky requests (Jev rule): strength dominates every other term, and the
  //    right-sizing discount below is skipped - a big window is a feature when
  //    the request is dangerous, so the cheap tiers cannot win on fit alone.
  if (risky) {
    score += strengthOf(m) * RISKY_STRENGTH_WEIGHT;
    bits.push('risky: strong tier');
    return { score, bits };
  }

  // 5. Right-sizing: a window much bigger than needed is a mild negative so
  //    cheap/small models win ties, but it can never beat task fit.
  const waste = Math.max(0, cap.maxTokens - need);
  score -= Math.min(WASTE_CAP, waste / WASTE_STEP);

  return { score, bits };
}

/** Normalizes a forced #model: tag for forgiving matching (case, prefixes, separators). */
function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[_\s]+/g, '-');
}

function matchForced(models: CustomModel[], tag: string): CustomModel | undefined {
  const t = normalizeTag(tag);
  return models.find((m) => {
    const ext = normalizeTag(m.externalModelName);
    const full = normalizeTag(nameOf(m));
    const nm = normalizeTag(m.name);
    return ext === t || full.includes(t) || nm.endsWith('/' + t);
  });
}

/**
 * Ranks the configured models for this request and returns the fallback chain.
 * The first entry is the primary pick; the rest are tried on failure.
 */
export function pickChain(models: CustomModel[], body: AutoGeminiBody): CustomModel[] {
  return explainRoute(models, body).chain;
}

/**
 * Ranked fallback chain for a request the user pinned to a specific model
 * (free-router behavior: capability filter first, then health-aware ranking,
 * not raw config-file order). The selected model itself is NOT included.
 */
export function rankFallbacks(
  selected: CustomModel,
  candidates: CustomModel[],
  body: AutoGeminiBody,
): CustomModel[] {
  const pool = candidates.filter((m) => !isAutoModel(m) && m !== selected);
  if (pool.length === 0) return [];

  const cls = classifyRequest(body);
  const need = estimateTokens(body);

  // Hard requirement, same as Auto: a vision task must fall back to seers.
  let usable = pool;
  if (cls.task === 'vision') {
    const seers = pool.filter((m) => capOf(m).supportsImages);
    if (seers.length > 0) usable = seers;
  }

  // Models whose window can't fit the (uncompressed) request only help after
  // compression is impossible mid-chain - keep them, but last.
  const fitting = usable.filter((m) => capOf(m).maxTokens >= need);
  const rankedPool = fitting.length > 0 ? fitting : usable;

  const scored = rankedPool
    .map((m) => ({ m, ...scoreFor(m, cls.task, need, cls.risky) }))
    // Breaker-open models are skipped live at dial time; ranking already sinks
    // sick models via the penalty, so no additional filter here.
    .sort(
      (a, b) =>
        b.score - a.score ||
        capOf(a.m).maxTokens - capOf(b.m).maxTokens ||
        a.m.displayName.localeCompare(b.m.displayName),
    );

  return applyCertaintyGate(scored, cls.task)
    .slice(0, MAX_CHAIN)
    .map((s) => s.m);
}

interface RouteExplanation {
  chain: CustomModel[];
  reason: string;
}

function explainRoute(models: CustomModel[], body: AutoGeminiBody): RouteExplanation {
  const cls = classifyRequest(body);

  if (cls.task === 'forced' && cls.forcedModel) {
    const hit = matchForced(models, cls.forcedModel);
    return { chain: hit ? [hit] : [], reason: `${cls.reason} ${cls.forcedModel}` };
  }

  const need = estimateTokens(body);
  let cands = models.filter((m) => !isAutoModel(m));

  // Hard requirement: vision tasks only go to models that can see.
  if (cls.task === 'vision') {
    const seers = cands.filter((m) => capOf(m).supportsImages);
    if (seers.length > 0) cands = seers;
  }

  if (cands.length === 0) return { chain: [], reason: cls.reason };

  // Prefer models whose window actually fits; fall back to everyone only if
  // nothing does (planAutoRoute will compress and re-pick in that case).
  const fitting = cands.filter((m) => capOf(m).maxTokens >= need);
  const pool0 = fitting.length > 0 ? fitting : cands;
  // Breaker is advisory: skip open models unless that would leave nothing to try.
  const usable = pool0.filter((m) => !smartHealth.isOpen(healthKey(m)));
  const pool = usable.length > 0 ? usable : pool0;

  const scored = pool.map((m) => ({ m, ...scoreFor(m, cls.task, need, cls.risky) }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      capOf(a.m).maxTokens - capOf(b.m).maxTokens ||
      a.m.displayName.localeCompare(b.m.displayName),
  );

  // Tie rotation (Part 6): near-equal candidates take turns winning so the
  // same model doesn't monopolize chat traffic. A clear winner (gap > epsilon
  // over the runner-up) keeps position 0 deterministically.
  const top = scored[0].score;
  const tiedCount = scored.filter((s) => top - s.score <= TIE_EPSILON).length;
  let rotated = 0;
  if (tiedCount > 1) {
    rotated = tieRotationCursor % tiedCount;
    tieRotationCursor = (tieRotationCursor + 1) % tiedCount;
    const [winner] = scored.splice(rotated, 1);
    scored.unshift(winner);
  }

  // Certainty gate runs AFTER rotation: for capability tasks it outranks the
  // rotation when a stronger model sits within the uncertain band (routing
  // down on a hunch is exactly what the Jev rule forbids). Equally strong
  // near-ties still rotate.
  const ordered = applyCertaintyGate(scored, cls.task);

  const chain = ordered.slice(0, MAX_CHAIN).map((s) => s.m);
  const win = ordered[0];
  const why = win.bits.length > 0 ? ` (${win.bits.slice(0, 3).join(', ')})` : '';
  const tieNote = tiedCount > 1 ? ` [rotated among ${tiedCount} near-tied]` : '';
  return { chain, reason: `${cls.reason}; ${win.m.displayName}${why}${tieNote}` };
}

// ─── Local compression (last resort, no extra API call) ───────────────────

export function compressContents(body: AutoGeminiBody, keepRecent = 6): AutoGeminiBody {
  const contents = body.contents || [];
  if (contents.length <= keepRecent + 1) return body;

  const old = contents.slice(0, contents.length - keepRecent);
  const recent = contents.slice(contents.length - keepRecent);

  const lines: string[] = [];
  for (const c of old) {
    const text = (c.parts || [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join(' ')
      .slice(0, 400);
    lines.push(`${c.role || 'user'}: ${text}`);
  }
  const digest: { role: string; parts: AutoGeminiPart[] } = {
    role: 'user',
    parts: [
      {
        text:
          `[Compressed earlier conversation (${old.length} turns) - decisions, ` +
          `files and errors above were condensed]\n` +
          lines.join('\n'),
      },
    ],
  };

  return { ...body, contents: [digest, ...recent] };
}

// ─── Full plan ────────────────────────────────────────────────────────────

export function planAutoRoute(models: CustomModel[], body: AutoGeminiBody): RoutePlan {
  const cls = classifyRequest(body);
  let work = body;
  let tokens = estimateTokens(work);
  let compressed = false;

  let picked = explainRoute(models, work);

  // Nothing fits any window -> compress older turns locally and retry.
  const biggest = Math.max(0, ...models.filter((m) => !isAutoModel(m)).map((m) => capOf(m).maxTokens));
  if (picked.chain.length > 0 && tokens > biggest) {
    work = compressContents(work);
    tokens = estimateTokens(work);
    compressed = true;
    picked = explainRoute(models, work);
  }

  return {
    chain: picked.chain,
    task: cls.task,
    reason: `${picked.reason}${compressed ? ' + compressed context' : ''}`,
    tokens,
    compressed,
    body: work,
  };
}

/**
 * JEV Mode plan: same routing as planAutoRoute, but when the request outgrows
 * the best model's window it first tries model-judged verbatim compaction
 * (jevCompact) and only falls back to the local lossy digest when the judge
 * fails or keeps everything. Smart token utilization: make the context fit
 * the best task-matched model instead of degrading to a worse one.
 */
export async function planAutoRouteJev(
  models: CustomModel[],
  body: AutoGeminiBody,
  opts?: JevOptions,
): Promise<RoutePlan> {
  const need = estimateTokens(body);
  const route = explainRoute(models, body);
  if (route.chain.length === 0) return planAutoRoute(models, body);

  const target = capOf(route.chain[0]).maxTokens;
  if (need <= target) return planAutoRoute(models, body); // fits - no compaction needed

  const out = await jevCompact(models, body, target, opts);
  if (out) {
    const after = planAutoRoute(models, out.body as unknown as AutoGeminiBody);
    if (after.chain.length > 0) {
      const s = out.stats;
      return {
        ...after,
        compressed: true,
        reason:
          after.reason +
          ` + JEV compaction (~${Math.round(s.tokensBefore / 1000)}k -> ~${Math.round(s.tokensAfter / 1000)}k tokens, ` +
          `${s.callsKept} calls kept, ${s.callsDropped} dropped` +
          `${s.resultsTruncated > 0 ? `, ${s.resultsTruncated} results truncated` : ''}, judge: ${s.judge})`,
      };
    }
  }
  // Judge failed or kept everything: the local digest fallback (original behavior).
  return planAutoRoute(models, body);
}
