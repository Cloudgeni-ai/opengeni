import { describe, expect, test } from "bun:test";
import {
  OrganizationMembershipProjection,
  ResourceAuthorityEnvelope,
  ResourceAuthorityListScope,
  ResourceAuthorityScope,
  SessionTenancyProjection,
  UserResourceAuthorityProjection,
  UserResourceDelegation,
  UserResourceGrantProjection,
} from "../src";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  session: "00000000-0000-4000-8000-000000000003",
  membership: "00000000-0000-4000-8000-000000000004",
  authority: "00000000-0000-4000-8000-000000000005",
  grant: "00000000-0000-4000-8000-000000000006",
  resourceVersion: "00000000-0000-4000-8000-000000000007",
};

describe("organization tenancy foundation contracts", () => {
  test("names organization/workspace/user scopes without widening legacy omission", () => {
    expect(ResourceAuthorityScope.options).toEqual(["organization", "workspace", "user"]);
    expect(ResourceAuthorityListScope.options).toEqual([
      "effective",
      "organization",
      "workspace",
      "user",
    ]);

    expect(ResourceAuthorityEnvelope.parse({})).toEqual({ scope: "workspace" });
    expect(ResourceAuthorityEnvelope.safeParse({ scope: "user" }).success).toBe(false);
    expect(
      ResourceAuthorityEnvelope.safeParse({
        scope: "workspace",
        userDelegation: {
          authorityId: ids.authority,
          grantId: ids.grant,
          workspaceId: ids.workspace,
          sessionId: ids.session,
          mode: "session",
          context: "user_private",
          authorityEpoch: 1,
          authorityGeneration: 1,
          grantGeneration: 1,
        },
      }).success,
    ).toBe(false);
  });

  test("keeps immutable delegations opaque and free of owner identity or credentials", () => {
    const delegation = UserResourceDelegation.parse({
      authorityId: ids.authority,
      grantId: ids.grant,
      workspaceId: ids.workspace,
      sessionId: ids.session,
      mode: "once",
      context: "workspace_shared",
      authorityEpoch: 3,
      authorityGeneration: 4,
      grantGeneration: 5,
      resourceVersionId: ids.resourceVersion,
      ownerSubjectId: "must-not-survive",
      credential: "must-not-survive",
    });

    expect(delegation).toEqual({
      authorityId: ids.authority,
      grantId: ids.grant,
      workspaceId: ids.workspace,
      sessionId: ids.session,
      mode: "once",
      context: "workspace_shared",
      authorityEpoch: 3,
      authorityGeneration: 4,
      grantGeneration: 5,
      resourceVersionId: ids.resourceVersion,
    });
    expect(JSON.stringify(delegation)).not.toContain("owner");
    expect(JSON.stringify(delegation)).not.toContain("credential");
  });

  test("projects only opaque self/authority/grant facts", () => {
    const membership = OrganizationMembershipProjection.parse({
      id: ids.membership,
      organizationId: ids.organization,
      status: "active",
      personalWorkspaceId: ids.workspace,
      personalRetentionUntil: null,
      subjectId: "must-not-survive",
    });
    const authority = UserResourceAuthorityProjection.parse({
      id: ids.authority,
      organizationId: ids.organization,
      scope: "user",
      resourceKind: "variable_set",
      originWorkspaceId: ids.workspace,
      generation: 1,
      status: "active",
      organizationMembershipId: ids.membership,
      ownerSubjectId: "must-not-survive",
    });
    const grant = UserResourceGrantProjection.parse({
      id: ids.grant,
      authorityId: ids.authority,
      workspaceId: ids.workspace,
      sessionId: ids.session,
      mode: "session",
      context: "user_private",
      authorityEpoch: 1,
      generation: 1,
      status: "active",
      expiresAt: null,
      ownerSubjectId: "must-not-survive",
    });
    const session = SessionTenancyProjection.parse({
      visibility: "workspace_shared",
      authorityEpoch: 2,
      ownedByCurrentUser: true,
      fork: {
        sourceVisibility: "user_private",
        sourceAuthorityEpoch: 1,
        forkedAt: "2026-08-11T00:00:00.000Z",
      },
      ownerOrganizationMembershipId: ids.membership,
    });

    const serialized = JSON.stringify({ membership, authority, grant, session });
    expect(serialized).not.toContain("subjectId");
    expect(serialized).not.toContain("organizationMembershipId");
    expect(serialized).not.toContain("ownerOrganizationMembershipId");
  });
});
