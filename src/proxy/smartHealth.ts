/**
 * Smart health: circuit breaker + error classifier for the Auto router.
 * Electron-free so autoRouter and vitest can use it directly.
 * Keyed by model name (routing is per-CustomModel, not per-provider).
 */

export interface SwitchVerdict {
  switch: boolean;
  retrySame: boolean;
  reason: string;
}

/** Pure classifier: which failures deserve a switch / same-model retry. */
export function shouldSwitch(status?: number, err?: Error): SwitchVerdict {
  if (err) {
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('abort') || msg.includes('timeout') || msg.includes('timed out'))
      return { switch: true, retrySame: false, reason: 'timeout' };
    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('econnreset'))
      return { switch: true, retrySame: false, reason: 'network unreachable' };
    if (msg.includes('429') || msg.includes('rate limit'))
      return { switch: true, retrySame: true, reason: 'rate limited' };
  }
  if (status !== undefined) {
    if (status === 429) return { switch: true, retrySame: true, reason: 'rate limited' };
    if (status === 408 || status === 504) return { switch: true, retrySame: true, reason: 'gateway timeout' };
    if (status === 500 || status === 502 || status === 503)
      return { switch: true, retrySame: true, reason: 'server error' };
    if (status === 401 || status === 403) return { switch: true, retrySame: false, reason: 'auth failure' };
    if (status === 404) return { switch: true, retrySame: false, reason: 'model not found' };
    // Billing/size/model-specific rejections: another model may accept the
    // exact same request, so rotate instead of killing the agent.
    if (status === 402) return { switch: true, retrySame: false, reason: 'payment required / out of credits' };
    if (status === 413) return { switch: true, retrySame: false, reason: 'payload too large' };
    if (status === 422) return { switch: true, retrySame: false, reason: 'unprocessable by this model' };
    // 400 and other 4xx are the client's fault - fail fast, don't blame the model.
    return { switch: false, retrySame: false, reason: `client error ${status}` };
  }
  return { switch: false, retrySame: false, reason: 'unknown' };
}

/**
 * Body snippets that indicate HARD quota/rate exhaustion (Part 3). When the
 * upstream clearly says the quota is gone, retrying the same model is wasted
 * budget - switch immediately. Snippets are matched, never logged.
 */
const QUOTA_PATTERN =
  /quota\s*(?:exceeded|exhausted)|rate\s*limit\s*(?:exceeded|reached|hit)|resource\s*exhausted|too many requests|daily\s*limit|(?:tokens?|requests?)\s*per\s*minute|insufficient\s*(?:quota|credits?)|capacity|temporarily unavailable|exceeded your current quota/i;

/**
 * Body snippets meaning the request does not fit the model's context window.
 * OpenAI, Anthropic and Google all report this as a plain 400/413, which the
 * status classifier fails fast on - but it is the one "client error" routing
 * can actually fix: JEV-compact the context or move to a bigger-window model.
 * Without this, a long agent conversation ends in "Agent execution
 * terminated" instead of switching models.
 */
const CONTEXT_OVERFLOW_PATTERN =
  /context[_ ]length|context_length_exceeded|prompt (?:is )?too long|too many (?:input )?tokens|input too long|input length exceeded|maximum context|exceeds? the (?:maximum|model'?s|context|token|input)|reduce the (?:length|prompt|input)|token limit/i;

/** True when an upstream error body says the request outgrew the model's window. */
export function isContextOverflow(snippet: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(snippet || '');
}

/**
 * Classifies a failed response using BOTH status and (safe, snippet-only)
 * body inspection. Hard quota signals override the retry budget: switch now.
 */
export function shouldSwitchBody(status: number | undefined, bodySnippet: string): SwitchVerdict {
  // Context overflow outranks everything: never retry the same model
  // uncompressed - the chain must compact or pick a bigger window.
  if (isContextOverflow(bodySnippet)) {
    return { switch: true, retrySame: false, reason: 'prompt too long for context window' };
  }
  const base = shouldSwitch(status);
  if (QUOTA_PATTERN.test(bodySnippet || '')) {
    // Hard quota exhaustion: switching is mandatory, same-model retry is not.
    return { switch: true, retrySame: false, reason: 'quota exhausted' };
  }
  return base;
}

interface Entry {
  fails: number;
  openUntil: number;
  latencyMs: number; // EWMA
  samples: number;
}

const FAILS_TO_OPEN = 3;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;

export class HealthMonitor {
  private health = new Map<string, Entry>();

  private entry(key: string): Entry {
    let e = this.health.get(key);
    if (!e) {
      e = { fails: 0, openUntil: 0, latencyMs: 0, samples: 0 };
      this.health.set(key, e);
    }
    return e;
  }

  /** True while the breaker is open. Expired breakers reset lazily. */
  isOpen(key: string): boolean {
    const e = this.health.get(key);
    if (!e || e.openUntil === 0) return false;
    if (Date.now() < e.openUntil) return true;
    e.fails = 0;
    e.openUntil = 0;
    return false;
  }

  /** Sort penalty: sick models sink below healthy ones with equal task score. */
  penalty(key: string): number {
    const e = this.health.get(key);
    if (!e || e.fails === 0) return 0;
    // ponytail: slow EWMA (>5s) costs extra so future picks prefer faster models
    const slow = e.samples > 0 && e.latencyMs > 5000 ? 0.5 : 0;
    return Math.min(e.fails * 0.5, 1.5) + slow;
  }

  /** Observed latency EWMA in ms, 0 when the model was never dialed (JEV judge ranking). */
  latency(key: string): number {
    const e = this.health.get(key);
    return e && e.samples > 0 ? e.latencyMs : 0;
  }

  reportSuccess(key: string, latencyMs: number): void {
    const e = this.entry(key);
    e.fails = 0;
    e.openUntil = 0;
    e.latencyMs = e.samples > 0 ? e.latencyMs * 0.7 + latencyMs * 0.3 : latencyMs;
    e.samples += 1;
  }

  reportFailure(key: string): void {
    const e = this.entry(key);
    e.fails += 1;
    if (e.fails >= FAILS_TO_OPEN) {
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (e.fails - FAILS_TO_OPEN), MAX_BACKOFF_MS);
      e.openUntil = Date.now() + backoff;
    }
  }

  /** Test hook. */
  clear(): void {
    this.health.clear();
  }
}

export const smartHealth = new HealthMonitor();
