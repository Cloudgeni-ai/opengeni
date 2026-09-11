import type { Settings } from "@opengeni/config";
import type { AttemptToolEnvironment } from "@opengeni/codemode";
import { digestCanonicalJson } from "@opengeni/tool-gateway";
import {
  runMcpOperationObservationWithAuthority,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/runtime";
import type { McpOperationReaderDependencies } from "./mcp-operation-reader";

/** Current-attempt adapter: no credential renewal authority survives this
 * closure. The stored digest constrains fresh authority, never establishes it. */
export function createMcpOperationObserverResolver(input: {
  settings: Pick<Settings, "mcpServers">;
  workspaceId: string;
  credentialSubjectId?: string;
  assertAttempt: () => Promise<void>;
  resolveCredential: (
    request: ResolveConnectionCredentialInput,
  ) => Promise<ResolveConnectionCredentialResult>;
  getEnvironment: () => Promise<AttemptToolEnvironment | null>;
}): McpOperationReaderDependencies["resolveObserver"] {
  return async (operation) => {
    await input.assertAttempt();
    const configured = input.settings.mcpServers.find(
      (candidate) => candidate.id === operation.serverId,
    );
    const recovery = configured?.operationRecovery?.[operation.originalTool];
    if (!configured?.connectionRef || !recovery) return { status: "unsupported" };
    const destinationUrl = new URL(configured.url).toString();
    if (
      recovery.observerTool !== operation.observerTool ||
      digestCanonicalJson(destinationUrl) !== operation.destinationDigest
    ) {
      return { status: "binding_changed" };
    }
    const connectionRef = structuredClone(configured.connectionRef);
    const environment = await input.getEnvironment();
    const observerEntry = environment?.catalog.entries.find(
      (entry) =>
        entry.identity.serverId === operation.serverId &&
        entry.identity.toolName === operation.observerTool,
    );
    if (!environment || !observerEntry) return { status: "unsupported" };

    const authorize = async () => {
      await input.assertAttempt();
      const resolved = await input.resolveCredential({
        workspaceId: input.workspaceId,
        serverId: operation.serverId,
        toolName: operation.observerTool,
        connectionRef,
        destinationUrl,
        forceRefresh: false,
        ...(input.credentialSubjectId ? { subjectId: input.credentialSubjectId } : {}),
      });
      // This is credential-resolution authorization. The actual broker keeps
      // ownership of the physical provider-request authorization/audit fact.
      return (
        resolved.status === "ok" && resolved.operationAuthorityDigest === operation.authorityDigest
      );
    };
    if (!(await authorize())) return { status: "auth_needed" };
    return {
      status: "ready",
      authorize,
      callObserver: async (tool, args) => {
        if (tool !== operation.observerTool) throw new Error("MCP observer binding changed");
        return await runMcpOperationObservationWithAuthority(
          {
            serverId: operation.serverId,
            observerTool: operation.observerTool,
            destinationDigest: operation.destinationDigest,
            authorityDigest: operation.authorityDigest,
          },
          async () =>
            await environment.callModel({
              modelName: observerEntry.modelName,
              arguments: args,
              subjectId: "worker:first-party-mcp",
            }),
        );
      },
    };
  };
}
