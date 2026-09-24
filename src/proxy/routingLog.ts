/**
 * Routing activity log: an in-memory ring of the last routing decisions so
 * the dashboard can show which model ACTUALLY answered each request.
 *
 * The IDE picker keeps displaying whatever the user selected, because the
 * proxy is transparent to it - when the router (or JEV recovery) switches
 * models mid-request, the only place that knows is here.
 *
 * Electron-free and unit-testable. No persistence: the log lives with the
 * proxy process, which is exactly the window the dashboard cares about.
 */

export interface RoutingAttempt {
  model: string;
  reason: string;
}

export interface RoutingJevInfo {
  tokensBefore: number;
  tokensAfter: number;
  judge: string;
}

export interface RoutingEvent {
  ts: number;
  /** What the IDE picked (display name), e.g. "Kira Mini 1.0 (Free)" or "Auto (Smart Router)". */
  requested: string;
  /** Display name of the model that actually answered, or "(all failed)". */
  final: string;
  ok: boolean;
  /** Switches before the final answer: one entry per failed model + reason. */
  attempts: RoutingAttempt[];
  isStream: boolean;
  durationMs: number;
  /** JEV compaction that ran for this request, when it did. */
  jev?: RoutingJevInfo | null;
}

const CAP = 50;
const ring: RoutingEvent[] = [];

export function recordRouting(e: RoutingEvent): void {
  ring.push(e);
  if (ring.length > CAP) ring.splice(0, ring.length - CAP);
}

/** Most recent events first. */
export function recentRouting(count = 20): RoutingEvent[] {
  return ring.slice(-count).reverse();
}

/** Test hook. */
export function clearRouting(): void {
  ring.length = 0;
}
