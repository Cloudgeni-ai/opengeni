import type { TurnHistorySink } from "./history-sink";
import type { Settings } from "@opengeni/config";

export class SandboxCapabilitiesChangedError extends Error {
  readonly code = "native_capabilities_changed_this_attempt";

  constructor() {
    super("The attached sandbox requires rebuilding this attempt's native capabilities.");
    this.name = "SandboxCapabilitiesChangedError";
  }
}

type ActiveRoutePointer = { activeSandboxId: string | null; activeEpoch: number };

/**
 * Ends an attempt between tool batches when its route moved somewhere it can
 * no longer serve. A swap to a machine with another workspace root (or back
 * to a home this attempt cannot reach) used to surface only on the first
 * sandbox call of the following batch: the model's whole next response was
 * discarded with the attempt, including sibling calls that had already run.
 * Checking before the next model request ends the attempt at a clean point
 * instead: the batch that moved the route is complete and durable, and the
 * next attempt starts on the new route.
 */
export class ActiveRouteDispatchBoundary {
  private observed: ActiveRoutePointer | null = null;

  constructor(
    private readonly deps: {
      /** The attempt's routed sandbox session, once one is established. */
      session: () => { assertActiveRouteContinuable?: () => Promise<void> } | null | undefined;
      /** True for a typed transition that must continue in a fresh attempt. */
      isRouteTransition: (error: unknown) => boolean;
    },
  ) {}

  async check(active: ActiveRoutePointer | null): Promise<void> {
    const current = active ?? { activeSandboxId: null, activeEpoch: 0 };
    const previous = this.observed;
    this.observed = { activeSandboxId: current.activeSandboxId, activeEpoch: current.activeEpoch };
    if (
      !previous ||
      (previous.activeSandboxId === current.activeSandboxId &&
        previous.activeEpoch === current.activeEpoch)
    )
      return;
    const session = this.deps.session();
    if (!session?.assertActiveRouteContinuable) return;
    try {
      await session.assertActiveRouteContinuable();
    } catch (error) {
      // Any other resolution failure (an offline machine, say) stays with the
      // next operation that needs the route, exactly as before.
      if (this.deps.isRouteTransition(error)) throw error;
    }
  }
}

/**
 * Persist the SDK's complete prior model/tool history before another provider
 * request can start. The first request has no prior model/tool rows to append.
 * Follow-up requests run only after the preceding complete call/result batch is
 * replay-safe. A route that moved during that batch to somewhere this attempt
 * cannot serve ends the attempt here, after the batch is durable.
 */
export async function checkpointHistoryBeforeProviderDispatch(
  historySink: Pick<TurnHistorySink, "reconcileConversationTruth">,
  route?: {
    effectiveSandboxBackend: Settings["sandboxBackend"];
    routingEnabled: boolean;
    readActiveSandbox: () => Promise<ActiveRoutePointer | null>;
    activeRoute?: ActiveRouteDispatchBoundary;
  },
): Promise<void> {
  await historySink.reconcileConversationTruth({ requireDurable: true });
  if (!route?.routingEnabled) return;
  // A plain Agent cannot acquire SandboxAgent capabilities in place. Preserve
  // its completed tool batch before recovering the same logical turn; the next
  // attempt resolves and authorizes the route normally.
  if (route.effectiveSandboxBackend === "none") {
    const active = await route.readActiveSandbox();
    if (active?.activeSandboxId) throw new SandboxCapabilitiesChangedError();
    return;
  }
  if (route.activeRoute) await route.activeRoute.check(await route.readActiveSandbox());
}
