// The broker-independent durable event recovery contract.
/**
 * Versioned recovery contract for already-durable session-event fanout.
 *
 * A publisher acknowledgement alone cannot prove that every API subscriber was
 * connected for the live message. Supported broker-backed buses must therefore
 * notify consumers after transport subscriptions have been restored so an
 * already-open SSE stream can run one bounded Postgres catch-up. A bus that can
 * never disconnect may implement this as a listener registry that never fires.
 */
export const SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION = 1 as const;

export type SessionEventDurableFanoutCapability = {
  version: typeof SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION;
  subscribeRecovery: (onRecovery: (generation: number) => void) => () => void;
};

export function requireSessionEventDurableFanoutCapability(
  bus: unknown,
): SessionEventDurableFanoutCapability {
  const capability = (bus as { sessionEventDurableFanout?: unknown } | null)
    ?.sessionEventDurableFanout as
    | { version?: unknown; subscribeRecovery?: unknown }
    | null
    | undefined;
  if (
    capability?.version !== SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION ||
    typeof capability.subscribeRecovery !== "function"
  ) {
    throw new Error(
      "EventBus must provide sessionEventDurableFanout v1 so accepted durable publications reconcile after subscriber reconnect",
    );
  }
  return capability as SessionEventDurableFanoutCapability;
}
