import {
  deriveAgentPromptToolAvailability,
  type AgentPromptToolAvailability,
} from "@opengeni/runtime";
import type {
  AgentLearningDefaults,
  FirstPartyMcpToolName,
  Permission,
  ResolvedAgentConfig,
} from "@opengeni/contracts";

/**
 * Tools that author Knowledge. With the turn's effective Knowledge learning
 * mode Off, every call is refused (docs/knowledge.md: the stricter of the
 * chat's and the destination's mode governs), so guidance naming them only
 * describes calls that cannot succeed.
 */
const KNOWLEDGE_AUTHORING_TOOLS = [
  "knowledge_save",
  "knowledge_prepare_save",
  "knowledge_retain_message",
  "knowledge_retain_file",
  "knowledge_archive",
  "task_note_promote_knowledge",
] as const satisfies readonly FirstPartyMcpToolName[];

/** With workspace-instruction learning Off, an agent instruction change is refused. */
const INSTRUCTION_AUTHORING_TOOLS = [
  "instruction_policy_save",
] as const satisfies readonly FirstPartyMcpToolName[];

/**
 * The frozen clause-availability view for one attempt's modular instructions.
 * Derived from the same accepted first-party selection and permission ceiling
 * the worker signs into the delegated token and hands to in-process adapters,
 * so it can only describe tools the executable catalog already excludes. It is
 * a rendering input, never authority.
 *
 * The turn's frozen learning modes are a rendering input too: with a category
 * Off, its authoring clauses are omitted as if those tools were absent. The
 * tools themselves stay in the catalog and still answer with the refusal, so
 * nothing executable changes. Learning settings change rarely, so the prefix
 * stays stable between turns.
 *
 * Sessions without an agent configuration keep the legacy composition, which
 * does not read availability; they receive undefined so nothing changes.
 */
export function promptToolAvailabilityForTurn(input: {
  agentConfig: ResolvedAgentConfig | null | undefined;
  selectedFirstPartyMcpTools: readonly FirstPartyMcpToolName[];
  firstPartyPermissions: readonly Permission[] | null | undefined;
  /** Frozen on the session; an exhausted depth hides `session_create`. */
  nestedAgentDepth?: number | undefined;
  effectiveMaxNestedAgentDepth?: number | undefined;
  /** The accepted turn's effective learning modes; omitted keeps every clause. */
  learning?: AgentLearningDefaults | undefined;
}): AgentPromptToolAvailability | undefined {
  if (!input.agentConfig) return undefined;
  const availability = deriveAgentPromptToolAvailability({
    selectedFirstPartyTools: input.selectedFirstPartyMcpTools,
    firstPartyPermissions: input.firstPartyPermissions,
    nestedAgentDepth: input.nestedAgentDepth,
    effectiveMaxNestedAgentDepth: input.effectiveMaxNestedAgentDepth,
  });
  const refused: FirstPartyMcpToolName[] = [
    ...(input.learning?.knowledge === "off" ? KNOWLEDGE_AUTHORING_TOOLS : []),
    ...(input.learning?.instructions === "off" ? INSTRUCTION_AUTHORING_TOOLS : []),
  ];
  if (refused.length === 0) return availability;
  return {
    ...availability,
    unavailable: [...new Set([...availability.unavailable, ...refused])].sort(),
  };
}
