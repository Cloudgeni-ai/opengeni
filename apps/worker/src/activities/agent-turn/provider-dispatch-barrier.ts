import type { TurnHistorySink } from "./history-sink";
import type { Settings } from "@opengeni/config";

export class SandboxCapabilitiesChangedError extends Error {
  readonly code = "native_capabilities_changed_this_attempt";

  constructor() {
    super("The attached sandbox requires rebuilding this attempt's native capabilities.");
    this.name = "SandboxCapabilitiesChangedError";
  }
}

/**
 * Persist the SDK's complete prior model/tool history before another provider
 * request can start. The first request has no prior model/tool rows to append.
 * Follow-up requests run only after the preceding complete call/result batch is
 * replay-safe.
 */
export async function checkpointHistoryBeforeProviderDispatch(
  historySink: Pick<TurnHistorySink, "reconcileConversationTruth">,
  route?: {
    effectiveSandboxBackend: Settings["sandboxBackend"];
    routingEnabled: boolean;
    readActiveSandbox: () => Promise<{ activeSandboxId: string | null } | null>;
  },
): Promise<void> {
  await historySink.reconcileConversationTruth({ requireDurable: true });
  // A plain Agent cannot acquire SandboxAgent capabilities in place. Preserve
  // its completed tool batch before recovering the same logical turn; the next
  // attempt resolves and authorizes the route normally.
  if (route?.effectiveSandboxBackend === "none" && route.routingEnabled) {
    const active = await route.readActiveSandbox();
    if (active?.activeSandboxId) throw new SandboxCapabilitiesChangedError();
  }
}
