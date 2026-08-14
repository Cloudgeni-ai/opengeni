import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata, McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
} from "@opengeni/contracts/google-drive";
import type { ResolveConnectionCredentialInput } from "@opengeni/db";
import {
  googleDrivePublicationDelegationFromVisibleConnections,
  personalConnectionDelegationSourceForGrant,
  personalConnectionDelegationsFromParent,
  personalConnectionDelegationsFromVisibleConnections,
  withFrozenPersonalConnectionDelegations,
} from "../src/domain/personal-connection-delegations";

const personalServer = {
  id: "linear",
  url: "https://mcp.linear.app/mcp",
  cacheToolsList: false,
  connectionRef: {
    providerDomain: "linear.app",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
  },
};

function googleDriveConnection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  const now = "2026-08-14T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "user:owner",
    providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
    kind: "oauth2",
    status: "active",
    grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {
      credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
      credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
      googlePermissionId: "permission-1",
      googleEmail: "owner@example.com",
      googleDisplayName: "Owner",
      verifiedAt: now,
      accessMode: "file_only",
      lifecycle: { state: "active", recoverable: true, observedAt: now },
      outputDestination: {
        folderId: "folder-1",
        folderName: "Published",
        driveId: null,
        location: "my_drive",
        selectedAt: now,
      },
    },
    createdBySubjectId: "user:owner",
    updatedBySubjectId: "user:owner",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("personal MCP connection delegation", () => {
  test("uses human/API subjects but copies authority for agent attempts", () => {
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "user:owner",
        principalKind: "human_session",
        permissions: [],
      }),
    ).toEqual({ kind: "subject", subjectId: "user:owner" });
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "worker:first-party-mcp",
        principalKind: "agent_attempt",
        permissions: [],
        metadata: { sessionId: "parent-session", turnId: "parent-turn" },
      }),
    ).toEqual({ kind: "turn", sessionId: "parent-session", turnId: "parent-turn" });
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "worker:first-party-mcp",
        principalKind: "agent_attempt",
        permissions: [],
        metadata: { sessionId: "parent-session" },
      }),
    ).toEqual({ kind: "none" });
  });

  test("freezes only an active exact subject connection", () => {
    const active: ConnectionMetadata = {
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "user:owner",
      providerDomain: "linear.app",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 1,
      metadata: {},
      createdBySubjectId: "user:owner",
      updatedBySubjectId: "user:owner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = personalConnectionDelegationsFromVisibleConnections({
      servers: [personalServer],
      subjectId: "user:owner",
      connections: [
        { ...active, id: crypto.randomUUID(), status: "revoked" },
        { ...active, id: crypto.randomUUID(), subjectId: "someone-else" },
        active,
      ],
    });
    expect(result).toEqual([
      {
        serverId: "linear",
        connectionId: active.id,
        ownerSubjectId: "user:owner",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    ]);
  });

  test("uses the same deterministic active-row order as runtime resolution", () => {
    const base: ConnectionMetadata = {
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "user:owner",
      providerDomain: "LINEAR.APP",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 1,
      metadata: {},
      createdBySubjectId: "user:owner",
      updatedBySubjectId: "user:owner",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const newest = {
      ...base,
      id: crypto.randomUUID(),
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    expect(
      personalConnectionDelegationsFromVisibleConnections({
        servers: [personalServer],
        subjectId: "user:owner",
        connections: [base, newest],
      }),
    ).toMatchObject([{ connectionId: newest.id, providerDomain: "LINEAR.APP" }]);
  });

  test("children copy only selected server-bound grants", () => {
    const parent: McpPersonalConnectionDelegation[] = [
      {
        serverId: "linear",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: "user:owner",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
      {
        serverId: "other",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: "user:owner",
        providerDomain: "other.example",
        kind: "oauth2",
      },
    ];
    expect(
      personalConnectionDelegationsFromParent({
        servers: [personalServer],
        parentDelegations: parent,
      }),
    ).toEqual([parent[0]]);
  });

  test("children retain frozen first-party social authority alongside selected MCP grants", () => {
    const social: McpPersonalConnectionDelegation = {
      serverId: "social:x",
      connectionId: crypto.randomUUID(),
      ownerSubjectId: "user:owner",
      providerDomain: "x.com",
      kind: "oauth2",
      connectionType: "social",
    };
    expect(
      personalConnectionDelegationsFromParent({
        servers: [personalServer],
        parentDelegations: [social],
      }),
    ).toEqual([social]);
  });

  test("freezes, inherits, and composes one exact Google Drive publication connection", async () => {
    const drive = googleDriveConnection();
    const delegation = googleDrivePublicationDelegationFromVisibleConnections({
      subjectId: "user:owner",
      connections: [drive],
    });
    expect(delegation).toEqual({
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      connectionId: drive.id,
      ownerSubjectId: "user:owner",
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2",
    });
    const inherited = personalConnectionDelegationsFromParent({
      servers: [],
      parentDelegations: [delegation!],
    });
    expect(inherited).toEqual([delegation]);
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [] },
      personalConnectionDelegations: inherited,
      ownerHasWorkspaceMembership: async (subjectId) => subjectId === "user:owner",
      resolveCredential: async (input) => {
        received.push(input);
        return {
          status: "ok",
          headers: { authorization: "Bearer exact-frozen-drive" },
          connectionId: input.connectionRef.connectionId!,
        };
      },
    });
    await resolver({
      workspaceId: drive.workspaceId,
      subjectId: "worker:first-party-mcp",
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      toolName: "google_drive_publish_file",
      destinationUrl: "https://www.googleapis.com/upload/drive/v3/files",
      connectionRef: {
        providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
        kind: "oauth2",
        subjectScope: "subject",
        scopes: [GOOGLE_DRIVE_FILE_SCOPE],
      },
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      subjectId: "user:owner",
      connectionRef: { connectionId: drive.id },
    });
  });

  test("fails closed when Google Drive publication authority is missing or ambiguous", () => {
    expect(
      googleDrivePublicationDelegationFromVisibleConnections({
        subjectId: "user:owner",
        connections: [
          googleDriveConnection({ grantedScopes: [] }),
          googleDriveConnection({ subjectId: "user:other" }),
        ],
      }),
    ).toBeNull();
    expect(
      googleDrivePublicationDelegationFromVisibleConnections({
        subjectId: "user:owner",
        connections: [googleDriveConnection(), googleDriveConnection()],
      }),
    ).toBeNull();
  });

  test("pins every caller surface to the same exact owner, UUID, provider, and kind", async () => {
    const frozenConnectionId = "11111111-1111-4111-8111-111111111111";
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [personalServer] },
      personalConnectionDelegations: [
        {
          serverId: "linear",
          connectionId: frozenConnectionId,
          ownerSubjectId: "user:owner",
          providerDomain: "linear.app",
          kind: "oauth2",
        },
      ],
      ownerHasWorkspaceMembership: async (subjectId) => subjectId === "user:owner",
      resolveCredential: async (input) => {
        received.push(input);
        return {
          status: "ok",
          headers: { "x-test-credential": "frozen" },
          connectionId: input.connectionRef.connectionId!,
        };
      },
    });
    const request = {
      workspaceId: "workspace-1",
      serverId: "linear",
      destinationUrl: "https://mcp.linear.app/mcp",
      connectionRef: personalServer.connectionRef,
    };

    await resolver({ ...request, subjectId: "user:owner", toolName: "model_issue_create" });
    await resolver({
      ...request,
      subjectId: "worker:first-party-mcp",
      toolName: "codemode_issue_create",
    });

    expect(received).toHaveLength(2);
    for (const input of received) {
      expect(input.subjectId).toBe("user:owner");
      expect(input.connectionRef).toMatchObject({
        providerDomain: "linear.app",
        connectionId: frozenConnectionId,
        kind: "oauth2",
        subjectScope: "subject",
      });
    }
  });

  test("never falls forward when the exact frozen connection is unavailable", async () => {
    const frozenConnectionId = "11111111-1111-4111-8111-111111111111";
    const replacementConnectionId = "22222222-2222-4222-8222-222222222222";
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [personalServer] },
      personalConnectionDelegations: [
        {
          serverId: "linear",
          connectionId: frozenConnectionId,
          ownerSubjectId: "user:owner",
          providerDomain: "linear.app",
          kind: "oauth2",
        },
      ],
      ownerHasWorkspaceMembership: async () => true,
      resolveCredential: async (input) => {
        received.push(input);
        if (input.connectionRef.connectionId === frozenConnectionId) {
          return {
            status: "auth_needed",
            reason: "missing_connection",
            providerDomain: "linear.app",
            connectionId: frozenConnectionId,
          };
        }
        return {
          status: "ok",
          headers: { "x-test-credential": "replacement" },
          connectionId: replacementConnectionId,
        };
      },
    });

    const result = await resolver({
      workspaceId: "workspace-1",
      subjectId: "user:owner",
      serverId: "linear",
      destinationUrl: "https://mcp.linear.app/mcp",
      connectionRef: personalServer.connectionRef,
    });

    expect(result).toEqual({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
      providerDomain: "linear.app",
    });
    expect(received.map((input) => input.connectionRef.connectionId)).toEqual([frozenConnectionId]);
    expect(
      received.some((input) => input.connectionRef.connectionId === replacementConnectionId),
    ).toBe(false);
  });

  test("resolves the private Google Drive publication server only through its frozen UUID", async () => {
    const frozenConnectionId = "11111111-1111-4111-8111-111111111111";
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [] },
      personalConnectionDelegations: [
        {
          serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
          connectionId: frozenConnectionId,
          ownerSubjectId: "user:owner",
          providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
          kind: "oauth2",
        },
      ],
      ownerHasWorkspaceMembership: async (subjectId) => subjectId === "user:owner",
      resolveCredential: async (input) => {
        received.push(input);
        return {
          status: "ok",
          headers: { "x-test-credential": "frozen" },
          connectionId: input.connectionRef.connectionId!,
        };
      },
    });

    await resolver({
      workspaceId: "workspace-1",
      subjectId: "worker:first-party-mcp",
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      toolName: "google_drive_publish_file",
      destinationUrl: "https://www.googleapis.com/upload/drive/v3/files",
      connectionRef: {
        providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
        kind: "oauth2",
        subjectScope: "subject",
        scopes: [GOOGLE_DRIVE_FILE_SCOPE],
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      subjectId: "user:owner",
      connectionRef: { connectionId: frozenConnectionId },
    });
  });

  test("rejects ambiguous frozen Google Drive publication delegations", async () => {
    const delegation = {
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      connectionId: "11111111-1111-4111-8111-111111111111",
      ownerSubjectId: "user:owner",
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2" as const,
    };
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [] },
      personalConnectionDelegations: [
        delegation,
        { ...delegation, connectionId: "22222222-2222-4222-8222-222222222222" },
      ],
      ownerHasWorkspaceMembership: async () => true,
      resolveCredential: async () => {
        throw new Error("must not resolve an ambiguous delegation");
      },
    });
    await expect(
      resolver({
        workspaceId: "workspace-1",
        subjectId: "worker:first-party-mcp",
        serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
        toolName: "google_drive_publish_file",
        destinationUrl: "https://www.googleapis.com/upload/drive/v3/files",
        connectionRef: {
          providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
          kind: "oauth2",
          subjectScope: "subject",
          scopes: [GOOGLE_DRIVE_FILE_SCOPE],
        },
      }),
    ).resolves.toMatchObject({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
    });
  });
});
