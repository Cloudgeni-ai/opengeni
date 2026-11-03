import { HARNESS_CONTROL_FIRST_PARTY_TOOLS, isAlwaysVisibleBaseToolName } from "@opengeni/runtime";
import type { FirstPartyMcpToolName, ResolvedAgentConfig, ToolRef } from "@opengeni/contracts";

const HARNESS_CONTROL: ReadonlySet<string> = new Set(HARNESS_CONTROL_FIRST_PARTY_TOOLS);
const INTERACTION_ENTRY_MODEL_NAMES: ReadonlySet<string> = new Set([
  "interaction__browser_open",
  "interaction__computer_open",
]);

/**
 * Whether a configured attempt may defer any tool behind search, decided from
 * frozen per-turn facts before the first request. `false` is a proof that
 * every attached tool is in the first request: then the search router and the
 * tool discovery instructions are left out, and `set_session_title` (deferred
 * on every turn after the session has a title, while Opengeni titles the
 * session itself) is not attached on its own, so it never brings the router
 * back. Any doubt answers `true`, which keeps today's behaviour; a wrong
 * `false` would only cost schemas in the first request, because tools that
 * turn out searchable still expose the router.
 */
export function turnToolRouterExpected(input: {
  agentConfig: ResolvedAgentConfig | null | undefined;
  /** Durable router use: once exposed, the router stays. */
  routerInHistory: boolean;
  /** The attempt's MCP refs as prepared (ToolRef.eager decides first-request visibility). */
  toolRefs: readonly ToolRef[];
  /** First-party tools the prepared `opengeni` server lists, before the title rule. */
  remoteFirstPartyTools: readonly FirstPartyMcpToolName[];
  /** Model names of the attempt's function tools (already capability filtered). */
  functionToolNames: readonly string[];
  /** Tools the host keeps in the first request regardless of origin. */
  preparationIndependentToolNames: readonly string[];
  /** Media tools (image and video generation) are built by the runtime and searchable. */
  mediaTools: boolean;
}): boolean {
  if (!input.agentConfig || input.routerInHistory || input.mediaTools) return true;
  const independent = new Set(input.preparationIndependentToolNames);
  const opengeni = input.toolRefs.find((ref) => ref.kind === "mcp" && ref.id === "opengeni");
  const opengeniEager = opengeni?.eager === true;
  const opengeniEagerNames = new Set(Array.isArray(opengeni?.eager) ? opengeni.eager : []);
  for (const ref of input.toolRefs) {
    if (ref.kind !== "mcp" || ref.id === "opengeni") continue;
    if (ref.eager !== true) return true;
  }
  if (opengeni && !opengeniEager) {
    for (const name of input.remoteFirstPartyTools) {
      if (name === "set_session_title") continue;
      if (HARNESS_CONTROL.has(name) || opengeniEagerNames.has(name)) continue;
      return true;
    }
  }
  for (const name of input.functionToolNames) {
    if (isAlwaysVisibleBaseToolName(name) || independent.has(name)) continue;
    if (INTERACTION_ENTRY_MODEL_NAMES.has(name)) continue;
    return true;
  }
  return false;
}
