/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';
import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CustomModel {
  name: string;
  /** ponytail: dashboard "Off Model" switch - when true this model is hidden from the IDE picker but kept for reuse. */
  disabled?: boolean;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  _slug?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface GeminiRequestBody {
  model?: string;
  modelId?: string;
  model_id?: string;
  request?: GeminiRequestBody;
  systemInstruction?: { parts: { text?: string }[] };
  contents?: {
    parts?: { text?: string; functionCall?: unknown; functionResponse?: unknown; thought?: boolean }[];
    role?: string;
  }[];
  tools?: unknown[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

// ─── Imports ──────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let proxyPort = 0;

// Shared cross-turn state
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  touchStateTimestamp,
  startCleanupInterval,
  stopCleanupInterval,
} from './proxy/shared';

// Model configuration & capability detection
import { detectModelCapabilities, detectModelCapabilitiesByName, healthKey } from './proxy/modelUtils';

// Provider translator registry (auto-discovers translators from proxy/translators/)
import * as registry from './proxy/registry';

// Auto Smart Router: virtual model that picks the best configured model per request
import {
  buildAutoModel,
  isAutoModel,
  planAutoRoute,
  planAutoRouteJev,
  rankFallbacks,
  estimateTokens,
  type AutoGeminiBody,
} from './proxy/autoRouter';

// JEV Mode: model-judged verbatim context compaction + live model health testing
import { jevCompact, lastJevStats } from './proxy/jevMode';

// Routing activity: what the router ACTUALLY did per request (dashboard panel)
import { recordRouting, recentRouting, type RoutingEvent } from './proxy/routingLog';

// Unified Gateway: Anthropic-compatible API so Claude Code & any tool can use
// every configured model (they reject non-Claude model names; the gateway
// accepts ANY name and routes it).
import {
  anthropicToGemini,
  geminiToAnthropicResponse,
  AnthropicStreamFramer,
  estimateTokens as estimateRequestTokens,
  getUnifiedKey,
  resetUnifiedKey,
  hasUnifiedKey,
  type AnthropicMessagesRequest,
} from './proxy/unifiedGateway';

// Model Dashboard: browser UI + REST API over custom_models.json (served at /dashboard)
import * as dashboard from './proxy/dashboard';
import { smartHealth, shouldSwitch, shouldSwitchBody, isContextOverflow } from './proxy/smartHealth';

// Electron-safeStorage key store (imported statically so tests can mock it)
import * as cryptoStore from './cryptoStore';

// Model config validation (standalone module, no dependency cycle)
import { validateCustomModel } from './schemaValidator';

// ─── Model Helpers ────────────────────────────────────────────────────────

function placeholderInput(model: CustomModel): string {
  return `${model.provider || ''}:${model.displayName || model.name || 'custom-model'}:${model.externalModelName || ''}`.toLowerCase();
}

interface PlaceholderAssignment {
  key: string;
  map: Map<string, string>;
}
let placeholderAssignment: PlaceholderAssignment | null = null;

/**
 * Placeholder IDs must be STABLE across restarts and match what the IDE has
 * cached, or the picker can no longer resolve entries (selection snaps back
 * to a Google model). So: every model keeps its legacy 3-digit ID
 * (400 + hash % 200) verbatim, and only when two models collide on the same
 * slot does the later one (sorted by name) get a longer disambiguated ID.
 * With 40+ models in 200 legacy slots collisions were guaranteed - before,
 * both entries shared one ID and resolved to whichever matched first.
 */
function placeholderIdFor(model: CustomModel, all: CustomModel[]): string {
  // The disabled flag must NOT influence the assignment: the IDE caches
  // placeholder IDs across toggles and proxy restarts, so an enable/disable
  // flip that reshuffled collision winners would silently re-point a stale
  // picker entry at the wrong model (a disabled model "kept answering").
  // Sorting by name alone makes every ID a pure function of the model set.
  const ordered = [...all].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const key = ordered
    .map((m) => `${m.name}|${m.provider}|${m.externalModelName}|${m.displayName}`)
    .join(';');
  if (!placeholderAssignment || placeholderAssignment.key !== key) {
    const map = new Map<string, string>();
    const used = new Set<string>();
    for (const m of ordered) {
      const h = crypto.createHash('sha1').update(placeholderInput(m)).digest().readUInt32BE(0);
      const base = 400 + (h % 200);
      let id = `MODEL_PLACEHOLDER_M${base}`;
      if (used.has(id)) {
        let tail = 1000 + (h % 9000);
        id = `MODEL_PLACEHOLDER_M${base}${tail}`;
        while (used.has(id)) id = `MODEL_PLACEHOLDER_M${base}${++tail}`;
      }
      used.add(id);
      map.set(m.name || '', id);
    }
    placeholderAssignment = { key, map };
  }
  return (
    placeholderAssignment.map.get(model.name || '') ||
    `MODEL_PLACEHOLDER_M${400 + (crypto.createHash('sha1').update(placeholderInput(model)).digest().readUInt32BE(0) % 200)}`
  );
}

export function generateModelPlaceholderId(model: CustomModel, all?: CustomModel[]): string {
  return placeholderIdFor(model, all || loadCustomModels());
}

function getCustomModelsPath(): string {
  const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
  return path.join(geminiDir, 'custom_models.json');
}

// ─── Router Settings (dashboard ON/OFF toggle) ────────────────────────────

function getRouterSettingsPath(): string {
  const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
  return path.join(geminiDir, 'router_settings.json');
}

export interface RouterSettings {
  /** Master switch for Auto Rotation / Smart Router. Default: ON. */
  autoRouter: boolean;
  /**
   * JEV Mode: model-judged verbatim context compaction. When a request
   * outgrows the best model's window, the healthiest configured model is
   * probed (which also live-tests it) to decide which old tool calls/results
   * are still needed; failing judges are reported to the circuit breaker and
   * the next candidate takes over. Falls back to the local digest when every
   * judge fails. Default: ON.
   */
  jevMode: boolean;
  /**
   * Show a short "routed: X -> Y" note as the first line of the answer
   * whenever the router or JEV switched/re-picked the model. Off by default:
   * the answer text becomes part of the conversation the agent later sees
   * (even though notes are stripped from history before routing), and the
   * IDE extension's status bar shows the same info without touching the
   * answer. Opt in via the dashboard.
   */
  switchNotice: boolean;
}

/** Reads router_settings.json; notes default OFF, everything else ON. */
export function loadRouterSettings(): RouterSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(getRouterSettingsPath(), 'utf-8')) as Partial<RouterSettings>;
    return {
      autoRouter: raw.autoRouter !== false,
      jevMode: raw.jevMode !== false,
      switchNotice: raw.switchNotice === true,
    };
  } catch {
    return { autoRouter: true, jevMode: true, switchNotice: false };
  }
}

function saveRouterSettings(s: RouterSettings): boolean {
  try {
    const filePath = getRouterSettingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(s, null, 2), 'utf-8');
    return true;
  } catch (e) {
    log.error('[Router] Failed to write router_settings.json', e);
    return false;
  }
}

/** Shared normalizer for toSlug/toLegacySlug (identical rules, single copy). */
function slugPart(s: string): string {
  return s
    .replace(/^models\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function toSlug(model: CustomModel): string {
  // ponytail: virtual Auto keeps its stable legacy slug so existing picks keep routing
  if ((model.externalModelName || '') === 'auto-router') return 'custom-auto-router';
  // ponytail: provider prefix keeps same model id on different providers distinct (was colliding to one entry)
  const base = slugPart(model.externalModelName || model.name || '');
  const provider = slugPart(model.provider || '');
  return provider && !base.startsWith(provider + '-') ? `custom-${provider}-${base}` : `custom-${base}`;
}

// Legacy slug (pre-provider-prefix) so previously-picked models still route after upgrade.
export function toLegacySlug(model: CustomModel): string {
  return 'custom-' + slugPart(model.externalModelName || model.name || '');
}

// Fallback model-list entry when the upstream response can't be merged (was 3 copy-pasted blocks).
function fallbackModelsMap(models: CustomModel[]): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  models.forEach((m) => {
    const slug = toSlug(m);
    mapped[slug] = {
      displayName: m.displayName,
      maxTokens: 1048576,
      maxOutputTokens: 4096,
      model: generateModelPlaceholderId(m),
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
    };
  });
  return mapped;
}

// ─── Routing Activity (dashboard "which model actually answered") ─────────

/**
 * Per-request routing context. The IDE picker keeps showing what the user
 * selected, so the dashboard activity panel needs the original selection plus
 * any JEV compaction that ran. Keyed by the ServerResponse object: it is
 * unique per request and flows through every recursive chain dial, so no
 * handleCustomModelRequest signature changes are needed (and WeakMap entries
 * are garbage-collected with the response).
 */
interface RoutingContext {
  requested: string;
  jev?: RoutingEvent['jev'];
  /** 'anthropic' = Unified Gateway request: shape responses as Anthropic messages. */
  responseMode?: 'cloudcode' | 'anthropic';
  anthropicModel?: string;
  /**
   * The stale IDE picker selected a model that is now Off Model and the
   * request was rerouted to the best enabled model. The switch note is
   * forced for these (even with switchNotice off) - a silently rerouted
   * answer reads as "the disable didn't work".
   */
  offModelPick?: boolean;
}
const routingContexts = new WeakMap<http.ServerResponse, RoutingContext>();

function startRouting(res: http.ServerResponse, requested: string): void {
  routingContexts.set(res, { requested });
}

function noteRoutingJev(res: http.ServerResponse, jev: NonNullable<RoutingEvent['jev']>): void {
  const ctx = routingContexts.get(res);
  if (ctx) ctx.jev = jev;
}

// ─── Auto Smart Router ────────────────────────────────────────────────────

/**
 * Real custom models plus the virtual Auto (Smart Router) entry so the IDE
 * can pick Auto; it re-routes each request to the best configured model.
 */
function getRoutableModels(): CustomModel[] {
  // "Off Model" toggle: disabled models stay in custom_models.json (for Reuse)
  // but are hidden from the IDE picker and never receive routed traffic.
  const models = loadCustomModels().filter((m) => !m.disabled);
  // Part 8: surface slug/placeholder collisions loudly - a collision can make
  // the IDE resolve a pick to the wrong model without any visible error.
  const seen = new Map<string, string>();
  for (const m of models) {
    for (const id of [toSlug(m), toLegacySlug(m), generateModelPlaceholderId(m)]) {
      const prev = seen.get(id);
      if (prev && prev !== m.displayName) {
        log.warn(`[Proxy] Model ID collision: "${id}" is shared by "${prev}" and "${m.displayName}"`);
      } else if (!prev) {
        seen.set(id, m.displayName);
      }
    }
    if (!isAutoModel(m) && (toSlug(m) === 'custom-auto-router' || toLegacySlug(m) === 'custom-auto-router')) {
      log.warn(`[Proxy] Model "${m.displayName}" squats on the auto-router identity and may hijack Auto selection`);
    }
  }
  // Dashboard toggle OFF: hide the virtual Auto entry from the IDE picker.
  if (!loadRouterSettings().autoRouter) return models;
  if (models.length === 0 || models.some(isAutoModel)) return models;
  return [...models, buildAutoModel()];
}

/** Capability metadata for model-list injection; Auto advertises everything. */
function capFor(m: CustomModel, all: CustomModel[]) {
  const cap = detectModelCapabilities(m, true);
  if (!isAutoModel(m)) return cap;
  const real = all.filter((x) => !isAutoModel(x)).map((x) => detectModelCapabilities(x, true));
  return {
    ...cap,
    isThinking: true,
    supportsImages: true,
    maxTokens: Math.max(8192, ...real.map((c) => c.maxTokens)),
    maxOutputTokens: Math.max(4096, ...real.map((c) => c.maxOutputTokens)),
  };
}

/** Marker of the synthetic routing note injected into answers (see switchNotice). */
export const ROUTE_NOTE_MARKER = '⇄ routed:';

/**
 * Strips routing notes from the conversation history before a request is
 * routed. The note is written into the answer so the USER can see which
 * model replied - but the IDE replays past answers back to the model as
 * context on every following turn, so the notes are removed here again.
 * The agent never sees them; they exist only on screen.
 */
export function stripRouteNotes(body: GeminiRequestBody): void {
  const contents = body?.contents;
  if (!Array.isArray(contents)) return;
  for (const c of contents) {
    if (c.role !== 'model') continue; // user turns are the user's words - never touched
    if (!Array.isArray(c.parts)) continue;
    const hasNote = c.parts.some(
      (p) => typeof (p as { text?: unknown }).text === 'string' && String((p as { text?: unknown }).text).startsWith(ROUTE_NOTE_MARKER),
    );
    if (!hasNote) continue;
    const filtered = c.parts.filter((p) => {
      const t = (p as { text?: unknown }).text;
      return !(typeof t === 'string' && t.startsWith(ROUTE_NOTE_MARKER));
    });
    if (filtered.length > 0) {
      c.parts = filtered;
    }
    // A turn that held ONLY the note keeps its parts as-is (dropping the last
    // part could leave an empty turn, which some providers reject).
  }
}

/**
 * JEV Mode for a pinned (specific) model: when the request outgrows that
 * model's window, compact it with model-judged verbatim compaction instead of
 * letting the upstream reject it. Returns the original body when JEV is off,
 * the request already fits, or every judge failed.
 */
async function maybeJevFit(
  primary: CustomModel,
  models: CustomModel[],
  body: GeminiRequestBody,
): Promise<{ body: GeminiRequestBody; jev?: RoutingEvent['jev'] }> {
  if (!loadRouterSettings().jevMode) return { body };
  const ab = body as unknown as AutoGeminiBody;
  const window = detectModelCapabilities(primary, true).maxTokens;
  if (estimateTokens(ab) <= window) return { body };
  const out = await jevCompact(models, ab, window);
  if (!out) return { body };
  log.info(
    `[JEV] "${primary.displayName}" window too small (~${out.stats.tokensBefore} tokens) - ` +
      `compacted to ~${out.stats.tokensAfter} by judge "${out.stats.judge}"`,
  );
  return {
    body: out.body as unknown as GeminiRequestBody,
    jev: { tokensBefore: out.stats.tokensBefore, tokensAfter: out.stats.tokensAfter, judge: out.stats.judge },
  };
}

/**
 * "Off Model" safety net: the IDE caches the model list, so a picker entry
 * for a model disabled after the last fetch can still be selected. Routing
 * that pick into the transparent Google passthrough would end in a cryptic
 * "Agent execution terminated" - instead, redirect to the best enabled model
 * (Auto Rotation ON) or answer with actionable guidance (Auto Rotation OFF).
 */
function findDisabledPick(
  modelName: string | undefined,
  modelId: string | undefined,
  all: CustomModel[],
): CustomModel | undefined {
  if (!modelName && !modelId) return undefined;
  return all.find((m) => {
    if (!m.disabled) return false;
    const enumName = generateModelPlaceholderId(m);
    return (
      (modelName !== undefined &&
        (m.name === modelName || toSlug(m) === modelName || toLegacySlug(m) === modelName || enumName === modelName)) ||
      (modelId !== undefined && enumName === modelId)
    );
  });
}

function handleDisabledModelPick(
  res: http.ServerResponse,
  disabled: CustomModel,
  geminiBody: GeminiRequestBody,
  isStream: boolean,
): void {
  startRouting(res, disabled.displayName);
  const rctx = routingContexts.get(res);
  if (rctx) rctx.offModelPick = true;
  const enabled = loadCustomModels().filter((m) => !m.disabled && !isAutoModel(m));
  if (!loadRouterSettings().autoRouter || enabled.length === 0) {
    log.warn(`[Router] "${disabled.displayName}" is disabled (Off Model) - rejecting with guidance`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: `"${disabled.displayName}" is disabled (Off Model) in the Jev AnityG-Mode dashboard.${
            enabled.length > 0
              ? ' Pick another model, or turn on Auto Rotation to route to the best available one.'
              : ' No enabled models remain - re-enable one in the dashboard.'
          }`,
        },
      }),
    );
    return;
  }
  log.warn(`[Router] "${disabled.displayName}" is disabled (Off Model) - routing to the best available model instead`);
  const chain = rankFallbacks(disabled, enabled, geminiBody as unknown as AutoGeminiBody);
  if (chain.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No enabled model can serve this request.' } }));
    return;
  }
  const [primary, ...fallbacks] = chain;
  handleCustomModelRequest(res, primary, geminiBody, isStream, 0, fallbacks);
}

// ─── Unified Gateway (Anthropic-compatible API for Claude Code) ───────────

function anthropicError(res: http.ServerResponse, status: number, type: string, message: string): void {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/**
 * Anthropic-compatible /v1/messages: ANY model name is accepted. An exact
 * match routes to that configured model (with its fallback chain); anything
 * else (claude-sonnet-4-5, ...) routes through the Auto Smart Router, so
 * Claude Code works without ever seeing a model-name error.
 */
function handleUnifiedGatewayRequest(req: http.IncomingMessage, res: http.ServerResponse, bodyStr: string): void {
  if (!hasUnifiedKey(req.headers as Record<string, string | string[] | undefined>)) {
    anthropicError(
      res,
      401,
      'authentication_error',
      'Invalid or missing Jev AnityG-Mode unified key. Copy it from the Jev AnityG-Mode dashboard (Unified API Key panel) and set ANTHROPIC_AUTH_KEY.',
    );
    return;
  }
  let anth: AnthropicMessagesRequest;
  try {
    anth = JSON.parse(bodyStr || '{}') as AnthropicMessagesRequest;
  } catch {
    anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body.');
    return;
  }
  const requested = String(anth.model || '');
  const isStream = anth.stream === true;
  const converted = anthropicToGemini(anth);
  const geminiBody = converted as unknown as GeminiRequestBody;
  const customModels = getRoutableModels();
  const settings = loadRouterSettings();

  startRouting(res, requested || '(gateway)');
  const rctx = routingContexts.get(res);
  if (rctx) {
    rctx.responseMode = 'anthropic';
    rctx.anthropicModel = requested;
  }

  const matched = requested
    ? customModels.find(
        (m) =>
          m.externalModelName === requested ||
          toSlug(m) === requested ||
          toLegacySlug(m) === requested ||
          m.name === requested ||
          m.displayName === requested ||
          // Full-list assignment: IDs must match what the IDE-facing paths
          // compute, never a subset view of the model set.
          generateModelPlaceholderId(m) === requested,
      )
    : undefined;

  if (matched) {
    log.info(`[Gateway] ${requested} -> configured model ${matched.displayName}${isStream ? ' (stream)' : ''}`);
    const chain = settings.autoRouter ? rankFallbacks(matched, customModels, converted as unknown as AutoGeminiBody) : [];
    handleCustomModelRequest(res, matched, geminiBody, isStream, 0, chain);
    return;
  }

  // Unknown name (claude-sonnet-4-5 etc.) -> best model for this task.
  log.info(`[Gateway] ${requested || '(no model)'} -> Auto Smart Router (unknown name accepted)${isStream ? ' (stream)' : ''}`);
  if (!settings.autoRouter) {
    anthropicError(
      res,
      400,
      'invalid_request_error',
      `Model "${requested}" is not configured and Auto Rotation is OFF. Enable Auto Rotation in the dashboard or use a configured model name.`,
    );
    return;
  }
  const realModels = loadCustomModels().filter((m) => !isAutoModel(m) && !m.disabled);
  if (realModels.length === 0) {
    anthropicError(res, 400, 'invalid_request_error', 'No enabled models configured. Add one in the Jev AnityG-Mode dashboard first.');
    return;
  }
  planAutoRouteJev(realModels, converted as unknown as AutoGeminiBody)
    .then((plan) => {
      if (plan.chain.length === 0) {
        anthropicError(res, 400, 'invalid_request_error', 'No enabled model can serve this request.');
        return;
      }
      const [primary, ...fallbacks] = plan.chain;
      handleCustomModelRequest(res, primary, plan.body as unknown as GeminiRequestBody, isStream, 0, fallbacks);
    })
    .catch((e) => anthropicError(res, 500, 'api_error', 'Routing failed: ' + (e as Error).message));
}

/**
 * Routes a generation request through the best configured model + fallback chain.
 */
async function handleAutoModelRequest(
  res: http.ServerResponse,
  geminiBody: GeminiRequestBody,
  isStream: boolean,
): Promise<void> {
  // Past answers in the history carry the routing note - strip it so the
  // agent never sees it (it is display-only).
  stripRouteNotes(geminiBody);
  const settings = loadRouterSettings();
  // "Off Model" means OFF: disabled models are never routed to, even though
  // a stale IDE picker can still display (and select) them.
  const realModels = loadCustomModels().filter((m) => !isAutoModel(m) && !m.disabled);
  // Dashboard toggle OFF: Auto requests get a clear, actionable error.
  if (!settings.autoRouter) {
    log.warn('[Auto] Auto (Smart Router) is turned OFF - rejecting request');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message:
            'Auto Rotation / Smart Router is turned OFF. Open the proxy dashboard (http://127.0.0.1:<port>/dashboard) and press "Turn ON" to re-enable it.',
        },
      }),
    );
    return;
  }
  const allConfigured = loadCustomModels().filter((m) => !isAutoModel(m));
  if (allConfigured.length === 0) {
    log.error('[Auto] No custom models configured - Auto has nothing to route to');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message:
            'Auto (Smart Router) needs at least one custom model. Add one in Settings > Add Model first.',
        },
      }),
    );
    return;
  }
  if (realModels.length === 0) {
    log.warn('[Auto] Every configured model is disabled (Off Model) - rejecting with guidance');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message:
            'All your models are disabled (Off Model) in the Jev AnityG-Mode dashboard. Re-enable at least one model to route requests.',
        },
      }),
    );
    return;
  }

  const plan = settings.jevMode
    ? await planAutoRouteJev(realModels, geminiBody as unknown as AutoGeminiBody)
    : planAutoRoute(realModels, geminiBody as unknown as AutoGeminiBody);
  if (plan.chain.length === 0) {
    log.error('[Auto] No configured model can serve this request');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { message: 'Auto router: no configured model can serve this request.' } }),
    );
    return;
  }

  startRouting(res, 'Auto (Smart Router)');
  if (plan.reason.includes('JEV compaction') && lastJevStats()) {
    const s = lastJevStats()!;
    noteRoutingJev(res, { tokensBefore: s.tokensBefore, tokensAfter: s.tokensAfter, judge: s.judge });
  }

  const [primary, ...fallbacks] = plan.chain;
  log.info(
    `[Auto] task=${plan.task} ~${plan.tokens} tokens -> ${primary.displayName}` +
      (fallbacks.length > 0 ? ` (fallbacks: ${fallbacks.map((m) => m.displayName).join(', ')})` : '') +
      ` [${plan.reason}]`,
  );
  handleCustomModelRequest(res, primary, plan.body as unknown as GeminiRequestBody, isStream, 0, fallbacks);
}

/**
 * True when the IDE is asking for the virtual Auto model by any of its
 * identity strings. Needed on the routing path because the dashboard toggle
 * OFF removes Auto from getRoutableModels() (so the IDE picker hides it) -
 * without this check, an in-flight Auto request would fall through to the
 * transparent Google proxy instead of the actionable "turned OFF" error.
 */
function isAutoIdentity(name: string | undefined): boolean {
  if (!name) return false;
  const auto = buildAutoModel();
  return (
    name === toSlug(auto) ||
    name === toLegacySlug(auto) ||
    name === auto.name ||
    name === generateModelPlaceholderId(auto)
  );
}

// ─── Model Loading ────────────────────────────────────────────────────────

function loadCustomModels(): CustomModel[] {
  const filePath = getCustomModelsPath();

  if (!fs.existsSync(filePath)) {
    const defaultModels = {
      models: [
        {
          name: 'models/gpt-4o',
          displayName: 'GPT-4o (OpenAI via Proxy)',
          description: 'OpenAI GPT-4o model redirected through proxy',
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
          apiUrl: 'https://api.openai.com/v1/chat/completions',
          externalModelName: 'gpt-4o',
        },
        {
          name: 'models/claude-3-5-sonnet',
          displayName: 'Claude 3.5 Sonnet (Anthropic via Proxy)',
          description: 'Anthropic Claude 3.5 Sonnet model redirected through proxy',
          provider: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY',
          apiUrl: 'https://api.anthropic.com/v1/messages',
          externalModelName: 'claude-3-5-sonnet-latest',
        },
        {
          name: 'models/llama3',
          displayName: 'Llama 3 (Local Ollama)',
          description: 'Local Ollama Llama 3 model run on your machine',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1/chat/completions',
          externalModelName: 'llama3',
        },
      ],
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      (defaultModels.models as CustomModel[]).forEach((m) => {
        (m as unknown as Record<string, unknown>).encrypted = false;
      });
      const encrypted = cryptoStore.encryptModels(defaultModels.models);
      fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // non-POSIX (Windows) - ignore
      }
    } catch (e) {
      log.error('[Proxy] Failed to write default custom_models.json', e);
    }
    return cryptoStore.decryptModels(defaultModels.models as unknown as Parameters<typeof cryptoStore.decryptModels>[0]) as unknown as CustomModel[];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { models?: CustomModel[] };
    const models = parsed.models || [];

    // Auto-migration check
    const needsMigration = models.some(
      (m) =>
        !m.encrypted &&
        m.apiKey &&
        m.apiKey !== 'none' &&
        !m.apiKey.startsWith('enc:') &&
        !m.apiKey.startsWith('fallback:'),
    );
    if (needsMigration) {
      log.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
      cryptoStore.backupFile(filePath);
      const encryptedModels = cryptoStore.encryptModels(models as unknown as Parameters<typeof cryptoStore.encryptModels>[0]);
      try {
        fs.writeFileSync(filePath, JSON.stringify({ models: encryptedModels }, null, 2), { encoding: 'utf-8', mode: 0o600 });
        try {
          fs.chmodSync(filePath, 0o600);
        } catch {
          // non-POSIX (Windows) - ignore
        }
        log.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');
        return cryptoStore.decryptModels(encryptedModels) as unknown as CustomModel[];
      } catch (err) {
        log.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
      }
    }

    const decrypted = cryptoStore.decryptModels(models as unknown as Parameters<typeof cryptoStore.decryptModels>[0]) as unknown as CustomModel[];

    // Validate all models
    const validModels: CustomModel[] = [];
    for (let i = 0; i < decrypted.length; i++) {
      const validation = validateCustomModel(decrypted[i]) as { valid: boolean; error?: string };
      if (validation.valid) {
        validModels.push(decrypted[i]);
      } else {
        log.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
      }
    }
    if (validModels.length < decrypted.length) {
      log.info(
        `[Proxy] Loaded ${validModels.length}/${decrypted.length} valid models (${decrypted.length - validModels.length} skipped)`,
      );
    }

    return validModels;
  } catch (e) {
    log.error('[Proxy] Failed to parse custom_models.json', e);
    return [];
  }
}

// ─── Google Proxy ─────────────────────────────────────────────────────────

function proxyToGoogle(req: http.IncomingMessage, res: http.ServerResponse, reqBody: Buffer): void {
  const isCloudCodeUrl = req.url!.includes('v1internal') || req.url!.includes('daily-cloudcode');
  const targetUrl = isCloudCodeUrl
    ? 'https://daily-cloudcode-pa.googleapis.com'
    : 'https://generativelanguage.googleapis.com';
  const parsedUrl = new URL(req.url!, targetUrl);

  const headers: Record<string, string | string[] | undefined> = {
    ...(req.headers as Record<string, string | string[] | undefined>),
  };
  headers['host'] = isCloudCodeUrl ? 'daily-cloudcode-pa.googleapis.com' : 'generativelanguage.googleapis.com';
  delete headers['connection'];
  delete headers['keep-alive'];

  const isGeneration = req.url!.includes('generateContent') || req.url!.includes('streamGenerateContent');
  const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;

  if (shouldBufferAndModify) {
    delete headers['accept-encoding'];
  }

  const options: https.RequestOptions = {
    method: req.method,
    headers: headers as Record<string, string>,
  };

  const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
    // P0-5: Timeout for Google proxy requests (60s)
    proxyReq.setTimeout(60_000, () => {
      log.error('[Proxy] Google proxy request timed out after 60s');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Google API request timed out' } }));
      }
    });

    if (shouldBufferAndModify) {
      const responseChunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        const fullResBody = Buffer.concat(responseChunks);
        let text: string;
        const encoding = proxyRes.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            const zlib = require('zlib');
            text = zlib.gunzipSync(fullResBody).toString('utf-8');
          } catch (e) {
            log.error('[Proxy] gunzipSync failed:', e);
            text = fullResBody.toString('utf-8');
          }
        } else {
          text = fullResBody.toString('utf-8');
        }

        log.info(
          `[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length})`,
        );
        // P0-3: Response body content is NOT logged to disk. Only metadata.

        const proxyHost = req.headers.host || 'localhost';
        text = text.replace(/https:(\/\/)daily-cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
        text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
        text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);

        const modifiedHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
        delete modifiedHeaders['content-encoding'];
        // Hop-by-hop headers must go: we replace the body, so chunked framing from
        // Google can't coexist with the content-length we set below (Node's HTTP
        // parser rejects "Content-Length can't be present with Transfer-Encoding",
        // which broke the IDE's account setup / loadCodeAssist calls).
        delete modifiedHeaders['transfer-encoding'];
        delete modifiedHeaders['connection'];
        delete modifiedHeaders['keep-alive'];
        delete modifiedHeaders['proxy-authenticate'];
        delete modifiedHeaders['upgrade'];

        const modifiedBuffer = Buffer.from(text, 'utf-8');
        modifiedHeaders['content-length'] = String(modifiedBuffer.length);

        res.writeHead(proxyRes.statusCode || 200, modifiedHeaders as Record<string, string>);
        res.end(modifiedBuffer);
      });
    } else {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers as Record<string, string>);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    log.error('[Proxy] Google Forwarding Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
  });

  if (reqBody) {
    proxyReq.write(reqBody);
  }
  proxyReq.end();
}

// ─── File Data Resolver ────────────────────────────────────────────────────

async function resolveFileData(body: GeminiRequestBody, reqHeaders: Record<string, string | string[] | undefined>): Promise<void> {
  const contents = body.contents;
  if (!contents) return;
  const authHeader = (reqHeaders['authorization'] || reqHeaders['Authorization'] || '') as string;
  for (const item of contents) {
    if (!item.parts) continue;
    for (let i = 0; i < item.parts.length; i++) {
      const p = item.parts[i] as Record<string, unknown>;
      const fd = p.fileData as { mimeType?: string; fileUri?: string } | undefined;
      if (!fd?.fileUri) continue;
      try {
        const uri = fd.fileUri; let fileContent = '';
        if (uri.startsWith('file://')) {
          const fp = fileURLToPath(uri);
          if (fs.existsSync(fp)) fileContent = fs.readFileSync(fp, 'utf-8');
        } else if (authHeader && uri.startsWith('https://')) {
          fileContent = await downloadFileContent(uri, authHeader);
        }
        if (fileContent) {
          (item.parts[i] as Record<string, unknown>) = { text: '[File content]:\n\n' + fileContent };
        }
      } catch (e) { log.warn('[Proxy] File resolve failed:', (e as Error).message); }
    }
  }
}

async function downloadFileContent(url: string, authHeader: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'Authorization': authHeader },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// ─── Custom Model Request Handler ─────────────────────────────────────────

/**
 * Parses the Retry-After header from upstream responses (RFC 7231 §7.1.3).
 * Returns delay in milliseconds, or 0 if no valid header is present.
 */
function parseRetryAfter(headers: Record<string, string | string[] | undefined>): number {
  const val = headers['retry-after'];
  if (!val) return 0;

  const raw = Array.isArray(val) ? val[0] : val;
  if (!raw) return 0;

  // Try delta-seconds (e.g. "120")
  const seconds = parseInt(raw.trim(), 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
  const date = new Date(raw);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : 0;
  }

  return 0;
}

export interface AttemptRecord {
  model: string;
  reason: string;
}

/**
 * True when a translated Gemini response carries no usable content - no
 * candidates, no parts, or only blank text. The IDE shows "Agent execution
 * terminated" for such completions, so they rotate like any other failure
 * (Part 26's empty-stream rule, non-stream side).
 */
function emptyGeminiResponse(mapped: unknown): boolean {
  const cands = (mapped as { candidates?: { content?: { parts?: Record<string, unknown>[] }[] } } | null | undefined)
    ?.candidates;
  if (!Array.isArray(cands) || cands.length === 0) return true;
  const parts = cands[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return true;
  return !parts.some((p) => {
    if (!p || typeof p !== 'object') return false;
    const part = p as Record<string, unknown>;
    return (
      (typeof part.text === 'string' && part.text.trim().length > 0) ||
      'functionCall' in part ||
      'functionResponse' in part ||
      'inlineData' in part
    );
  });
}

export function handleCustomModelRequest(
  res: http.ServerResponse,
  model: CustomModel,
  geminiBody: GeminiRequestBody,
  isStream: boolean,
  retryCount = 0,
  fallbacks: CustomModel[] = [],
  attempts: AttemptRecord[] = [],
  jevAttempted = false,
): void {
  // P3-18: Configurable max retries per model (default 3, min 0, max 5)
  const MAX_RETRIES = Math.min(Math.max(model.maxRetries ?? 3, 0), 5);
  const REQUEST_TIMEOUT_MS = model.timeout || 120_000;
  const startMs = Date.now();

  /**
   * Routing Activity: one entry per request that reaches the client - which
   * model the IDE picked, every switch before the answer, and who answered.
   */
  const recordFrom = (ok: boolean, attemptList?: AttemptRecord[]): void => {
    const ctx = routingContexts.get(res);
    recordRouting({
      ts: Date.now(),
      // Prefer the explicit entry-point context; otherwise the first failure
      // recorded in the chain is the model the request originally dialed.
      requested: ctx?.requested || attempts[0]?.model || model.displayName,
      final: ok ? model.displayName : '(all failed)',
      ok,
      attempts: attemptList ?? [...attempts],
      isStream,
      durationMs: Date.now() - startMs,
      jev: ctx?.jev ?? null,
    });
  };

  // Unified Gateway mode: shape responses as Anthropic messages/SSE.
  const gwCtx = routingContexts.get(res);
  const gwMode = gwCtx?.responseMode === 'anthropic';
  const gwModel = gwCtx?.anthropicModel || model.displayName;
  const framer: AnthropicStreamFramer | null = gwMode && isStream ? new AnthropicStreamFramer(gwModel) : null;
  const endError = (status: number, type: string, message: string): void => {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      gwMode
        ? JSON.stringify({ type: 'error', error: { type, message } })
        : JSON.stringify({ error: { message } }),
    );
  };

  /**
   * In-IDE switch notice: the picker cannot change per request, so when the
   * router (or JEV recovery) picked a different model, prepend a short note
   * as the answer's first thinking part - visible in the IDE's Thinking
   * Process, without touching the answer text. Null when nothing switched
   * or the user turned the notice off.
   */
  let cachedNotice: string | null | undefined;
  const switchNotice = (): string | null => {
    if (cachedNotice !== undefined) return cachedNotice;
    cachedNotice = null;
    const rctx = routingContexts.get(res);
    if (rctx?.responseMode === 'anthropic') return null; // gateway answers stay pure
    // An Off Model reroute is always announced: without it the user disables a
    // model, keeps chatting on the stale picker entry, and concludes the
    // toggle did nothing because answers keep flowing.
    if (!loadRouterSettings().switchNotice && !rctx?.offModelPick) return null;
    if (attempts.length === 0 && (!rctx || rctx.requested === model.displayName)) return null;
    const requested = rctx?.requested || attempts[0]?.model || model.displayName;
    const bits = [
      rctx?.offModelPick
        ? `⇄ routed: ${requested} is Off Model → ${model.displayName}`
        : `⇄ routed: ${requested} → ${model.displayName}`,
    ];
    if (attempts.length > 0) bits.push(`${attempts.length} switch${attempts.length > 1 ? 'es' : ''}`);
    if (rctx?.jev && rctx.jev.tokensBefore > 0) {
      const pct = Math.max(0, Math.round((1 - rctx.jev.tokensAfter / rctx.jev.tokensBefore) * 100));
      bits.push(`JEV −${pct}%`);
    }
    cachedNotice = bits.join(' · ');
    return cachedNotice;
  };

  /**
   * Terminal-failure escape hatch: when this model is beyond retries, hand
   * the SAME request to the next model in the chain. Only possible before
   * any bytes are written to the IDE (Part 4: never concatenate partial output).
   * Models on an open circuit breaker are skipped (free-router cooldown rule)
   * unless every remaining model is open - a cooldown model still beats
   * giving up when it is all we have.
   */
  const fallbackToNext = (where: string, detail: string): boolean => {
    if (fallbacks.length === 0 || res.headersSent) return false;
    let rest = fallbacks;
    const skipped: string[] = [];
    while (rest.length > 0 && smartHealth.isOpen(healthKey(rest[0]))) {
      skipped.push(rest[0].displayName);
      rest = rest.slice(1);
    }
    if (rest.length === 0 && skipped.length > 0) {
      // All remaining candidates are on cooldown - dial them anyway.
      rest = fallbacks;
      skipped.length = 0;
    }
    if (skipped.length > 0) {
      log.warn(`[Router] Skipping cooldown models: ${skipped.join(', ')}`);
    }
    log.warn(`[Router] ${model.displayName} failed: ${detail} - switching to ${rest[0].displayName}`);
    const nextAttempts = [...attempts, { model: model.displayName, reason: detail }];
    handleCustomModelRequest(res, rest[0], geminiBody, isStream, 0, rest.slice(1), nextAttempts);
    return true;
  };

  /** Part 25: every model in the chain failed - report honestly, no secrets. */
  const allFailed = (lastStatus: number, lastBody: string): void => {
    const finalAttempts = [...attempts, { model: model.displayName, reason: `HTTP ${lastStatus}` }];
    recordFrom(false, finalAttempts);
    const list = finalAttempts.map((a, i) => `${i + 1}. ${a.model}: ${a.reason}`).join('\n');
    log.error(`[Router] All configured AI providers failed:\n${list}`);
    const message = `All configured AI providers failed.\n\nAttempted:\n${list}\n\nLast upstream response:\n${lastBody.substring(0, 500)}`;
    if (gwMode) {
      if (!res.headersSent) res.writeHead(lastStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
      return;
    }
    if (!res.headersSent) {
      res.writeHead(lastStatus, { 'Content-Type': 'application/json' });
    }
    res.end(
      JSON.stringify({
        error: {
          code: lastStatus,
          message,
        },
      }),
    );
  };

  /**
   * Context-overflow recovery: upstreams report "prompt is too long" as a
   * plain 400, which normally fails fast and terminates the IDE agent with
   * no model switch. Here it is fixable - JEV-compact the context and re-dial
   * the same model, or rotate to the next fallback (its window may fit
   * uncompressed). Returns true when the request was handed off; the caller
   * must return immediately and this closure ends the response in every path.
   */
  const recoverContextOverflow = (where: string, status: number, rawBody: string): boolean => {
    if (jevAttempted || res.headersSent || !isContextOverflow(rawBody)) return false;
    const giveUp = (): void => {
      if (fallbackToNext(where, 'prompt too long for context window')) return;
      if (attempts.length > 0 && !res.headersSent) {
        allFailed(status, rawBody);
        return;
      }
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(rawBody);
    };
    if (!loadRouterSettings().jevMode) {
      giveUp();
      return true;
    }
    const realModels = loadCustomModels().filter((m) => !isAutoModel(m) && !m.disabled);
    const window = detectModelCapabilities(model, true).maxTokens;
    if (realModels.length === 0 || window <= 0) {
      giveUp();
      return true;
    }
    log.warn(`[Router] ${model.displayName} rejected the prompt as too long - trying JEV compaction before rotating`);
    jevCompact(realModels, geminiBody as unknown as AutoGeminiBody, Math.floor(window * 0.9))
      .then((out) => {
        if (out && !res.headersSent) {
          noteRoutingJev(res, { tokensBefore: out.stats.tokensBefore, tokensAfter: out.stats.tokensAfter, judge: out.stats.judge });
          log.warn(
            `[Router] JEV compacted ~${out.stats.tokensBefore} -> ~${out.stats.tokensAfter} tokens - retrying ${model.displayName}`,
          );
          handleCustomModelRequest(
            res,
            model,
            out.body as unknown as GeminiRequestBody,
            isStream,
            0,
            fallbacks,
            attempts,
            true,
          );
          return;
        }
        log.warn(`[Router] JEV could not shrink the request enough - rotating to the next model`);
        giveUp();
      })
      .catch((e) => {
        log.warn('[Router] JEV compaction failed:', e);
        giveUp();
      });
    return true;
  };

  // ponytail: enc: keys need Electron safeStorage; standalone proxy can't decrypt -> fail loud, not a cryptic 401
  if (typeof model.apiKey === 'string' && model.apiKey.startsWith('DECRYPTION_FAILED')) {
    log.error(`[Proxy] API key for "${model.displayName}" is undecryptable in standalone mode (was encrypted by the old Electron app). Re-enter the plain key in custom_models.json with "encrypted": false.`);
    if (fallbackToNext('Undecryptable API key', model.displayName)) return;
    if (!res.headersSent) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `API key for "${model.displayName}" cannot be decrypted by the standalone proxy. Edit ~/.gemini/antigravity/custom_models.json: set "apiKey" to the plain key and "encrypted" to false, then retry.`,
          },
        }),
      );
    }
    return;
  }

  const provider =
    model.provider === 'custom' || model.provider === 'openrouter' || model.provider === 'free-router'
      ? 'openai'
      : model.provider;

  const payload = registry.translateRequest(provider, geminiBody, model.externalModelName);
  const headers = registry.getProviderHeaders(provider, model.apiKey);

  if (isStream && registry.supportsStreaming(provider)) {
    (payload as Record<string, unknown>).stream = true;
  }

  let finalUrlStr = model.apiUrl;
  // P3-15: Google AI Studio uses dynamic URL construction for streaming vs non-streaming
  // P3-16: Ollama uses URL normalization for default port and endpoint
  if (provider === 'google' || provider === 'ollama') {
    finalUrlStr = registry.getProviderUrl(finalUrlStr, model.externalModelName, isStream, provider);
  } else if (provider === 'openai' || model.provider === 'custom' || model.provider === 'openrouter' || model.provider === 'free-router') {
    finalUrlStr = registry.withChatCompletions(finalUrlStr);
  }
  const url = new URL(finalUrlStr);
  const client = url.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    headers: headers as Record<string, string>,
  };

  // P0-2: SSL bypass ONLY when user explicitly opts in via allowUnauthorized.
  // Custom providers no longer bypass SSL automatically.
  if (model.allowUnauthorized) {
    log.warn(
      `[Proxy] SSL verification DISABLED for ${model.name} (allowUnauthorized=true). Connection is vulnerable to MITM.`,
    );
    (options as Record<string, unknown>).rejectUnauthorized = false;
  }

  log.info(
    `[Proxy] Routing ${model.name} to ${model.provider} (${model.apiUrl}) (isStream: ${!!isStream})${retryCount > 0 ? ` (retry ${retryCount})` : ''}`,
  );

  const request = client.request(url, options, (apiRes) => {
    apiRes.on('error', (err) => {
      log.error(`[Proxy] Upstream stream error for ${model.name}:`, err.message);
      smartHealth.reportFailure(healthKey(model));
      // Nothing written yet -> this request can still rotate to the next model.
      if (!res.headersSent && fallbackToNext('Upstream stream error', err.message)) return;
      if (!res.headersSent) {
        endError(500, 'api_error', 'Upstream connection error: ' + err.message);
      } else {
        res.end();
      }
    });

    if (isStream) {
      // Check for API errors BEFORE writing streaming headers (Part 4)
      if (apiRes.statusCode! >= 400) {
        let errorBody = '';
        apiRes.on('data', (chunk: Buffer) => errorBody += chunk.toString());
        apiRes.on('end', () => {
          log.error(`[Proxy] Stream API error (${apiRes.statusCode}) for ${model.name}`);
          smartHealth.reportFailure(healthKey(model));
          // Part 3: hard-quota bodies skip the retry budget entirely.
          const verdict = shouldSwitchBody(apiRes.statusCode, errorBody);
          if (retryCount < MAX_RETRIES && verdict.retrySame) {
            const retryAfter = parseRetryAfter(apiRes.headers);
            const delay = retryAfter > 0 ? retryAfter : 1000 * (retryCount + 1);
            log.warn(`[Proxy] Stream error, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1, fallbacks, attempts, jevAttempted), delay);
            return;
          }
          // "Prompt too long" is a 400 the router CAN fix: compact, then rotate.
          if (recoverContextOverflow('Stream API error', apiRes.statusCode!, errorBody)) return;
          // Part 2: only switchable failures burn the chain; plain 400s fail fast.
          if (verdict.switch && fallbackToNext('Stream API error', `${apiRes.statusCode} ${verdict.reason}`)) return;
          // Part 25: end of a chain - report every attempt honestly.
          if (attempts.length > 0 && !res.headersSent) {
            allFailed(apiRes.statusCode!, errorBody);
            return;
          }
          recordFrom(false, [...attempts, { model: model.displayName, reason: `${apiRes.statusCode} ${verdict.reason}` }]);
          if (gwMode) {
            endError(apiRes.statusCode!, 'api_error', `Upstream error ${apiRes.statusCode}: ${verdict.reason}`);
            return;
          }
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(errorBody);
        });
        return;
      }

      // Part 26 (free-router routing rule 11): SSE headers and the first
      // mapped chunk are held back until the upstream actually produces
      // content, so a model that answers 200 and then dies empty can still be
      // replaced by the next model in the chain instead of shipping a broken
      // stream to the IDE.
      let beganStream = false;
      let sawContent = false;
      const beginStream = (): boolean => {
        if (beganStream) return true;
        if (res.headersSent) return false;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        beganStream = true;
        return true;
      };
      let noticeSent = false;
      const emitChunk = (mapped: Record<string, unknown>): void => {
        if (!beginStream()) return;
        // Gateway mode: the framer turns mapped Gemini chunks into Anthropic
        // SSE frames (message_start / content_block_* / message_delta).
        if (framer) {
          // translateStreamChunk yields a single candidate; the framer wants the wrapped shape.
          const frames = framer.feed({ candidates: [mapped as Parameters<AnthropicStreamFramer['feed']>[0]['candidates'] extends (infer C)[] | undefined ? C : never] });
          if (frames) res.write(frames);
          sawContent = true;
          return;
        }
        // First content out: lead with the routing note as plain answer text -
        // the only in-IDE surface the proxy controls that the chat ALWAYS
        // renders (the Thinking Process section may stay collapsed). Once only.
        if (!noticeSent) {
          noticeSent = true;
          const notice = switchNotice();
          if (notice) {
            const noteChunk = {
              response: {
                candidates: [{ content: { parts: [{ text: notice + '\n\n' }], role: 'model' }, index: 0 }],
              },
              traceId: '',
              metadata: {},
            };
            res.write(`data: ${JSON.stringify(noteChunk)}\n\n`);
          }
        }
        sawContent = true;
        const cloudCodeResponse = {
          response: { candidates: [mapped] },
          traceId: '',
          metadata: {},
        };
        res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
      };

      let buffer = '';
      apiRes.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.substring(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const mapped = registry.translateStreamChunk(provider, parsed, model.name);

              if (mapped) {
                emitChunk(mapped as Record<string, unknown>);
              }
            } catch (err) {
              // Partial/invalid JSON chunks are normal during streaming; debug-level only
              log.debug(`[Proxy] Stream chunk parse warning for ${model.name}:`, (err as Error).message);
            }
          }
        }
      });

      apiRes.on('end', () => {
        if (buffer.trim().startsWith('data: ')) {
          const dataStr = buffer.trim().substring(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(dataStr);
              const mapped = registry.translateStreamChunk(provider, parsed, model.name);
              if (mapped) {
                emitChunk(mapped as Record<string, unknown>);
              }
            } catch (e) {
              log.debug(`[Proxy] Stream buffer drain parse warning for ${model.name}:`, (e as Error).message);
            }
          }
        }

        // Part 26: a 200 stream that closed without producing content is a
        // switchable failure - try the next model while nothing was committed.
        if (!sawContent && !res.headersSent) {
          log.warn(`[Proxy] Empty stream (no content) from ${model.name}`);
          smartHealth.reportFailure(healthKey(model));
          if (fallbackToNext('Empty stream', 'upstream closed without content')) return;
          beginStream(); // no fallback left: answer with a valid empty completion
          recordFrom(false, [...attempts, { model: model.displayName, reason: 'upstream closed without content' }]);
          if (framer) {
            res.write(
              `event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: 'api_error', message: 'Upstream returned no content' },
              })}\n\n`,
            );
            res.write(framer.finish());
            res.end();
            return;
          }
        } else if (sawContent) {
          recordFrom(true);
          if (framer) {
            res.write(framer.finish());
            res.end();
            return;
          }
        }
        if (framer) {
          // partial stream that died after headers: close the message properly
          res.write(framer.finish());
          res.end();
          return;
        }

        const finalChunk = {
          response: {
            candidates: [
              {
                content: { parts: [], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          },
          traceId: '',
          metadata: {},
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.end();
      });
    } else {
      let body = '';
      apiRes.on('data', (chunk: Buffer) => (body += chunk));
      apiRes.on('end', () => {
        // Retry on 5xx with exponential backoff (Part 3: quota-aware)
        if (apiRes.statusCode! >= 500 && apiRes.statusCode! < 600 && retryCount < MAX_RETRIES) {
          if (shouldSwitchBody(apiRes.statusCode, body).retrySame) {
            const retryAfter = parseRetryAfter(apiRes.headers);
            const delay = retryAfter > 0 ? retryAfter : 1000 * Math.pow(2, retryCount);
            log.warn(
              `[Proxy] Server error ${apiRes.statusCode} for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`,
            );
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1, fallbacks, attempts, jevAttempted), delay);
            return;
          }
        }

        // Retry on 429 with Retry-After header support + exponential backoff (Part 3: quota-aware)
        if (apiRes.statusCode === 429 && retryCount < MAX_RETRIES) {
          if (shouldSwitchBody(apiRes.statusCode, body).retrySame) {
            const retryAfter = parseRetryAfter(apiRes.headers);
            const delay = retryAfter > 0 ? retryAfter : 2000 * Math.pow(2, retryCount);
            log.warn(
              `[Proxy] Rate limited (429) for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`,
            );
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1, fallbacks, attempts, jevAttempted), delay);
            return;
          }
        }

        if (apiRes.statusCode! >= 400) {
          // P0-3: Only log status code and model name, NOT response body content
          log.error(`[Proxy] API error (${apiRes.statusCode}) for ${model.name}`);
          smartHealth.reportFailure(healthKey(model));
          const verdict = shouldSwitchBody(apiRes.statusCode, body);
          // "Prompt too long" is a 400 the router CAN fix: compact, then rotate.
          if (recoverContextOverflow('API error', apiRes.statusCode!, body)) return;
          // Part 2: switchable failures rotate the chain; client errors fail fast.
          if (verdict.switch && fallbackToNext('API error', `${apiRes.statusCode} ${verdict.reason}`)) return;
          // Part 25: end of a chain - report every attempt honestly.
          if (attempts.length > 0 && !res.headersSent) {
            allFailed(apiRes.statusCode!, body);
            return;
          }
          recordFrom(false, [...attempts, { model: model.displayName, reason: `${apiRes.statusCode} ${verdict.reason}` }]);
          if (gwMode) {
            endError(apiRes.statusCode!, 'api_error', `Upstream error ${apiRes.statusCode}: ${verdict.reason}`);
            return;
          }
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(body);
          return;
        }

        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;

          const reasoning =
            (parsed as { choices?: { message?: { reasoning_content?: string; reasoning?: string } }[] }).choices?.[0]
              ?.message?.reasoning_content ||
            (parsed as { choices?: { message?: { reasoning_content?: string; reasoning?: string } }[] }).choices?.[0]
              ?.message?.reasoning;
          if (reasoning) {
            modelReasoningContent.set(model.name, reasoning);
            touchStateTimestamp(stateTimestamps.reasoning, model.name);
          }

          const providerForResponse =
            model.provider === 'custom' || model.provider === 'openrouter' || model.provider === 'free-router'
              ? 'openai'
              : model.provider;
          const mapped = registry.translateResponse(providerForResponse, parsed, model.name);

          // A 200 that maps to no content is a dead completion ("Worked for 1s"
          // then "Agent execution terminated" in the IDE). Rotate while nothing
          // was committed; same-model retry is the last resort, not the default.
          if (emptyGeminiResponse(mapped)) {
            log.warn(`[Proxy] Empty completion (no content) from ${model.name}`);
            smartHealth.reportFailure(healthKey(model));
            if (fallbackToNext('Empty response', 'upstream returned no content')) return;
            if (retryCount < MAX_RETRIES) {
              const delay = 1000 * (retryCount + 1);
              log.warn(`[Proxy] Empty completion from ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`);
              setTimeout(
                () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1, fallbacks, attempts, jevAttempted),
                delay,
              );
              return;
            }
            // Nothing left: ship the valid-shaped empty response as before.
          }

          // In-IDE switch notice: first line of the answer text.
          const notice = switchNotice();
          if (notice) {
            const cands = (mapped as { candidates?: { content?: { parts?: unknown[] } }[] } | null | undefined)?.candidates;
            const parts = cands?.[0]?.content?.parts;
            if (Array.isArray(parts)) parts.unshift({ text: notice + '\n\n' });
          }

          if (gwMode) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify(geminiToAnthropicResponse(mapped as Parameters<typeof geminiToAnthropicResponse>[0], gwModel)),
            );
            smartHealth.reportSuccess(healthKey(model), Date.now() - startMs);
            recordFrom(true);
            log.info(`[Router] ${model.displayName} succeeded`);
            return;
          }

          const cloudCodeResponse = {
            response: mapped,
            traceId: '',
            metadata: {},
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cloudCodeResponse));
          smartHealth.reportSuccess(healthKey(model), Date.now() - startMs);
          recordFrom(true);
          log.info(`[Router] ${model.displayName} succeeded`);
        } catch (e) {
          log.error('[Proxy] Failed to map response:', e);

          if (retryCount < MAX_RETRIES) {
            log.warn(`[Proxy] Parse error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(
              () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1, fallbacks, attempts, jevAttempted),
              1000 * (retryCount + 1),
            );
            return;
          }

          // An unmappable 200 is this model's fault, not the client's - the
          // next model in the chain gets a chance before giving up.
          if (fallbackToNext('Unmappable response', (e as Error).message)) return;
          if (attempts.length > 0 && !res.headersSent) {
            allFailed(502, `Unmappable response: ${(e as Error).message}`);
            return;
          }
          endError(500, 'api_error', 'Failed to translate model response');
        }
      });
    }
  });

  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    log.error(`[Proxy] Request timeout (${REQUEST_TIMEOUT_MS}ms) for ${model.name}`);
    request.destroy();
    smartHealth.reportFailure(healthKey(model));

    if (retryCount < MAX_RETRIES) {
      log.warn(`[Proxy] Timeout for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      setTimeout(
        () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1, fallbacks, attempts, jevAttempted),
        1000 * (retryCount + 1),
      );
      return;
    }

    if (fallbackToNext('Timeout', `${REQUEST_TIMEOUT_MS}ms`)) return;
    // Part 25: end of a chain - report every attempt honestly.
    if (attempts.length > 0 && !res.headersSent) {
      allFailed(504, `Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s`);
      return;
    }
    recordFrom(false, [...attempts, { model: model.displayName, reason: `timeout after ${REQUEST_TIMEOUT_MS / 1000}s` }]);
    if (gwMode) {
      endError(504, 'api_error', `Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s`);
      return;
    }
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s` } }));
    }
  });

  request.on('error', (err) => {
    log.error('[Proxy] Custom Model Request Error:', err);
    smartHealth.reportFailure(healthKey(model));

    if (retryCount < MAX_RETRIES && shouldSwitch(undefined, err as Error).retrySame) {
      log.warn(`[Proxy] Network error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      setTimeout(
        () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1, fallbacks, attempts, jevAttempted),
        1000 * (retryCount + 1),
      );
      return;
    }

    if (fallbackToNext('Network error', err.message)) return;
    // Part 25: end of a chain - report every attempt honestly.
    if (attempts.length > 0 && !res.headersSent) {
      allFailed(502, `Network error: ${err.message}`);
      return;
    }
    recordFrom(false, [...attempts, { model: model.displayName, reason: err.message }]);
    if (gwMode) {
      endError(502, 'api_error', 'Network error: ' + err.message);
      return;
    }

    if (isStream) {
      if (!res.headersSent) {
        const errResponse = {
          response: {
            candidates: [
              {
                content: { parts: [{ text: 'Network error: ' + err.message }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          },
          traceId: '',
          metadata: {},
        };
        res.write('data: ' + JSON.stringify(errResponse) + '\n\n');
      }
      res.end();
    } else {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
      }
    }
  });

  request.write(JSON.stringify(payload));
  request.end();
}

// ─── Protobuf Utilities ────────────────────────────────────────────────────

interface ProtoField {
  tag: number;        // full tag (field_number << 3 | wire_type)
  wireType: number;
  fieldNum: number;
  value: number | Buffer | ProtoField[];
  start: number;
  end: number;
}

function readVarint(buf: Buffer, offset: number): { value: number; bytes: number } {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  while (offset + bytes < buf.length) {
    const byte = buf[offset + bytes];
    result |= (byte & 0x7f) << shift;
    bytes++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, bytes };
}

function encodeVarint(value: number): Buffer {
  const parts: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    parts.push(b);
  } while (v !== 0);
  return Buffer.from(parts);
}

function parseProto(buf: Buffer, offset: number, end: number): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = offset;
  while (pos < end) {
    const start = pos;
    const tagVarint = readVarint(buf, pos);
    const tag = tagVarint.value;
    const wireType = tag & 0x07;
    const fieldNum = tag >>> 3;
    pos += tagVarint.bytes;

    if (wireType === 0) {
      const v = readVarint(buf, pos);
      fields.push({ tag, wireType, fieldNum, value: v.value, start, end: pos + v.bytes });
      pos += v.bytes;
    } else if (wireType === 2) {
      const lenVarint = readVarint(buf, pos);
      pos += lenVarint.bytes;
      const len = lenVarint.value;
      const children = parseProto(buf, pos, pos + len);
      const hasChildren = children.length > 0;
      fields.push({ tag, wireType, fieldNum, value: hasChildren ? children : buf.subarray(pos, pos + len), start, end: pos + len });
      pos += len;
    } else if (wireType === 1) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 8), start, end: pos + 8 });
      pos += 8;
    } else if (wireType === 5) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 4), start, end: pos + 4 });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function encodeProtoBuf(fields: { tag: number; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const tagBuf = encodeVarint(field.tag);
    const data = field.value;
    const lenBuf = encodeVarint(data.length);
    parts.push(tagBuf, lenBuf, data);
  }
  return Buffer.concat(parts);
}

function findModelEntryFieldTag(fields: ProtoField[]): number | null {
  const tagCounts = new Map<number, number>();
  for (const f of fields) {
    if (f.wireType === 2) {
      tagCounts.set(f.tag, (tagCounts.get(f.tag) || 0) + 1);
    }
  }
  let bestTag: number | null = null;
  let bestCount = 0;
  for (const [tag, count] of tagCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestTag = tag;
    }
  }
  if (bestTag !== null && bestCount >= 2) {
    // Verify it has nested messages
    const sample = fields.find((f) => f.tag === bestTag && Array.isArray(f.value));
    if (sample) return bestTag;
  }
  return bestTag;
}

function extractFieldMapping(entry: ProtoField[]): Map<number, 'string' | 'varint' | 'bytes'> {
  const mapping = new Map<number, 'string' | 'varint' | 'bytes'>();
  for (const f of entry) {
    if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
      mapping.set(f.fieldNum, 'string');
    } else if (f.wireType === 0) {
      mapping.set(f.fieldNum, 'varint');
    } else if (f.wireType === 2 && Array.isArray(f.value)) {
      mapping.set(f.fieldNum, 'bytes');
    }
  }
  return mapping;
}

function encodeModelEntryForGetModels(
  name: string,
  displayName: string,
  mapping: Map<number, 'string' | 'varint' | 'bytes'>,
): Buffer {
  const fields: { tag: number; value: Buffer }[] = [];
  for (const [fieldNum, protoType] of mapping) {
    if (protoType === 'string') {
      const tag = (fieldNum << 3) | 2;
      if (fieldNum === 1) {
        fields.push({ tag, value: Buffer.from(name, 'utf-8') });
      } else if (fieldNum === 2) {
        fields.push({ tag, value: Buffer.from(displayName, 'utf-8') });
      } else {
        fields.push({ tag, value: Buffer.alloc(0) });
      }
    } else if (protoType === 'varint') {
      const tag = (fieldNum << 3) | 0;
      fields.push({ tag, value: encodeVarint(0) });
    } else {
      const tag = (fieldNum << 3) | 2;
      fields.push({ tag, value: Buffer.alloc(0) });
    }
  }
  return encodeProtoBuf(fields);
}

// ─── GetAvailableModels Proxy Handler ───────────────────────────────────────

function handleGetAvailableModelsProxy(
  res: http.ServerResponse,
  reqBody: Buffer,
  lsUrl: string,
): void {
  const lsParsed = new URL(lsUrl);
  const client = lsParsed.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    hostname: lsParsed.hostname,
    port: lsParsed.port || (lsParsed.protocol === 'https:' ? '443' : '80'),
    path: lsParsed.pathname + lsParsed.search,
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      'Accept': 'application/grpc-web+proto',
      'Content-Length': String(reqBody.length),
    },
    rejectUnauthorized: false,
  };

  const lsReq = client.request(options, (lsRes) => {
    const chunks: Buffer[] = [];
    lsRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    lsRes.on('end', () => {
      const responseBuf = Buffer.concat(chunks);
      const customModels = getRoutableModels();
      let modifiedBuf = responseBuf;

      if (customModels.length > 0 && responseBuf.length > 6) {
        try {
          const flags = responseBuf[0];
          const msgLen = responseBuf.readUInt32BE(1);
          if (5 + msgLen <= responseBuf.length) {
            const msgBody = responseBuf.subarray(5, 5 + msgLen);
            const parsed = parseProto(msgBody, 0, msgBody.length);
            const modelTag = findModelEntryFieldTag(parsed);

            if (modelTag !== null) {
              const sampleEntry = parsed.find(
                (f) => f.tag === modelTag && Array.isArray(f.value),
              );
              if (sampleEntry && Array.isArray(sampleEntry.value)) {
                const fieldMapping = extractFieldMapping(sampleEntry.value);
                const newParts: Buffer[] = [msgBody];

                for (const m of customModels) {
                  const placeholderId = generateModelPlaceholderId(m);
                  const entry = encodeModelEntryForGetModels(
                    'models/' + placeholderId,
                    m.displayName,
                    fieldMapping,
                  );
                  const tagBuf = encodeVarint(modelTag);
                  const lenBuf = encodeVarint(entry.length);
                  newParts.push(tagBuf, lenBuf, entry);
                  log.info(
                    `[Proxy] Injected into GetAvailableModels: ${m.displayName} => ${placeholderId}`,
                  );
                }

                const newMsgBody = Buffer.concat(newParts);
                const newHeader = Buffer.alloc(5);
                newHeader[0] = flags;
                newHeader.writeUInt32BE(newMsgBody.length, 1);
                modifiedBuf = Buffer.concat([newHeader, newMsgBody]);
              }
            }
          }
        } catch (err) {
          log.error('[Proxy] Failed to inject models into GetAvailableModels:', err);
        }
      }

      res.writeHead(lsRes.statusCode || 200, {
        'Content-Type': 'application/grpc-web+proto',
        'Content-Length': String(modifiedBuf.length),
      });
      res.end(modifiedBuf);
    });

    lsRes.on('error', (err) => {
      log.error('[Proxy] LS error for GetAvailableModels:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
    });
  });

  lsReq.setTimeout(30_000, () => {
    log.error('[Proxy] GetAvailableModels forward timed out');
    lsReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end();
    }
  });

  lsReq.on('error', (err) => {
    log.error('[Proxy] GetAvailableModels forward error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });

  lsReq.write(reqBody);
  lsReq.end();
}

// ─── Model Dashboard (browser UI at /dashboard) ───────────────────────────

/** Persists models back to custom_models.json (re-encrypting keys). */
let modelsVersion = 1;

/** Bumped on every model add/delete/toggle so clients can detect list changes. */
function getModelsVersion(): number {
  return modelsVersion;
}

function saveCustomModels(models: CustomModel[]): boolean {
  try {
    const filePath = getCustomModelsPath();
    const encrypted = cryptoStore.encryptModels(models as unknown as Parameters<typeof cryptoStore.encryptModels>[0]);
    fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
    modelsVersion += 1;
    return true;
  } catch (e) {
    log.error('[Dashboard] Failed to write custom_models.json', e);
    return false;
  }
}

/**
 * Serves the dashboard page and its JSON API:
 *   GET  /dashboard          - the management UI
 *   GET  /api/models         - list models (API keys masked)
 *   POST /api/models         - add a model   {provider,id,displayName,apiKey,apiUrl}
 *   POST /api/models/delete  - remove by name {name}
 *   POST /api/models/test    - ping a saved model {name} or an unsaved form
 * Returns true when the request was a dashboard route (fully handled).
 */
function handleDashboardRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
): boolean {
  const url = req.url!.split('?')[0];
  if (
    url !== '/dashboard' &&
    url !== '/favicon.ico' &&
    url !== '/api/models' &&
    url !== '/api/models/delete' &&
    url !== '/api/models/test' &&
    url !== '/api/models/key' &&
    url !== '/api/models/toggle' &&
    url !== '/api/router/status' &&
    url !== '/api/router/toggle' &&
    url !== '/api/routing/recent'
  ) {
    return false;
  }

  const json = (code: number, payload: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  try {
    if (req.method === 'GET' && url === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboard.buildDashboardHtml());
      return true;
    }

    // ponytail: inline SVG favicon in the page, but browsers still probe
    // /favicon.ico — 204 here keeps it from falling through to Google.
    if (url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (req.method === 'GET' && url === '/api/models') {
      const models = loadCustomModels().filter((m) => !isAutoModel(m));
      json(200, { models: models.map(dashboard.sanitizeModel) });
      return true;
    }

    let parsed: Record<string, unknown> = {};
    if (req.method === 'POST' && body) {
      parsed = JSON.parse(body) as Record<string, unknown>;
    }

    // Dashboard toggles: Auto Rotation / Smart Router + JEV Mode.
    if (req.method === 'GET' && url === '/api/router/status') {
      const s = loadRouterSettings();
      json(200, { autoRouter: s.autoRouter, jevMode: s.jevMode, switchNotice: s.switchNotice, jev: lastJevStats() });
      return true;
    }
    if (req.method === 'POST' && url === '/api/router/toggle') {
      const cur = loadRouterSettings();
      // Absent fields keep their current value, so the dashboard toggles
      // never clobber each other.
      const enabled = parsed.enabled === undefined ? cur.autoRouter : parsed.enabled !== false;
      const jevMode = parsed.jevMode === undefined ? cur.jevMode : parsed.jevMode !== false;
      const switchNotice = parsed.switchNotice === undefined ? cur.switchNotice : parsed.switchNotice !== false;
      if (!saveRouterSettings({ autoRouter: enabled, jevMode, switchNotice })) {
        json(500, { error: 'Could not write router_settings.json (see proxy log).' });
        return true;
      }
      log.info(`[Router] Auto Rotation turned ${enabled ? 'ON' : 'OFF'}, JEV Mode turned ${jevMode ? 'ON' : 'OFF'}, switch notice ${switchNotice ? 'ON' : 'OFF'} via dashboard`);
      json(200, { autoRouter: enabled, jevMode, switchNotice });
      return true;
    }

    // Routing Activity: what the router actually did per recent request.
    if (req.method === 'GET' && url === '/api/routing/recent') {
      json(200, { events: recentRouting(20), modelsVersion: getModelsVersion() });
      return true;
    }

    if (req.method === 'POST' && url === '/api/models') {
      const { model, error } = dashboard.normalizeModelInput(parsed);
      if (error || !model) {
        json(400, { error: error || 'Invalid input' });
        return true;
      }
      const models = loadCustomModels().filter((m) => !isAutoModel(m));
      // ponytail: same model ID with a DIFFERENT API URL is a separate entry;
      // only reject when both the ID and the API URL already exist together.
      const existing = models.find((m) => m.name === model.name);
      if (existing) {
        if (existing.apiUrl === model.apiUrl) {
          json(409, {
            error:
              `A model with ID "${model.externalModelName}" already exists with this API URL. ` +
              'To use a different endpoint, change the API URL field, or press "Off Model" to hide the existing one, or Delete it first.',
          });
          return true;
        }
        // Same ID but different API URL: keep both by namespacing the saved name.
        let suffix = 2;
        while (models.some((m) => m.name === `${model.name}-${suffix}`)) suffix++;
        model.name = `${model.name}-${suffix}`;
        log.info(`[Dashboard] Same model ID with different API URL - saving as "${model.name}"`);
      }
      const written = saveCustomModels([...models, model]);
      if (!written) {
        json(500, { error: 'Could not write custom_models.json (see proxy log).' });
        return true;
      }
      log.info(`[Dashboard] Added model "${model.displayName}" (${model.provider}, ${model.apiUrl})`);
      json(200, { saved: model.displayName });
      return true;
    }

    if (req.method === 'POST' && url === '/api/models/toggle') {
      // "Off Model" switch: keep the model but hide it from the IDE picker.
      const name = String(parsed.name || '');
      const disabled = parsed.disabled === true;
      const models = loadCustomModels().filter((m) => !isAutoModel(m));
      const target = models.find((m) => m.name === name);
      if (!target) {
        json(404, { error: `No model named "${name}".` });
        return true;
      }
      target.disabled = disabled;
      const written = saveCustomModels(models);
      if (!written) {
        json(500, { error: 'Could not write custom_models.json (see proxy log).' });
        return true;
      }
      log.info(`[Dashboard] Model "${name}" turned ${disabled ? 'OFF (hidden from IDE picker)' : 'ON (visible in IDE picker)'}`);
      json(200, { name, disabled });
      return true;
    }

    if (req.method === 'POST' && url === '/api/models/delete') {
      const name = String(parsed.name || '');
      const models = loadCustomModels().filter((m) => !isAutoModel(m));
      const remaining = models.filter((m) => m.name !== name);
      if (remaining.length === models.length) {
        json(404, { error: `No model named "${name}".` });
        return true;
      }
      const written = saveCustomModels(remaining);
      if (!written) {
        json(500, { error: 'Could not write custom_models.json (see proxy log).' });
        return true;
      }
      log.info(`[Dashboard] Deleted model "${name}"`);
      json(200, { deleted: name });
      return true;
    }

    if (req.method === 'POST' && url === '/api/models/key') {
      const name = String(parsed.name || '');
      const saved = name ? loadCustomModels().find((m) => m.name === name) : undefined;
      if (!saved) {
        json(404, { error: `No model named "${name}".` });
        return true;
      }
      json(200, { apiKey: saved.apiKey || '' });
      return true;
    }

    if (req.method === 'POST' && url === '/api/models/test') {
      // Saved model (by name) or an unsaved dashboard form payload.
      const name = typeof parsed.name === 'string' ? parsed.name : '';
      const saved = name ? loadCustomModels().find((m) => m.name === name) : undefined;
      if (name && !saved) {
        json(404, { error: `No model named "${name}".` });
        return true;
      }
      if (saved) {
        dashboard
          .testModelConnection({
            provider: saved.provider,
            apiKey: saved.apiKey,
            apiUrl: saved.apiUrl,
            externalModelName: saved.externalModelName,
          })
          .then((r) => json(200, r));
        return true;
      }
      const { model, error } = dashboard.normalizeModelInput(parsed);
      if (error || !model) {
        json(400, { error: error || 'Invalid input' });
        return true;
      }
      dashboard
        .testModelConnection({
          provider: model.provider,
          apiKey: model.apiKey,
          apiUrl: model.apiUrl,
          externalModelName: model.externalModelName,
        })
        .then((r) => json(200, r));
      return true;
    }

    json(405, { error: 'Method not allowed' });
    return true;
  } catch (e) {
    log.error('[Dashboard] route failed:', e);
    json(500, { error: 'Dashboard error: ' + (e as Error).message });
    return true;
  }
}

// ─── Main Request Handler ─────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  req.url = req.url!.replace(/^.*\/dummy_path_padding/, '');
  // Strip binary patch padding (from LS hostname replacement)
  req.url = req.url!.replace(/\/v1internal\/x{7}/, '');

  // Health check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    const memUsage = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        port: proxyPort,
        memory: {
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        state: {
          activeStreamContexts: activeStreamContexts.size,
          modelToolCallIds: modelToolCallIds.size,
          translatedToolCalls: translatedToolCalls.size,
          modelReasoningContent: modelReasoningContent.size,
        },
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  // P0-4: Enforce maximum request body size to prevent memory exhaustion DoS
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
  let bodyLength = 0;
  let bodyRejected = false;

  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk) => {
    bodyLength += chunk.length;
    if (bodyLength > MAX_BODY_SIZE) {
      if (!bodyRejected) {
        bodyRejected = true;
        log.warn(`[Proxy] Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit (${req.method} ${req.url})`);
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: `Request body too large. Maximum: ${MAX_BODY_SIZE / 1024 / 1024}MB` } }),
          );
        }
      }
      return;
    }
    bodyChunks.push(chunk);
  });
  req.on('end', () => {
    if (bodyRejected) return;

    const fullBody = Buffer.concat(bodyChunks);
    const bodyStr = fullBody.toString('utf-8');

    log.info(`[Proxy] Request: ${req.method} ${req.url}`);

    // 0. Dashboard UI + model management API (must run before the /models
    //    list interception below, which also matches /api/models).
    if (handleDashboardRoute(req, res, bodyStr)) return;

    // 0b. Unified Gateway: Anthropic-compatible API for Claude Code & any
    //     Anthropic-only tool. Must run before the /models interception,
    //     which would otherwise swallow GET /v1/models.
    if (req.method === 'GET' && (req.url === '/v1' || req.url === '/v1/')) {
      // /v1 is the tools' API base - humans landing here want the dashboard.
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/messages' || req.url!.startsWith('/v1/messages?'))) {
      handleUnifiedGatewayRequest(req, res, bodyStr);
      return;
    }
    if (req.method === 'POST' && req.url!.startsWith('/v1/messages/count_tokens')) {
      if (!hasUnifiedKey(req.headers as Record<string, string | string[] | undefined>)) {
        anthropicError(res, 401, 'authentication_error', 'Invalid or missing Jev AnityG-Mode unified key.');
        return;
      }
      let parsedBody: unknown = {};
      try {
        parsedBody = JSON.parse(bodyStr || '{}');
      } catch {
        anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: estimateRequestTokens(parsedBody) }));
      return;
    }
    if (req.method === 'GET' && (req.url === '/v1/models' || req.url!.startsWith('/v1/models?'))) {
      if (!hasUnifiedKey(req.headers as Record<string, string | string[] | undefined>)) {
        anthropicError(res, 401, 'authentication_error', 'Invalid or missing Jev AnityG-Mode unified key.');
        return;
      }
      const list = getRoutableModels().filter((m) => !isAutoModel(m));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: list.map((m) => ({ id: m.externalModelName || m.name, object: 'model', display_name: m.displayName })),
          object: 'list',
          has_more: false,
        }),
      );
      return;
    }
    if (req.method === 'GET' && (req.url === '/v1/gateway/key' || req.url === '/api/gateway/key')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: getUnifiedKey() }));
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/gateway/regenerate' || req.url === '/api/gateway/regenerate')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: resetUnifiedKey() }));
      return;
    }

    // 0. Intercept GetAvailableModels (redirected from Electron webRequest)
    if (req.url!.startsWith('/GetAvailableModels')) {
      const gavParsed = new URL(req.url!, 'http://127.0.0.1');
      const lsUrl = gavParsed.searchParams.get('ls');
      if (lsUrl) {
        handleGetAvailableModelsProxy(res, fullBody, lsUrl);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ls parameter' }));
      return;
    }

    // 1. Intercept /v1internal:fetchAvailableModels
    if (req.url!.includes('/v1internal:fetchAvailableModels')) {
      log.info('[Proxy] Intercepting fetchAvailableModels request');

      const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const fwdHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      fwdHeaders['host'] = 'daily-cloudcode-pa.googleapis.com';
      delete fwdHeaders['connection'];
      delete fwdHeaders['keep-alive'];
      delete fwdHeaders['accept-encoding'];

      const fwdOptions: https.RequestOptions = {
        method: req.method,
        headers: fwdHeaders as Record<string, string>,
      };

      const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {
        // P0-5: Timeout for fetchAvailableModels forward request (30s)
        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] fetchAvailableModels forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = getRoutableModels();
            const mappedCustom = fallbackModelsMap(customModels);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            log.info(
              `[Proxy] fetchAvailableModels response status: ${googleRes.statusCode}, body length: ${googleBody.length}`,
            );

            const googleJson = JSON.parse(googleBody) as Record<string, unknown>;
            const customModels = getRoutableModels();

            log.info(`[Proxy] Loaded custom models count: ${customModels.length}`);

            const mergeModels = (target: unknown): unknown => {
              if (Array.isArray(target)) {
                const mapped = customModels.map((m) => {
                  const cap = capFor(m, customModels);
                  return {
                    name: 'models/' + generateModelPlaceholderId(m),
                    version: '1.0',
                    displayName: m.displayName,
                    description: m.description,
                    inputTokenLimit: cap.maxTokens,
                    outputTokenLimit: cap.maxOutputTokens,
                    supportedGenerationMethods: ['generateContent', 'countTokens'],
                    temperature: cap.isThinking ? undefined : 0.7,
                    topP: cap.isThinking ? undefined : 0.9,
                    topK: cap.isThinking ? undefined : 40,
                  };
                });
                return [...mapped, ...target];
              } else if (target && typeof target === 'object') {
                const result = { ...(target as Record<string, unknown>) };
                customModels.forEach((m) => {
                  const slug = toSlug(m);
                  const cap = capFor(m, customModels);
                  const entry: Record<string, unknown> = {
                    displayName: m.displayName,
                    supportsImages: cap.supportsImages,
                    supportsThinking: cap.isThinking,
                    recommended: true,
                    maxTokens: cap.maxTokens,
                    maxOutputTokens: cap.maxOutputTokens,
                    tokenizerType: 'LLAMA_WITH_SPECIAL',
                    model: generateModelPlaceholderId(m),
                    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                    modelProvider: 'MODEL_PROVIDER_GOOGLE',
                  };
                  if (cap.supportsImages) {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'image/png': true,
                      'image/jpeg': true,
                      'image/webp': true,
                      'image/gif': true,
                      'image/heic': true,
                      'image/heif': true,
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  } else {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  }
                  (result as Record<string, unknown>)[slug] = entry;
                  m._slug = slug;
                  log.info(
                    `[Proxy] Custom model "${m.displayName}" => slug: ${slug} => model: ${generateModelPlaceholderId(m)} => thinking: ${cap.isThinking} => images: ${cap.supportsImages}`,
                  );
                });
                return result;
              }
              return target;
            };

            let merged = false;
            if (googleJson.models) {
              googleJson.models = mergeModels(googleJson.models);
              merged = true;
            }
            if (googleJson.availableModels) {
              googleJson.availableModels = mergeModels(googleJson.availableModels);
              merged = true;
            }
            if (googleJson.available_models) {
              googleJson.available_models = mergeModels(googleJson.available_models);
              merged = true;
            }

            if (!merged) {
              const modelsMap: Record<string, unknown> = {};
              customModels.forEach((m) => {
                const slug = toSlug(m);
                modelsMap[slug] = {
                  displayName: m.displayName,
                  recommended: true,
                  maxTokens: 1048576,
                  maxOutputTokens: 4096,
                  tokenizerType: 'LLAMA_WITH_SPECIAL',
                  model: generateModelPlaceholderId(m),
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                };
                m._slug = slug;
              });
              googleJson.models = modelsMap;
            }

            // Inject custom model slugs into agentModelSorts
            const customSlugs = customModels.map((m) => m._slug).filter(Boolean) as string[];
            if (customSlugs.length > 0) {
              if (googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
                (googleJson.agentModelSorts as { groups?: { modelIds?: string[] }[] }[]).forEach((sort) => {
                  if (sort.groups && Array.isArray(sort.groups)) {
                    sort.groups.forEach((group) => {
                      if (group.modelIds && Array.isArray(group.modelIds)) {
                        customSlugs.forEach((slug) => {
                          if (!group.modelIds!.includes(slug)) {
                            group.modelIds!.push(slug);
                          }
                        });
                      }
                    });
                  }
                });
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Parsing fetchAvailableModels failed, returning custom models:', err);
            const customModels = getRoutableModels();
            const mappedCustom = fallbackModelsMap(customModels);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Forwarding fetchAvailableModels failed:', err);
        const customModels = getRoutableModels();
        const mappedCustom: Record<string, unknown> = {};
        customModels.forEach((m) => {
          const slug = toSlug(m);
          mappedCustom[slug] = {
            displayName: m.displayName,
            maxTokens: 1048576,
            maxOutputTokens: 4096,
            model: generateModelPlaceholderId(m),
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: mappedCustom }));
      });

      if (fullBody && fullBody.length > 0) {
        googleReq.write(fullBody);
      }
      googleReq.end();
      return;
    }

    // 2. Intercept /v1beta/models or /v1/models list request
    if (req.method === 'GET' && (req.url!.endsWith('/models') || req.url!.includes('/models?'))) {
      log.info('[Proxy] Intercepting models list request');

      const targetUrl = 'https://generativelanguage.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const mdlHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      mdlHeaders['host'] = 'generativelanguage.googleapis.com';
      delete mdlHeaders['connection'];
      delete mdlHeaders['accept-encoding'];

      const mdlOptions: https.RequestOptions = { method: 'GET', headers: mdlHeaders as Record<string, string> };

      const googleReq = https.request(parsedUrl, mdlOptions, (googleRes) => {
        // P0-5: Timeout for models list forward request (30s)
        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] Models list forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = getRoutableModels();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                models: customModels.map((m) => ({
                  name: m.name,
                  displayName: m.displayName,
                  description: m.description,
                  supportedGenerationMethods: ['generateContent'],
                })),
              }),
            );
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            const googleJson = JSON.parse(googleBody) as { models?: unknown[] };
            const customModels = getRoutableModels();

            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: 1048576,
              outputTokenLimit: 4096,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
              temperature: 0.7,
              topP: 0.9,
              topK: 40,
            }));

            if (googleJson.models) {
              googleJson.models = [...mappedCustom, ...googleJson.models];
            } else {
              googleJson.models = mappedCustom;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Google list models failed, returning custom models list only:', err);
            const customModels = getRoutableModels();
            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: 1048576,
              outputTokenLimit: 4096,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Google models list request error:', err);
        const customModels = getRoutableModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: customModels.map((m) => ({
              name: m.name,
              displayName: m.displayName,
              description: m.description,
              supportedGenerationMethods: ['generateContent'],
            })),
          }),
        );
      });
      googleReq.end();
      return;
    }

    // 3. Intercept Cloud Code generation stream or non-stream requests
    const isCloudCodeStream =
      req.url!.includes('/v1internal:streamGenerateContent') || req.url!.includes('/v1internal:generateContent');
    if (req.method === 'POST' && isCloudCodeStream) {
      try {
        const reqJson = JSON.parse(bodyStr) as Record<string, unknown>;
        const modelName = reqJson.model as string | undefined;
        const modelId = (reqJson.modelId || reqJson.model_id) as string | undefined;
        log.info(
          `[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`,
        );
        if (modelName) {
          const customModels = getRoutableModels();
          const matchedCustomModel = customModels.find((m) => {
            const enumName = generateModelPlaceholderId(m);
            return (
              m.name === modelName ||
              toSlug(m) === modelName ||
              toLegacySlug(m) === modelName ||
              enumName === modelName ||
              enumName === modelId
            );
          });
          const disabledPick = matchedCustomModel
            ? undefined
            : findDisabledPick(modelName, modelId, loadCustomModels());
          if (matchedCustomModel) {
            log.info(
              `[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`,
            );
            if (isAutoModel(matchedCustomModel)) {
              // Part 7: make the UI-selection -> backend-resolution explicit.
              log.info(
                `[Auto] UI selected: ${modelName} (modelId: ${modelId ?? 'n/a'}) -> resolved: custom-auto-router`,
              );
              const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
              const actualGeminiBody = (reqJson.request || reqJson) as GeminiRequestBody;
              resolveFileData(actualGeminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
                handleAutoModelRequest(res, actualGeminiBody, isStream);
              });
              return;
            }
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            const actualGeminiBody = (reqJson.request || reqJson) as GeminiRequestBody;
            // Resolve fileData URIs then route to translator.
            // Part 1: specific-model requests get a real rotation chain too,
            // ranked by task fit + health (free-router style), not config order.
            // Rotation OFF: direct dial only, no fallback chain.
            const chain = loadRouterSettings().autoRouter
              ? rankFallbacks(matchedCustomModel, customModels, actualGeminiBody as unknown as AutoGeminiBody)
              : [];
            startRouting(res, matchedCustomModel.displayName);
            resolveFileData(actualGeminiBody, req.headers as Record<string, string | string[] | undefined>).then(async () => {
              stripRouteNotes(actualGeminiBody);
              const fit = await maybeJevFit(matchedCustomModel, customModels, actualGeminiBody);
              if (fit.jev) noteRoutingJev(res, fit.jev);
              handleCustomModelRequest(res, matchedCustomModel, fit.body, isStream, 0, chain);
            });
            return;
          } else if (disabledPick) {
            // Stale IDE picker selected a model that is now disabled (Off Model).
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            const actualGeminiBody = (reqJson.request || reqJson) as GeminiRequestBody;
            resolveFileData(actualGeminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
              stripRouteNotes(actualGeminiBody);
              handleDisabledModelPick(res, disabledPick, actualGeminiBody, isStream);
            });
            return;
          } else if (isAutoIdentity(modelName) || isAutoIdentity(modelId)) {
            // Toggle OFF hides Auto from the picker, but in-flight Auto
            // requests must still get the actionable error (Part 7).
            log.info(`[Auto] UI selected: ${modelName} (modelId: ${modelId ?? 'n/a'}) -> resolved: custom-auto-router`);
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            const actualGeminiBody = (reqJson.request || reqJson) as GeminiRequestBody;
            resolveFileData(actualGeminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
              handleAutoModelRequest(res, actualGeminiBody, isStream);
            });
            return;
          }
        }
      } catch (err) {
        log.error('[Proxy] Failed to parse Cloud Code stream body:', err);
      }
    }

    // 4. Intercept standard generateContent / streamGenerateContent request
    const generateMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
    const streamMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);

    const isGenerate = !!generateMatch;
    const isStandardStream = !!streamMatch;

    if (req.method === 'POST' && (isGenerate || isStandardStream)) {
      const matchedModelName = isGenerate ? generateMatch![1] : streamMatch![1];
      const customModels = getRoutableModels();
      const matchedCustomModel = customModels.find((m) => {
        const enumName = generateModelPlaceholderId(m);
        return (
          m.name === matchedModelName ||
          toSlug(m) === matchedModelName ||
          toLegacySlug(m) === matchedModelName ||
          enumName === matchedModelName ||
          'models/' + enumName === matchedModelName
        );
      });
      const disabledPick = matchedCustomModel ? undefined : findDisabledPick(matchedModelName, undefined, loadCustomModels());

      if (matchedCustomModel) {
        if (isAutoModel(matchedCustomModel)) {
          // Part 7: make the UI-selection -> backend-resolution explicit.
          log.info(
            `[Auto] UI selected: ${matchedModelName} -> resolved: custom-auto-router`,
          );
          try {
            const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
            resolveFileData(geminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
              handleAutoModelRequest(res, geminiBody, isStandardStream);
            });
            return;
          } catch (e) {
            log.error('[Proxy] JSON parse error in request body:', e);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
            return;
          }
        }
        try {
          const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
          // Part 1: specific-model requests get a real rotation chain too,
          // ranked by task fit + health (free-router style), not config order.
          // Rotation OFF: direct dial only, no fallback chain.
          const chain = loadRouterSettings().autoRouter
            ? rankFallbacks(matchedCustomModel, customModels, geminiBody as unknown as AutoGeminiBody)
            : [];
          startRouting(res, matchedCustomModel.displayName);
          resolveFileData(geminiBody, req.headers as Record<string, string | string[] | undefined>).then(async () => {
            stripRouteNotes(geminiBody);
            const fit = await maybeJevFit(matchedCustomModel, customModels, geminiBody);
            if (fit.jev) noteRoutingJev(res, fit.jev);
            handleCustomModelRequest(res, matchedCustomModel, fit.body, isStandardStream, 0, chain);
          });
          return;
        } catch (e) {
          log.error('[Proxy] JSON parse error in request body:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
          return;
        }
      } else if (disabledPick) {
        // Stale IDE picker selected a model that is now disabled (Off Model).
        try {
          const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
          resolveFileData(geminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
            stripRouteNotes(geminiBody);
            handleDisabledModelPick(res, disabledPick, geminiBody, isStandardStream);
          });
          return;
        } catch (e) {
          log.error('[Proxy] JSON parse error in request body:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
          return;
        }
      } else if (isAutoIdentity(matchedModelName)) {
        // Toggle OFF hides Auto from the picker, but in-flight Auto requests
        // must still get the actionable error (Part 7).
        try {
          const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
          resolveFileData(geminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
            handleAutoModelRequest(res, geminiBody, isStandardStream);
          });
          return;
        } catch (e) {
          log.error('[Proxy] JSON parse error in request body:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
          return;
        }
      }
    }

    // 5. Fallback: transparent proxy to Google
    proxyToGoogle(req, res, fullBody);
  });
}

// ─── Server Start/Stop ────────────────────────────────────────────────────

export const DEFAULT_PROXY_PORT = 50999;

/**
 * Ordered ports to try at startup. The IDE's `jetski.cloudCodeUrl` setting
 * snapshots one port at deploy time, so a restart that lands on a different
 * port leaves the IDE talking to a dead endpoint (stuck at "Authenticating").
 * Preferring the last-known-good port from `active_port` keeps the setting
 * valid across restarts; 50999 is next, dynamic (0) is the last resort.
 */
export function resolvePortCandidates(savedPort?: number): number[] {
  const cands: number[] = [];
  if (savedPort !== undefined && Number.isInteger(savedPort) && savedPort > 0 && savedPort < 65536) {
    cands.push(savedPort);
  }
  if (!cands.includes(DEFAULT_PROXY_PORT)) cands.push(DEFAULT_PROXY_PORT);
  cands.push(0);
  return cands;
}

/** Last port this proxy successfully listened on (written by the launcher). */
function readSavedPort(): number | undefined {
  try {
    const file = path.join(app.getPath('home'), '.gemini', 'antigravity', 'active_port');
    if (!fs.existsSync(file)) return undefined;
    const v = Number(fs.readFileSync(file, 'utf-8').trim());
    return Number.isInteger(v) && v > 0 && v < 65536 ? v : undefined;
  } catch {
    return undefined;
  }
}

export function startProxy(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);

    // P1-9: Start managed cleanup interval
    startCleanupInterval();

    const candidates = resolvePortCandidates(readSavedPort());
    let attempt = 0;

    function tryListen(port: number): void {
      server!.listen(port, '127.0.0.1', () => {
        proxyPort = (server!.address() as import('net').AddressInfo).port;
        log.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
        resolve(proxyPort);
      });
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      // ponytail: EACCES/EPERM = excluded/blocked port (e.g. Hyper-V winnat range), fall through like EADDRINUSE
      if ((err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EPERM') && attempt < candidates.length - 1) {
        log.warn(`[Proxy] Port ${candidates[attempt]} unavailable (${err.code}). Trying next...`);
        attempt++;
        tryListen(candidates[attempt]);
      } else {
        log.error('[Proxy] Startup failed:', err);
        reject(err);
      }
    });

    tryListen(candidates[attempt]);
  });
}

export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    // P1-9: Stop cleanup interval to prevent orphaned timers
    stopCleanupInterval();

    if (server) {
      server.close(() => {
        log.info('[Proxy] Server stopped');
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export function getProxyPort(): number {
  return proxyPort;
}
