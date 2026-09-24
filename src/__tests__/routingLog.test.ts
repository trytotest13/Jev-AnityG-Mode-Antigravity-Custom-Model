/**
 * Routing activity ring buffer: capacity, ordering, and reset.
 */
import { describe, it, expect } from 'vitest';
import { recordRouting, recentRouting, clearRouting, type RoutingEvent } from '../proxy/routingLog';

function ev(n: number): RoutingEvent {
  return {
    ts: n,
    requested: 'asked-' + n,
    final: n % 2 === 0 ? 'answered-' + n : '(all failed)',
    ok: n % 2 === 0,
    attempts: n % 2 === 0 ? [{ model: 'asked-' + n, reason: '429 rate limited' }] : [],
    isStream: false,
    durationMs: n,
  };
}

beforeEach(() => clearRouting());

describe('routingLog', () => {
  it('returns most-recent-first', () => {
    recordRouting(ev(1));
    recordRouting(ev(2));
    recordRouting(ev(3));
    expect(recentRouting().map((e) => e.ts)).toEqual([3, 2, 1]);
  });

  it('caps the ring at 50 entries', () => {
    for (let i = 0; i < 60; i++) recordRouting(ev(i));
    const all = recentRouting(100);
    expect(all.length).toBe(50);
    expect(all[0].ts).toBe(59); // newest survives
    expect(all[49].ts).toBe(10); // oldest trimmed
  });

  it('honors the count limit and resets cleanly', () => {
    for (let i = 0; i < 5; i++) recordRouting(ev(i));
    expect(recentRouting(2).length).toBe(2);
    clearRouting();
    expect(recentRouting()).toEqual([]);
  });
});
