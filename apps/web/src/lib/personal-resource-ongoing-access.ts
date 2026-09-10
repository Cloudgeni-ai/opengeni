import type { UserResourceAuthoritySummary } from "@opengeni/sdk";

/** A display fact from the exact owner catalog, not permission to execute work. */
export function ongoingPersonalResourceNames(input: {
  authorities: UserResourceAuthoritySummary[];
  resources: Array<{
    kind: "variable_set" | "rig" | "connected_machine";
    id: string;
    name: string;
  }>;
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  authorityEpoch: number;
  now: number;
}): string[] {
  return input.resources
    .filter((resource) =>
      input.authorities.some(
        (authority) =>
          authority.status === "active" &&
          authority.resourceKind === resource.kind &&
          authority.resourceId === resource.id &&
          authority.grants.some((grant) => {
            const delegation = grant.delegation;
            return (
              grant.status === "active" &&
              (grant.mode === "session" || grant.mode === "always") &&
              grant.targetWorkspaceId === input.workspaceId &&
              grant.context === "workspace_shared" &&
              (grant.expiresAt === null || Date.parse(grant.expiresAt) > input.now) &&
              (grant.mode === "session"
                ? grant.targetSessionId === input.sessionId &&
                  grant.authorityEpoch === input.authorityEpoch
                : grant.targetSessionId === null && grant.authorityEpoch === null) &&
              delegation.authorityId === authority.authorityId &&
              delegation.authorityGeneration === authority.generation &&
              delegation.grantId === grant.grantId &&
              delegation.grantGeneration === grant.generation &&
              delegation.organizationId === input.organizationId &&
              delegation.workspaceId === input.workspaceId &&
              delegation.sessionId === grant.targetSessionId &&
              delegation.authorityEpoch === grant.authorityEpoch &&
              delegation.mode === grant.mode &&
              delegation.context === grant.context &&
              grant.action === `${resource.kind}.use` &&
              delegation.action === grant.action
            );
          }),
      ),
    )
    .map((resource) => resource.name);
}
