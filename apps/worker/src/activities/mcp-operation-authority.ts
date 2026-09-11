import { createHash } from "node:crypto";
import { stableJson } from "@opengeni/contracts";
import type { ConnectionUseAttribution } from "@opengeni/contracts/connection-authority";
import type { HostMcpAcceptedAuthority } from "@opengeni/contracts/host-mcp-bindings";
import type { ResolveConnectionCredentialInput } from "@opengeni/db";

/** Metadata only. Callers must obtain authority from a current live fence.
 * This equality key is never authorization and never replaces physical-use checks. */
export function mcpOperationAuthorityDigest(
  request: ResolveConnectionCredentialInput,
  authority:
    | {
        native: ConnectionUseAttribution;
        host?: never;
        principal?: { kind: string; subjectId?: string };
      }
    | { host: HostMcpAcceptedAuthority; native?: never },
): string {
  const n = authority.native;
  const h = authority.host;
  const ref = request.connectionRef;
  const metadata = {
    version: 1,
    serverId: request.serverId,
    destinationUrl: request.destinationUrl,
    credentialTarget: request.credentialTarget ?? "mcp",
    connectionRef: {
      authoritySource: ref.authoritySource,
      connectionId: ref.connectionId,
      provider: ref.provider,
      providerDomain: ref.providerDomain,
      kind: ref.kind,
      subjectScope: ref.subjectScope,
      hostBinding: ref.hostBinding,
      scopes: ref.scopes ? [...ref.scopes].sort() : undefined,
      resource: ref.resource,
      selectedResources: ref.selectedResources
        ? [...ref.selectedResources].sort((a, b) =>
            stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0,
          )
        : undefined,
    },
    native: n
      ? {
          organizationId: n.organizationId,
          workspaceId: n.workspaceId,
          sessionId: n.sessionId,
          connectionId: n.connectionId,
          connectionGeneration: n.connectionGeneration,
          scope: n.scope,
          ownerSubjectId: n.ownerSubjectId,
          authorityId: n.authorityId,
          grantId: n.grantId,
          principal: "principal" in authority ? authority.principal : undefined,
        }
      : undefined,
    host: h
      ? {
          accountId: h.accountId,
          workspaceId: h.workspaceId,
          targetSessionId: h.targetSessionId,
          targetSessionVisibility: h.targetSessionVisibility,
          targetSessionAuthorityEpoch: h.targetSessionAuthorityEpoch,
          ownerSubjectId: h.ownerSubjectId,
          ownerOrganizationMembershipId: h.ownerOrganizationMembershipId,
          ownerMembershipAuthorizationRevision: h.ownerMembershipAuthorizationRevision,
          bindingId: h.bindingId,
          bindingGeneration: h.bindingGeneration,
          definition: h.definition,
          delegationId: h.delegationId,
          delegationGeneration: h.delegationGeneration,
        }
      : undefined,
  };
  return createHash("sha256").update(stableJson(metadata)).digest("hex");
}
