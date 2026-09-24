/**
 * JEV Mode tests: pairing/pinning, verdict parsing, compaction decisions,
 * judge auto-testing (failover + circuit-breaker reporting), and the
 * planAutoRouteJev integration with its local-compression fallback.
 * Judges are anthropic models answered by a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  findCandidates,
  buildState,
  itemLines,
  batchItems,
  renderProbePrompt,
  parseVerdicts,
  applyDecisions,
  judgeOrder,
  jevCompact,
  lastJevStats,
  estimateJevTokens,
} from '../proxy/jevMode';
import { planAutoRouteJev, planAutoRoute } from '../proxy/autoRouter';
import { smartHealth } from '../proxy/smartHealth';
import { healthKey } from '../proxy/modelUtils';
import type { CustomModel } from '../proxy';
import type { JevBody } from '../proxy/jevMode';

// ─── Fixtures ─────────────────────────────────────────────────────────────

function mk(name: string, provider = 'anthropic'): CustomModel {
  return {
    name: 'models/' + name,
    displayName: name,
    description: '',
    provider,
    apiKey: 'none',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    externalModelName: name,
  };
}

function toolBody(): JevBody {
  return {
    contents: [
      { role: 'user', parts: [{ text: 'fix the failing build' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/app.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'x'.repeat(4000) } } }] },
      { role: 'model', parts: [{ functionCall: { name: 'run_tests', args: { suite: 'unit' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'run_tests', response: { output: 'all 42 passed' } } }] },
      { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: 'src/app.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'write_file', response: { bytes: 1234 } } }] },
      { role: 'model', parts: [{ functionCall: { name: 'list_dir', args: { dir: '.' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'list_dir', response: { entries: 'src/ test/' } } }] },
      { role: 'user', parts: [{ text: 'now what?' }] },
      { role: 'model', parts: [{ text: 'let me check the config' }] },
      { role: 'user', parts: [{ text: 'ok' }] },
      { role: 'model', parts: [{ text: 'checking' }] },
      { role: 'user', parts: [{ text: 'go on' }] },
      { role: 'model', parts: [{ text: 'done soon' }] },
    ],
  };
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function anthropicReply(text: string) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ content: [{ type: 'text', text }] }),
  };
}

const VERDICTS = ['1: keep=no verbatim=no', '2: keep=yes verbatim=yes', '3: keep=yes verbatim=no', '4: keep=no verbatim=no'].join('\n');

beforeEach(() => {
  fetchMock.mockReset();
  smartHealth.clear();
});

// ─── Pairing & pinning ────────────────────────────────────────────────────

describe('findCandidates', () => {
  it('pairs calls with responses by name, in order', () => {
    const cands = findCandidates(toolBody());
    expect(cands.map((c) => c.name)).toEqual(['read_file', 'run_tests', 'write_file', 'list_dir']);
    expect(cands[0]).toMatchObject({ callIndex: 1, callPartIndex: 0, responseIndex: 2, responsePartIndex: 0 });
  });

  it('respects the pinned zone: recent calls are never candidates', () => {
    const body = toolBody();
    // Add a call+response pair inside the last 6 (pinned) contents.
    body.contents!.push({ role: 'model', parts: [{ functionCall: { name: 'pinned_tool', args: {} } }] });
    body.contents!.push({ role: 'user', parts: [{ functionResponse: { name: 'pinned_tool', response: { ok: 1 } } }] });
    const cands = findCandidates(body);
    expect(cands.map((c) => c.name)).not.toContain('pinned_tool');
  });

  it('returns nothing for a short or call-less conversation', () => {
    expect(findCandidates({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })).toEqual([]);
    expect(
      findCandidates({
        contents: Array.from({ length: 12 }, (_, i) => ({ role: 'user', parts: [{ text: 'turn ' + i }] })),
      }),
    ).toEqual([]);
  });

  it('skips calls whose response landed in the pinned zone (one side would dangle)', () => {
    const body: JevBody = {
      contents: [
        { role: 'user', parts: [{ text: 'start' }] },
        { role: 'model', parts: [{ functionCall: { name: 'late_result', args: {} } }] },
        ...Array.from({ length: 7 }, (_, i) => ({ role: 'user', parts: [{ text: 'filler ' + i }] })),
        { role: 'user', parts: [{ functionResponse: { name: 'late_result', response: { ok: 1 } } }] },
        { role: 'user', parts: [{ text: 'recent' }] },
        { role: 'model', parts: [{ text: 'recent' }] },
      ],
    };
    // length 11, preserveRecent 6 -> lastEditable 5; the response at index 10 is pinned.
    expect(findCandidates(body)).toEqual([]);
  });
});

// ─── State building & batching ────────────────────────────────────────────

describe('buildState', () => {
  it('replaces tool results with short notes and keeps roles', () => {
    const { state } = buildState(toolBody());
    expect(state).toContain('tool call read_file');
    expect(state).toContain('(omitted)');
    expect(state).not.toContain('x'.repeat(100)); // the huge result body is gone
  });

  it('stays under maxStateTokens for huge conversations', () => {
    const body = toolBody();
    body.contents![2]!.parts![0]!.functionResponse!.response = { content: 'y'.repeat(2_000_000) };
    const { stateTokens } = buildState(body, 25_000);
    expect(stateTokens).toBeLessThanOrEqual(25_000);
  });
});

describe('batchItems', () => {
  it('fits every item into batches under the request budget', () => {
    const cands = findCandidates(toolBody());
    const { stateTokens } = buildState(toolBody());
    const batches = batchItems(cands, stateTokens, 30_000);
    expect(batches.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('splits into multiple batches when the state eats the budget', () => {
    const cands = findCandidates(toolBody());
    const batches = batchItems(cands, 29_900, 30_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });
});

describe('probe prompt & verdict parsing', () => {
  it('renders the two-question format with the state and items', () => {
    const { state } = buildState(toolBody());
    const prompt = renderProbePrompt(state, itemLines(findCandidates(toolBody())));
    expect(prompt).toContain('keep=yes verbatim=no');
    expect(prompt).toContain('[CONVERSATION STATE]');
    expect(prompt).toContain('#1 read_file');
  });

  it('parses named and positional verdicts', () => {
    const v = parseVerdicts('1: keep=yes verbatim=no\n2: no no\n3: keep=no verbatim=no');
    expect(v.get(1)).toEqual([true, false]);
    expect(v.get(2)).toEqual([false, false]);
    expect(v.get(3)).toEqual([false, false]);
    expect(v.size).toBe(3);
  });

  it('ignores garbage lines instead of throwing', () => {
    expect(parseVerdicts('I am not sure about any of this!').size).toBe(0);
    expect(parseVerdicts('').size).toBe(0);
  });
});

// ─── Decision application ─────────────────────────────────────────────────

describe('applyDecisions', () => {
  it('drops dropped pairs, truncates call-only results, keeps verbatim pairs', () => {
    const body = toolBody();
    const cands = findCandidates(body);
    const verdicts = parseVerdicts(VERDICTS);
    const applied = applyDecisions(body, cands, verdicts);

    expect(applied.dropped).toBe(2);
    expect(applied.truncated).toBe(1);
    expect(applied.kept).toBe(1);

    const flat = applied.body.contents!.flatMap((c) => c.parts || []);
    const callNames = flat.map((p) => (p.functionCall as { name?: string } | undefined)?.name).filter(Boolean);
    const respNames = flat.map((p) => (p.functionResponse as { name?: string } | undefined)?.name).filter(Boolean);
    expect(callNames).toEqual(['run_tests', 'write_file']);
    expect(respNames).toEqual(['run_tests', 'write_file']);

    // The truncated result keeps its functionResponse shape but is shortened.
    const truncated = flat.find((p) => (p.functionResponse as { name?: string } | undefined)?.name === 'write_file');
    const note = JSON.stringify((truncated!.functionResponse as { response?: unknown }).response);
    expect(note).toContain('[truncated]');
    expect(note.length).toBeLessThan(400);
    // Verbatim pair survived untouched.
    const runTests = flat.find((p) => (p.functionResponse as { name?: string } | undefined)?.name === 'run_tests');
    expect(JSON.stringify((runTests!.functionResponse as { response?: unknown }).response)).toContain('all 42 passed');
  });

  it('never mutates the original body', () => {
    const body = toolBody();
    const before = JSON.stringify(body);
    applyDecisions(body, findCandidates(body), parseVerdicts(VERDICTS));
    expect(JSON.stringify(body)).toBe(before);
  });

  it('missing verdicts default to keep-verbatim (sloppy judge never drops context)', () => {
    const body = toolBody();
    const cands = findCandidates(body);
    const applied = applyDecisions(body, cands, new Map());
    expect(applied.dropped).toBe(0);
    expect(applied.kept).toBe(cands.length);
  });
});

// ─── Judge ranking & full compaction ──────────────────────────────────────

describe('judgeOrder', () => {
  it('puts unhealthy models last', () => {
    const healthy = mk('healthy-judge');
    const sick = mk('sick-judge');
    for (let i = 0; i < 3; i++) smartHealth.reportFailure(healthKey(sick));
    expect(judgeOrder([sick, healthy])[0].displayName).toBe('healthy-judge');
  });
});

describe('jevCompact', () => {
  it('compacts via the judge: drops, keeps verbatim, truncates, records stats', async () => {
    fetchMock.mockResolvedValue(anthropicReply(VERDICTS));
    const body = toolBody();
    const before = estimateJevTokens(body);
    const out = await jevCompact([mk('judge-a')], body, 1000);
    expect(out).not.toBeNull();
    expect(out!.stats.callsDropped).toBe(2);
    expect(out!.stats.callsKept).toBe(1);
    expect(out!.stats.resultsTruncated).toBe(1);
    expect(out!.stats.tokensAfter).toBeLessThan(before);
    expect(out!.stats.fellBack).toBe(false);
    expect(lastJevStats()).toBe(out!.stats);
    // Probe went through the anthropic translator with a single user message.
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.model).toBe('judge-a');
    expect(payload.max_tokens).toBeGreaterThan(0);
    expect(smartHealth.penalty(healthKey(mk('judge-a')))).toBe(0);
  });

  it('auto-tests judges: first fails, second answers; failures hit the breaker', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    fetchMock.mockResolvedValueOnce(anthropicReply(VERDICTS));
    const out = await jevCompact([mk('judge-bad'), mk('judge-good')], toolBody(), 1000);
    expect(out).not.toBeNull();
    expect(out!.stats.judge).toBe('judge-good');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(smartHealth.penalty(healthKey(mk('judge-bad')))).toBeGreaterThan(0);
    expect(smartHealth.penalty(healthKey(mk('judge-good')))).toBe(0);
  });

  it('returns null when every judge fails (caller keeps its current plan)', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    const out = await jevCompact([mk('judge-bad'), mk('judge-worse')], toolBody(), 1000);
    expect(out).toBeNull();
    expect(lastJevStats()?.fellBack).toBe(true);
    expect(smartHealth.penalty(healthKey(mk('judge-bad')))).toBeGreaterThan(0);
  });

  it('returns null without probing when there is nothing to compact', async () => {
    const out = await jevCompact([mk('judge-a')], { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, 1000);
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without probing when the request already fits', async () => {
    const out = await jevCompact([mk('judge-a')], toolBody(), 10_000_000);
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (insufficient reduction) when the judge keeps everything', async () => {
    fetchMock.mockResolvedValue(anthropicReply('1: keep=yes verbatim=yes\n2: keep=yes verbatim=yes\n3: keep=yes verbatim=yes\n4: keep=yes verbatim=yes'));
    const out = await jevCompact([mk('judge-a')], toolBody(), 1000);
    expect(out).toBeNull();
    expect(lastJevStats()?.fellBack).toBe(true);
  });
});

// ─── planAutoRouteJev integration ─────────────────────────────────────────

function hugeToolBody(): JevBody {
  return {
    contents: [
      { role: 'user', parts: [{ text: 'audit this project' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'big.log' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'z'.repeat(900_000) } } }] },
      { role: 'user', parts: [{ text: 'recent one' }] },
      { role: 'model', parts: [{ text: 'recent two' }] },
      { role: 'user', parts: [{ text: 'recent three' }] },
      { role: 'model', parts: [{ text: 'recent four' }] },
      { role: 'user', parts: [{ text: 'recent five' }] },
      { role: 'model', parts: [{ text: 'recent six' }] },
    ],
  };
}

describe('planAutoRouteJev', () => {
  it('fast path: fitting requests are planned exactly like planAutoRoute, no probe', async () => {
    const models = [mk('claude-sonnet-4')];
    const small = { contents: [{ role: 'user', parts: [{ text: 'hello there' }] }] };
    const plan = await planAutoRouteJev(models, small);
    expect(plan).toEqual(planAutoRoute(models, small));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('oversized request: JEV compacts verbatim so the best model can take it', async () => {
    const models = [mk('claude-sonnet-4')]; // 200k window; the body is ~226k tokens
    fetchMock.mockResolvedValue(anthropicReply('1: keep=no verbatim=no'));
    const plan = await planAutoRouteJev(models, hugeToolBody());
    expect(plan.compressed).toBe(true);
    expect(plan.reason).toContain('JEV compaction');
    expect(plan.chain[0].displayName).toBe('claude-sonnet-4');
    // The huge tool result is gone from the routed body.
    expect(JSON.stringify(plan.body)).not.toContain('z'.repeat(1000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('judge failure falls back to the local digest compression (original behavior)', async () => {
    const models = [mk('claude-sonnet-4')];
    fetchMock.mockRejectedValue(new Error('HTTP 500'));
    const plan = await planAutoRouteJev(models, hugeToolBody());
    expect(plan.compressed).toBe(true);
    expect(plan.reason).not.toContain('JEV compaction');
    expect(plan.chain.length).toBeGreaterThan(0);
  });
});
