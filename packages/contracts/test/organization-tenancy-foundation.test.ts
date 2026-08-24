import { describe, expect, test } from "bun:test";
import {
  AddOrganizationWorkspaceMemberRequest,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  ListManagedOrganizationMembershipsResponse,
  ManagedOrganizationMembershipProjection,
  OrganizationMembershipProjection,
  OrganizationPrivateSessionSettings,
  ResourceAuthorityEnvelope,
  ResourceAuthorityListScope,
  ResourceAuthorityScope,
  SessionTenancyProjection,
  UserResourceAuthorityProjection,
  UserResourceDelegation,
  UserResourceGrantProjection,
  UpdateOrganizationPrivateSessionSettingsRequest,
  IssueUserResourceGrantRequest,
  ListUserResourceAuthoritiesQuery,
  ListUserResourceAuthoritiesResponse,
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
  test("keeps private-session organization settings versioned and strict", () => {
    expect(
      OrganizationPrivateSessionSettings.parse({
        organizationId: ids.organization,
        enabled: false,
        available: true,
        version: 0,
        updatedAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toMatchObject({ enabled: false, available: true, version: 0 });
    expect(
      UpdateOrganizationPrivateSessionSettingsRequest.safeParse({
        enabled: true,
        expectedVersion: 0,
        operationId: ids.authority,
        membershipId: ids.membership,
      }).success,
    ).toBe(false);
  });

  test("assigns an existing organization membership to a shared workspace", () => {
    expect(
      AddOrganizationWorkspaceMemberRequest.parse({
        organizationMembershipId: ids.membership,
        role: "admin",
        permissions: ["workspace:admin"],
      }),
    ).toEqual({
      organizationMembershipId: ids.membership,
      role: "admin",
      permissions: ["workspace:admin"],
    });
    expect(
      AddOrganizationWorkspaceMemberRequest.safeParse({
        organizationMembershipId: "user@example.test",
        permissions: ["workspace:read"],
      }).success,
    ).toBe(false);
  });

  test("bounds self-service organization creation and returns its initial workspace", () => {
    const operationId = "00000000-0000-4000-8000-000000000008";
    expect(CreateOrganizationRequest.parse({ name: "  Product team  ", operationId })).toEqual({
      name: "Product team",
      operationId,
    });
    expect(CreateOrganizationRequest.safeParse({ name: " ", operationId }).success).toBe(false);
    expect(
      CreateOrganizationResponse.parse({
        organization: {
          id: ids.organization,
          name: "Product team",
          createdAt: "2026-08-24T08:00:00.000Z",
          updatedAt: "2026-08-24T08:00:00.000Z",
        },
        workspaceId: ids.workspace,
      }),
    ).toMatchObject({ workspaceId: ids.workspace });
  });

  test("requires explicit user scope and durable shared-output acknowledgement", () => {
    expect(ListUserResourceAuthoritiesQuery.safeParse({}).success).toBe(false);
    expect(ListUserResourceAuthoritiesQuery.parse({ scope: "user", resourceKind: "rig" })).toEqual({
      scope: "user",
      resourceKind: "rig",
      limit: 50,
    });
    expect(
      IssueUserResourceGrantRequest.parse({
        scope: "user",
        resourceKind: "rig",
        mode: "always",
        context: "workspace_shared",
        workspaceSharedAcknowledged: true,
      }),
    ).toMatchObject({ scope: "user", workspaceSharedAcknowledged: true });
  });

  test("keeps lifecycle lists opaque", () => {
    const result = ListUserResourceAuthoritiesResponse.parse({
      scope: "user",
      nextCursor: null,
      authorities: [
        {
          authorityId: ids.authority,
          resourceKind: "rig",
          resourceId: ids.resourceVersion,
          originWorkspaceId: ids.workspace,
          generation: 1,
          status: "active",
          ownerSubjectId: "must-not-survive",
          grants: [
            {
              grantId: ids.grant,
              targetWorkspaceId: ids.workspace,
              targetSessionId: null,
              action: "rig.use",
              mode: "always",
              context: "user_private",
              authorityEpoch: null,
              generation: 1,
              status: "active",
              expiresAt: null,
              delegation: {
                authorityId: ids.authority,
                grantId: ids.grant,
                organizationId: ids.organization,
                workspaceId: ids.workspace,
                sessionId: null,
                action: "rig.use",
                mode: "always",
                context: "user_private",
                authorityEpoch: null,
                authorityGeneration: 1,
                grantGeneration: 1,
              },
              membershipId: ids.membership,
              secret: "must-not-survive",
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ownerSubjectId");
    expect(serialized).not.toContain("membershipId");
    expect(serialized).not.toContain("secret");
  });
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
          organizationId: ids.organization,
          workspaceId: ids.workspace,
          sessionId: ids.session,
          action: "resource.use",
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
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      sessionId: ids.session,
      action: "resource.use",
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
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      sessionId: ids.session,
      action: "resource.use",
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
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      sessionId: ids.session,
      action: "resource.use",
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

  test("projects only exact managed-human bootstrap facts", () => {
    const membership = ManagedOrganizationMembershipProjection.parse({
      id: ids.membership,
      organizationId: ids.organization,
      status: "active",
      personalWorkspaceId: ids.workspace,
      subjectId: "must-not-survive",
      personalRetentionUntil: "2026-09-13T00:00:00.000Z",
    });

    expect(membership).toEqual({
      id: ids.membership,
      organizationId: ids.organization,
      status: "active",
      personalWorkspaceId: ids.workspace,
    });
    expect(ListManagedOrganizationMembershipsResponse.parse({ memberships: [membership] })).toEqual(
      { memberships: [membership] },
    );
  });

  test("rejects illegal grant fences and allows only exact standing/session forms", () => {
    const base = {
      authorityId: ids.authority,
      grantId: ids.grant,
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      action: "resource.use",
      context: "workspace_shared" as const,
      authorityGeneration: 1,
      grantGeneration: 1,
    };

    expect(
      UserResourceDelegation.safeParse({
        ...base,
        sessionId: null,
        mode: "once",
        authorityEpoch: null,
      }).success,
    ).toBe(false);
    expect(
      UserResourceDelegation.safeParse({
        ...base,
        sessionId: null,
        mode: "session",
        authorityEpoch: null,
      }).success,
    ).toBe(false);
    expect(
      UserResourceDelegation.safeParse({
        ...base,
        sessionId: ids.session,
        mode: "always",
        authorityEpoch: 1,
      }).success,
    ).toBe(false);
    expect(
      UserResourceDelegation.safeParse({
        ...base,
        sessionId: ids.session,
        mode: "session",
        authorityEpoch: null,
      }).success,
    ).toBe(false);

    expect(
      UserResourceDelegation.safeParse({
        ...base,
        sessionId: ids.session,
        mode: "once",
        authorityEpoch: 1,
      }).success,
    ).toBe(true);
    expect(
      UserResourceDelegation.safeParse({
        ...base,
        sessionId: null,
        mode: "always",
        authorityEpoch: null,
      }).success,
    ).toBe(true);
  });
});
