import { resolveWorkspaceAgentDefaults, type ClientAgentConfig } from "@opengeni/contracts";

import {
  capabilityAvailability,
  capabilitySummary,
  workspaceAgentDefaultsDraft,
} from "@/lib/agent-capabilities";

/** The muted value next to Settings > General > Agent: "All capabilities". */
export function workspaceAgentDefaultsSummary(
  settings: unknown,
  clientAgentConfig: Pick<ClientAgentConfig, "capabilities"> | null | undefined,
): string {
  const defaults = resolveWorkspaceAgentDefaults(settings);
  const draft = workspaceAgentDefaultsDraft({
    capabilities: defaults?.capabilities,
    legacyHumanInputOff:
      (settings as { agentHumanInputEnabled?: unknown } | null)?.agentHumanInputEnabled === false,
  });
  return capabilitySummary(draft.values, capabilityAvailability(clientAgentConfig));
}
