import { describe, it, expect } from 'vitest';
import { shouldSwitch, shouldSwitchBody, isContextOverflow, HealthMonitor } from '../proxy/smartHealth';

describe('shouldSwitch', () => {
  it('fails fast on client errors', () => {
    expect(shouldSwitch(400).switch).toBe(false);
  });
  it('switches on auth/model-not-found without same-model retry', () => {
    expect(shouldSwitch(401)).toMatchObject({ switch: true, retrySame: false });
    expect(shouldSwitch(404)).toMatchObject({ switch: true, retrySame: false });
  });
  it('switches on billing/size/model-specific 4xx without same-model retry', () => {
    expect(shouldSwitch(402)).toMatchObject({ switch: true, retrySame: false, reason: expect.stringContaining('payment') });
    expect(shouldSwitch(413)).toMatchObject({ switch: true, retrySame: false });
    expect(shouldSwitch(422)).toMatchObject({ switch: true, retrySame: false });
  });
  it('retries same model on 429/5xx', () => {
    expect(shouldSwitch(429)).toMatchObject({ switch: true, retrySame: true });
    expect(shouldSwitch(503)).toMatchObject({ switch: true, retrySame: true });
  });
  it('switches on network errors', () => {
    expect(shouldSwitch(undefined, new Error('econnrefused')).switch).toBe(true);
  });
});

describe('shouldSwitchBody (context overflow)', () => {
  it('Anthropic-style 400 "prompt is too long" is switchable, never retried uncompressed', () => {
    expect(
      shouldSwitchBody(400, '{"error":{"message":"prompt is too long: 300000 tokens > 200000 maximum"}}'),
    ).toMatchObject({ switch: true, retrySame: false });
  });

  it('OpenAI-style 400 "maximum context length" is switchable', () => {
    expect(
      shouldSwitchBody(400, "This model's maximum context length is 8192 tokens. However, your messages resulted in 20000 tokens"),
    ).toMatchObject({ switch: true, retrySame: false });
  });

  it('Google-style "exceeds the maximum number of tokens" is switchable', () => {
    expect(shouldSwitchBody(400, 'The input token count (200000) exceeds the maximum number of tokens allowed (32768)').switch).toBe(
      true,
    );
  });

  it('plain 400 stays fail-fast (client error)', () => {
    expect(shouldSwitchBody(400, '{"error":{"message":"invalid request body"}}').switch).toBe(false);
  });

  it('isContextOverflow tolerates empty/absent bodies', () => {
    expect(isContextOverflow('')).toBe(false);
    expect(isContextOverflow(undefined as unknown as string)).toBe(false);
  });

  it('quota bodies keep their own verdict (no overlap with overflow)', () => {
    expect(shouldSwitchBody(429, 'resource exhausted: per-minute limit').reason).toBe('quota exhausted');
  });
});

describe('HealthMonitor', () => {
  it('opens breaker after 3 failures and penalizes sick models', () => {
    const h = new HealthMonitor();
    h.reportFailure('m');
    h.reportFailure('m');
    expect(h.penalty('m')).toBeGreaterThan(0);
    expect(h.isOpen('m')).toBe(false);
    h.reportFailure('m');
    expect(h.isOpen('m')).toBe(true);
    h.reportSuccess('m', 100);
    expect(h.isOpen('m')).toBe(false);
  });
});
