/**
 * A turn settlement or Steer handover slower than this is logged with its
 * phase timing. The next turn, a Steer's replacement among them, cannot start
 * before the settlement commits.
 */
export const SLOW_TURN_SETTLEMENT_MS = 1_000;

/** Measures consecutive phases: each mark records the time since the last. */
export function createPhaseTimer(now: () => number = () => performance.now()) {
  const startedAt = now();
  let lastAt = startedAt;
  const phases: Record<string, number> = {};
  return {
    mark(phase: string): void {
      const at = now();
      phases[phase] = Math.round(at - lastAt);
      lastAt = at;
    },
    phases(): Record<string, number> {
      return { ...phases };
    },
    totalMs(): number {
      return Math.round(lastAt - startedAt);
    },
  };
}
