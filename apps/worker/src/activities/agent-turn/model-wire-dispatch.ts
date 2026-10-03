import type { ModelTransportDispatchClock } from "@opengeni/runtime";

type DispatchIdentity = { provider: string; dispatchId: string };

/** One immutable physical fetch-entry observation per worker attempt. Generic
 * fallback events already carry that attempt's dispatch/execution identity. */
export class InitialModelWireDispatchClock {
  private initial: (DispatchIdentity & { initialWireDispatchedAt: string }) | null = null;

  record(identity: DispatchIdentity, clock: ModelTransportDispatchClock): void {
    if (this.initial !== null) return;
    const timestamp = new Date(clock.dispatchedAtUnixMs);
    if (!Number.isFinite(timestamp.getTime())) return;
    this.initial = { ...identity, initialWireDispatchedAt: timestamp.toISOString() };
  }

  payload(identity: DispatchIdentity): { initialWireDispatchedAt?: string } {
    if (
      this.initial === null ||
      this.initial.provider !== identity.provider ||
      this.initial.dispatchId !== identity.dispatchId
    ) {
      return {};
    }
    return { initialWireDispatchedAt: this.initial.initialWireDispatchedAt };
  }
}
