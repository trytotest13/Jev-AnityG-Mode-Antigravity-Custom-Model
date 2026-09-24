import { describe, it, expect } from 'vitest';
import {
  buildAutoModel,
  isAutoModel,
  classifyRequest,
  estimateTokens,
  pickChain,
  rankFallbacks,
  compressContents,
  planAutoRoute,
  AUTO_DISPLAY_NAME,
  AUTO_EXTERNAL_NAME,
} from '../proxy/autoRouter';
import { smartHealth } from '../proxy/smartHealth';
import { healthKey } from '../proxy/modelUtils';
import type { CustomModel } from '../proxy';

// ─── Fixtures ─────────────────────────────────────────────────────────────

function mk(name: string, provider = 'openrouter'): CustomModel {
  return {
    name: 'models/' + name,
    displayName: name,
    description: '',
    provider,
    apiKey: 'none',
    apiUrl: 'https://example.com/v1/chat/completions',
    externalModelName: name,
  };
}

// gpt-4o-mini: vision-capable, 1M window, matches "mini" quick hint
const gpt4oMini = mk('gpt-4o-mini');
// deepseek-chat: NO vision, 1M window, strong code hint
const deepseek = mk('deepseek-chat');
// claude: vision + 200k window
const claude = mk('claude-sonnet-4', 'anthropic');
const models = [gpt4oMini, deepseek, claude];

const textBody = (t: string): Parameters<typeof classifyRequest>[0] => ({
  contents: [{ role: 'user', parts: [{ text: t }] }],
});

// ─── Virtual model identity ───────────────────────────────────────────────

describe('auto model identity', () => {
  it('builds the virtual Auto model and detects it', () => {
    const auto = buildAutoModel();
    expect(auto.displayName).toBe(AUTO_DISPLAY_NAME);
    expect(auto.externalModelName).toBe(AUTO_EXTERNAL_NAME);
    expect(isAutoModel(auto)).toBe(true);
    expect(isAutoModel(gpt4oMini)).toBe(false);
    expect(isAutoModel(deepseek)).toBe(false);
  });
});

// ─── Classification ───────────────────────────────────────────────────────

describe('classifyRequest', () => {
  it('detects vision from inlineData image parts', () => {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'what is this?' }, { inlineData: { mimeType: 'image/png', data: 'x' } }],
        },
      ],
    };
    expect(classifyRequest(body).task).toBe('vision');
  });

  it('detects vision from image fileData mime types', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/jpeg', fileUri: 'u' } }] }],
    };
    expect(classifyRequest(body).task).toBe('vision');
  });

  it('detects code from fenced blocks', () => {
    expect(classifyRequest(textBody('```python\ndef add(a,b): return a+b\n```\ntest it')).task).toBe('code');
  });

  it('detects code from keywords', () => {
    expect(classifyRequest(textBody('the traceback says TypeError, fix my function')).task).toBe('code');
  });

  it('classifies short input as quick', () => {
    expect(classifyRequest(textBody('hi')).task).toBe('quick');
  });

  it('classifies long input', () => {
    expect(classifyRequest(textBody('x'.repeat(9000))).task).toBe('long');
  });

  it('defaults to chat', () => {
    expect(classifyRequest(textBody('tell me about space exploration '.repeat(10))).task).toBe('chat');
  });

  it('#model: tag forces a specific model', () => {
    const cls = classifyRequest(textBody('#model:claude-sonnet-4 write tests please'));
    expect(cls.task).toBe('forced');
    expect(cls.forcedModel).toBe('claude-sonnet-4');
  });

  it('#:code tag forces code task over other signals', () => {
    expect(classifyRequest(textBody('draw me a picture #:code')).task).toBe('code');
  });

  it('detects reasoning/math requests', () => {
    const cls = classifyRequest(textBody('prove that the sum of two odds is even, step by step'));
    expect(cls.task).toBe('reasoning');
  });

  it('does not misread short small talk as code', () => {
    expect(classifyRequest(textBody('hi there!')).task).toBe('quick');
  });

  it('treats tool-call parts as code-shaped agent traffic', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'continue' }, { functionCall: { name: 'run_command', args: {} } }] },
      ],
    };
    expect(classifyRequest(body).task).toBe('code');
  });
});

// ─── Estimation ───────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~chars/4 plus headroom for text', () => {
    expect(estimateTokens(textBody('a'.repeat(400)))).toBe(100 + 2048);
  });

  it('charges a flat cost per image part', () => {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'z' } }],
        },
      ],
    };
    expect(estimateTokens(body)).toBe(1 + 1100 + 2048);
  });
});

// ─── Ranking ──────────────────────────────────────────────────────────────

describe('pickChain', () => {
  it('routes vision to vision-capable models only', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'z' } }] }],
    };
    const chain = pickChain(models, body);
    expect(chain).not.toContain(deepseek);
    expect(chain.length).toBeGreaterThan(0);
  });

  it('routes code to the code-family model first', () => {
    const chain = pickChain(models, textBody('```js\nconst x = 1;\n```\nrefactor this'));
    expect(chain[0]).toBe(deepseek);
  });

  it('routes quick chats to a fast/mini model first', () => {
    const chain = pickChain(models, textBody('hi'));
    expect(chain[0]).toBe(gpt4oMini);
  });

  it('honors #model: forced tags exactly', () => {
    const chain = pickChain(models, textBody('#model:claude-sonnet-4 hello'));
    expect(chain).toEqual([claude]);
  });

  it('returns a fallback chain with more than one model', () => {
    const chain = pickChain(models, textBody('tell me about space exploration '.repeat(6)));
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]).not.toBe(chain[1]);
  });

  it('excludes the auto model itself from candidates', () => {
    const chain = pickChain([...models, buildAutoModel()], textBody('hi'));
    expect(chain.every((m) => !isAutoModel(m))).toBe(true);
  });

  it('prefers a reasoning model for reasoning tasks', () => {
    const r1 = mk('deepseek-r1');
    const chain = pickChain([deepseek, r1], textBody('solve this proof step by step'));
    expect(chain[0]).toBe(r1);
  });

  it('matches #model: tags with loose separators', () => {
    const chain = pickChain(models, textBody('#model:claude_sonnet_4 hello'));
    expect(chain).toEqual([claude]);
  });

  it('explains the pick in the plan reason', () => {
    const plan = planAutoRoute(models, textBody('```js\nconst x = 1;\n```\nrefactor this'));
    expect(plan.reason).toContain('deepseek-chat');
    expect(plan.reason).toContain('code');
  });
});

// ─── Compression ──────────────────────────────────────────────────────────

describe('compressContents', () => {
  it('keeps recent turns verbatim and condenses old ones', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      parts: [{ text: `turn ${i} ` + 'y'.repeat(100) }],
    }));
    const last = turns[turns.length - 1];
    const out = compressContents({ contents: turns });

    expect(out.contents!.length).toBe(7); // digest + 6 recent
    expect(JSON.stringify(out.contents![out.contents!.length - 1])).toBe(JSON.stringify(last));
    expect((out.contents![0].parts![0] as { text: string }).text).toContain(
      '[Compressed earlier conversation (14 turns)',
    );
  });

  it('is a no-op when the conversation is already short', () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    expect(compressContents(body)).toBe(body);
  });
});

// ─── Full plan ────────────────────────────────────────────────────────────

describe('planAutoRoute', () => {
  it('returns a servable chain for normal requests', () => {
    const plan = planAutoRoute(models, textBody('```py\ndef f(): pass\n```\ntest this'));
    expect(plan.task).toBe('code');
    expect(plan.chain.length).toBeGreaterThan(0);
    expect(plan.compressed).toBe(false);
  });

  it('compresses when nothing fits and still yields a chain', () => {
    const turns = Array.from({ length: 30 }, () => ({
      role: 'user',
      parts: [{ text: 'y'.repeat(150000) }],
    }));
    const plan = planAutoRoute(models, { contents: turns });
    expect(plan.compressed).toBe(true);
    expect(plan.chain.length).toBeGreaterThan(0);
    expect(plan.body.contents!.length).toBeLessThan(30);
  });
});

// ─── Tie rotation (Part 6) ────────────────────────────────────────────────

describe('tie rotation', () => {
  it('near-tied chat candidates take turns winning', () => {
    smartHealth.clear();
    const a = mk('claude-alpha');
    const b = mk('claude-beta');
    const body = textBody('Hey, how have you been lately? ' + 'lorem ipsum dolor sit amet. '.repeat(12));
    const winners = new Set<string>();
    for (let i = 0; i < 4; i++) {
      winners.add(pickChain([a, b], body)[0].displayName);
    }
    expect(winners.size).toBe(2);
  });

  it('a clear winner is never rotated away', () => {
    smartHealth.clear();
    const fast = mk('gpt-4o-mini'); // 'mini' quick hint: decisive for short input
    const other = mk('deepseek-chat');
    const body = textBody('hi');
    for (let i = 0; i < 4; i++) {
      expect(pickChain([fast, other], body)[0].displayName).toBe('gpt-4o-mini');
    }
  });
});

// ─── Specific-model fallback ranking (free-router rules 7-8) ─────────────

describe('rankFallbacks', () => {
  it('excludes the selected model and the virtual Auto entry', () => {
    smartHealth.clear();
    const chain = rankFallbacks(gpt4oMini, [gpt4oMini, buildAutoModel(), deepseek], textBody('hello there friend'));
    expect(chain.some((m) => m === gpt4oMini)).toBe(false);
    expect(chain.some(isAutoModel)).toBe(false);
    expect(chain.map((m) => m.displayName)).toContain('deepseek-chat');
  });

  it('a vision task only falls back to models that can see', () => {
    smartHealth.clear();
    const imageBody = {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'x' } }] }],
    };
    const chain = rankFallbacks(gpt4oMini, [deepseek, claude], imageBody);
    expect(chain.map((m) => m.displayName)).toEqual(['claude-sonnet-4']);
  });

  it('a breaker-punished model sinks to the back of the chain', () => {
    smartHealth.clear();
    const sick = mk('claude-alpha');
    const healthy = mk('claude-beta');
    smartHealth.reportFailure(healthKey(sick));
    smartHealth.reportFailure(healthKey(sick));
    const chain = rankFallbacks(gpt4oMini, [sick, healthy], textBody('plain chat '.repeat(20)));
    expect(chain[chain.length - 1].displayName).toBe('claude-alpha');
    expect(chain[0].displayName).toBe('claude-beta');
  });
});

// ─── Risky requests (Jev rule) ────────────────────────────────────────────

describe('risky requests', () => {
  it('one decisive destructive signal sets the risky flag', () => {
    const cls = classifyRequest(textBody('run rm -rf /tmp/cache on the server'));
    expect(cls.risky).toBe(true);
    expect(cls.reason).toContain('risky: destructive delete');
  });

  it('two soft signals together set the risky flag', () => {
    const cls = classifyRequest(textBody('deploy the migration to production in the morning'));
    expect(cls.risky).toBe(true);
  });

  it('a single soft signal alone does not', () => {
    expect(classifyRequest(textBody('how do I deploy a next.js app to vercel?')).risky).toBeUndefined();
  });

  it('ordinary requests never set the flag', () => {
    expect(classifyRequest(textBody('tell me about space exploration '.repeat(6))).risky).toBeUndefined();
  });

  it('routes a risky request to the strongest tier over a cheap quick fit', () => {
    smartHealth.clear();
    const cheap = mk('gpt-4o-mini');
    const strong = mk('deepseek-r1');
    const chain = pickChain([cheap, strong], textBody('run rm -rf /var/data on the prod db server'));
    expect(chain[0]).toBe(strong);
  });
});

// ─── Certainty gate (asymmetric upgrade / downgrade) ──────────────────────

describe('certainty gate', () => {
  const codeBody = textBody('fix the parser: TypeError null');
  // Same family and window, so the only score differences are the reasoner
  // bonus (+8) and breaker penalties (12 per two failures). Calibration:
  // two failures land the strong model 4 points under the weak one - inside
  // the uncertain band; three failures put it 10 under - outside it.

  it('promotes a stronger rival the weak leader edged out inside the margin', () => {
    smartHealth.clear();
    const weak = mk('deepseek-chat');
    const strong = mk('deepseek-r1');
    smartHealth.reportFailure(healthKey(strong));
    smartHealth.reportFailure(healthKey(strong));
    const chain = pickChain([weak, strong], codeBody);
    expect(chain[0]).toBe(strong);
  });

  it('a confident weak leader keeps the seat', () => {
    smartHealth.clear();
    const weak = mk('deepseek-chat');
    const strong = mk('deepseek-r1');
    smartHealth.reportFailure(healthKey(strong));
    smartHealth.reportFailure(healthKey(strong));
    smartHealth.reportFailure(healthKey(strong)); // breaker opens: out of the pool entirely
    const chain = pickChain([weak, strong], codeBody);
    expect(chain[0]).toBe(weak);
  });

  it('never fires for chat, so a stronger near-tied model cannot lock the seat', () => {
    smartHealth.clear();
    const weak = mk('deepseek-chat');
    const strong = mk('deepseek-r1');
    const body = textBody('tell me about the weather '.repeat(12));
    const winners = new Set<string>();
    for (let i = 0; i < 4; i++) winners.add(pickChain([weak, strong], body)[0].displayName);
    expect(winners.size).toBe(2);
  });
});
