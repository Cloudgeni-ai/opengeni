import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  FIRST_PARTY_MCP_TOOL_NAMES,
  FIRST_PARTY_TOOL_AUTHORIZATION,
  type FirstPartyMcpToolName,
  type FirstPartyToolAuthorization,
  type Permission,
} from "@opengeni/contracts";
import type { AgentPromptToolAvailability } from "./types";

export type AgentPromptToolAvailabilityInput = {
  /**
   * The attempt's accepted first-party selection after deployment ceilings and
   * capability gating: the same list the worker signs into the delegated token
   * and uses for in-process first-party adapters.
   */
  selectedFirstPartyTools: readonly FirstPartyMcpToolName[];
  /**
   * The attempt's first-party permission ceiling. Null or undefined means the
   * default ceiling, exactly as the delegated token is signed.
   */
  firstPartyPermissions?: readonly Permission[] | null | undefined;
};

/**
 * A permission the live grant could still hold under the ceiling. Legacy grants
 * treat `workspace:admin` as a superset; counting it keeps the check on the
 * side of "possibly admitted", so only a certain miss becomes proof.
 */
function possiblyHeld(ceiling: readonly Permission[], permission: Permission): boolean {
  return ceiling.includes(permission) || ceiling.includes("workspace:admin");
}

function ceilingCanAdmit(
  ceiling: readonly Permission[],
  policy: FirstPartyToolAuthorization,
): boolean {
  return (
    (policy.allOf?.every((permission) => possiblyHeld(ceiling, permission)) ?? true) &&
    (policy.anyOf?.some((permission) => possiblyHeld(ceiling, permission)) ?? true)
  );
}

/**
 * Derives the frozen clause-availability view for one attempt. A first-party
 * tool is proven absent when the accepted selection omits it or the permission
 * ceiling cannot satisfy its registration predicate (the same table the API's
 * first-party MCP server uses to admit it). Live grants can be narrower than
 * the ceiling; that remains unknown and keeps guidance.
 *
 * Only first-party names can be proven absent. Deferred disclosure, lazy tool
 * search, external MCP catalogs and runtime adapters are never inspected, so
 * their guidance always stays. The result is sorted and depends only on its
 * inputs, so an unchanged selection renders an unchanged instruction prefix.
 */
export function deriveAgentPromptToolAvailability(
  input: AgentPromptToolAvailabilityInput,
): AgentPromptToolAvailability {
  const selected = new Set<string>(input.selectedFirstPartyTools);
  const ceiling = input.firstPartyPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  const unavailable = FIRST_PARTY_MCP_TOOL_NAMES.filter(
    (name) =>
      !selected.has(name) || !ceilingCanAdmit(ceiling, FIRST_PARTY_TOOL_AUTHORIZATION[name]),
  );
  return { unavailable: [...new Set(unavailable)].sort() };
}
