import { stableJson, executableToolSchema } from "@opengeni/contracts";
import type { StoredApiIntegrationRevision } from "./capability-integrations";

export function apiIntegrationToolEffect(revision: StoredApiIntegrationRevision, toolId: string) {
  const tool = revision.tools.find((candidate) => candidate.id === toolId);
  const binding = tool && revision.bindings[tool.id];
  if (!tool || !binding) return null;
  return stableJson({
    protocol: revision.protocol,
    operationKey: tool.operationKey,
    inputSchema: executableToolSchema(tool.inputSchema),
    outputSchema: executableToolSchema(tool.outputSchema),
    safety: tool.safety,
    approvalMode: tool.approvalMode,
    deprecated: tool.deprecated,
    binding:
      revision.protocol === "openapi"
        ? {
            ...binding,
            ...("parameters" in binding
              ? {
                  parameters: binding.parameters.map(
                    ({ description: _description, ...parameter }) => parameter,
                  ),
                }
              : {}),
          }
        : binding,
  });
}

export function apiIntegrationToolMeaningUnchanged(
  previous: StoredApiIntegrationRevision | null,
  next: StoredApiIntegrationRevision,
  toolId: string,
): boolean {
  return (
    previous !== null &&
    apiIntegrationToolEffect(previous, toolId) !== null &&
    apiIntegrationToolEffect(previous, toolId) === apiIntegrationToolEffect(next, toolId)
  );
}

/** Omission preserves a choice only for the same account and executable meaning.
 * An explicit list (including []) replaces the legacy auto-approval selection. */
export function apiIntegrationRequiredApprovals(input: {
  revision: StoredApiIntegrationRevision;
  previousRevision: StoredApiIntegrationRevision | null;
  selectedTools: readonly string[];
  previousConfig: Record<string, unknown> | null;
  sameAuthority: boolean;
  autoApprovedTools?: readonly string[];
}): string[] {
  const requested = input.autoApprovedTools;
  if (requested?.some((id) => !input.selectedTools.includes(id))) {
    throw new Error("API Integration auto-approved a tool that is not selected");
  }
  const oldTools = input.previousConfig?.allowedTools;
  const oldRequired = input.previousConfig?.requireApproval;
  return input.revision.tools
    .filter((tool) => {
      if (!input.selectedTools.includes(tool.id)) return false;
      if (requested !== undefined)
        return tool.approvalMode === "ask" && !requested.includes(tool.id);
      if (
        input.sameAuthority &&
        input.previousRevision &&
        Array.isArray(oldTools) &&
        oldTools.includes(tool.id) &&
        (oldRequired === true || Array.isArray(oldRequired)) &&
        apiIntegrationToolMeaningUnchanged(input.previousRevision, input.revision, tool.id)
      ) {
        return oldRequired === true || oldRequired.includes(tool.id);
      }
      return tool.approvalMode === "ask";
    })
    .map((tool) => tool.id);
}
