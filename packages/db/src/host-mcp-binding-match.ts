import { stableJson, type McpCredentialsRequest } from "@opengeni/contracts";
import { HostMcpBinding, HostMcpBindingDefinition } from "@opengeni/contracts/host-mcp-bindings";

/** Metadata comparison only. A caller must independently establish accepted
 * execution delegation and live owner/workspace authority. A matching registry
 * row never authorizes a turn, a scheduler, or a nested session by itself. */
export function hostMcpBindingMatchesRequest(
  rawBinding: unknown,
  request: McpCredentialsRequest,
): boolean {
  const parsed = HostMcpBinding.safeParse(rawBinding);
  if (!parsed.success) return false;
  const binding = parsed.data;
  const { hostBinding, ...connectionRef } = request.connectionRef;
  if (
    !hostBinding ||
    "selection" in hostBinding ||
    binding.status !== "active" ||
    binding.revokedAt !== null ||
    binding.id !== hostBinding.bindingId ||
    binding.generation !== hostBinding.generation ||
    binding.accountId !== request.accountId ||
    binding.workspaceId !== request.workspaceId ||
    // The registry currently describes an MCP endpoint, not a REST API grant.
    request.credentialTarget !== "mcp"
  )
    return false;
  const candidate = HostMcpBindingDefinition.safeParse({
    serverId: request.serverId,
    destinationUrl: request.destinationUrl,
    connectionRef,
  });
  return candidate.success && stableJson(candidate.data) === stableJson(binding.definition);
}
