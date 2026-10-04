import type { McpConnectionAccountBinding, ToolAuthNeededPayload } from "@opengeni/contracts";

export function accountRouteAuthNeededPayload(
  payload: ToolAuthNeededPayload,
  bindings: readonly McpConnectionAccountBinding[] | null | undefined,
): ToolAuthNeededPayload {
  const binding = bindings?.find((candidate) => candidate.serverId === payload.serverId);
  return binding
    ? {
        ...payload,
        canonicalServerId: binding.canonicalServerId,
        connectionSubjectScope: binding.subjectScope,
      }
    : payload;
}

export { expandMcpAccountRoutes, expandApiIntegrationAccountRoutes } from "@opengeni/core";
