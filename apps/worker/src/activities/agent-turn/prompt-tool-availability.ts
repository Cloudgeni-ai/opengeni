import {
  deriveAgentPromptToolAvailability,
  type AgentPromptToolAvailability,
} from "@opengeni/runtime";
import type { FirstPartyMcpToolName, Permission, ResolvedAgentConfig } from "@opengeni/contracts";

/**
 * The frozen clause-availability view for one attempt's modular instructions.
 * Derived from the same accepted first-party selection and permission ceiling
 * the worker signs into the delegated token and hands to in-process adapters,
 * so it can only describe tools the executable catalog already excludes. It is
 * a rendering input, never authority.
 *
 * Sessions without an agent configuration keep the legacy composition, which
 * does not read availability; they receive undefined so nothing changes.
 */
export function promptToolAvailabilityForTurn(input: {
  agentConfig: ResolvedAgentConfig | null | undefined;
  selectedFirstPartyMcpTools: readonly FirstPartyMcpToolName[];
  firstPartyPermissions: readonly Permission[] | null | undefined;
}): AgentPromptToolAvailability | undefined {
  if (!input.agentConfig) return undefined;
  return deriveAgentPromptToolAvailability({
    selectedFirstPartyTools: input.selectedFirstPartyMcpTools,
    firstPartyPermissions: input.firstPartyPermissions,
  });
}
