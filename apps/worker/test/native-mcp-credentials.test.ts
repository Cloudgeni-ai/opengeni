import { expect, test } from "bun:test";
import type {
  Database,
  ResolveConnectionCredentialInput,
  ResolveConnectionCredentialResult,
  SessionTurnForExecution,
} from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { bindNativeConnectionCredentialsToTurn } from "../src/activities/mcp-credentials";

const connectionId = "22222222-2222-4222-8222-222222222222";
const attribution = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  connectionId,
  connectionGeneration: 3,
  scope: "user" as const,
  ownerSubjectId: "external_user:alice",
  authorityId: "authority-1",
  grantId: "grant-1",
};
const request: ResolveConnectionCredentialInput = {
  workspaceId: "workspace-1",
  subjectId: "external_user:alice",
  serverId: "example",
  destinationUrl: "https://mcp.example.test/mcp",
  connectionRef: {
    connectionId,
    providerDomain: "example.test",
    kind: "oauth2",
    subjectScope: "subject",
  },
};

function fixture(
  options: {
    turn?: Partial<SessionTurnForExecution>;
    resolve?: (
      input: ResolveConnectionCredentialInput,
    ) => Promise<ResolveConnectionCredentialResult>;
    activated?: boolean;
  } = {},
) {
  const settings = testSettings();
  settings.mcpServers = [
    { id: "example", operationRecovery: { mutate: { observerTool: "status" } } },
  ] as unknown as typeof settings.mcpServers;
  const calls: ResolveConnectionCredentialInput[] = [];
  const uses: Array<{ physicalRequestId: string; usePhase: string }> = [];
  let live = true;
  const turn = {
    id: "turn-1",
    executionGeneration: 7,
    initiator: { kind: "subject", subjectId: "external_user:alice" },
    initiatingHumanSubjectId: "external_user:alice",
    personalConnectionDelegations: [
      {
        serverId: "example",
        connectionId,
        ownerSubjectId: "external_user:alice",
        providerDomain: "example.test",
        kind: "oauth2",
        userDelegation: { grantId: "grant-1" },
      },
    ],
    ...options.turn,
  } as SessionTurnForExecution;
  const resolve = bindNativeConnectionCredentialsToTurn(
    {
      db: {} as Database,
      settings,
      accountId: "organization-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      turn,
      canonicalMcpServerIds: ["example"],
      isSessionTenancyProductActivated: async () => options.activated ?? true,
      authorizeAcceptedUse: async (_db, use) => {
        uses.push(use);
        return live
          ? {
              status: "authorized",
              originWorkspaceId: "workspace-1",
              connectionKind: "oauth2",
              attribution,
            }
          : { status: "denied", reason: "personal_authority_unavailable" };
      },
    },
    async (input) => {
      calls.push(input);
      return options.resolve
        ? await options.resolve(input)
        : {
            status: "ok",
            headers: { Authorization: "Bearer synthetic" },
            connectionId,
            connectionVersion: 9,
            connectionUseAttribution: attribution,
          };
    },
  );
  return {
    resolve,
    calls,
    uses,
    revoke: () => {
      live = false;
    },
  };
}

test("native acquisition receives accepted attempt context and retains refresh intent", async () => {
  const f = fixture();
  const result = await f.resolve({ ...request, forceRefresh: true });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    forceRefresh: true,
    connectionRef: request.connectionRef,
    connectionUseContext: {
      accountId: "organization-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      executionGeneration: 7,
      usePhase: "credential_resolution",
    },
  });
  expect(result).toMatchObject({
    status: "ok",
    connectionVersion: 9,
    connectionUseAttribution: attribution,
  });
  if (result.status !== "ok") throw new Error("expected credentials");
  expect(await result.authorizeProviderRequest?.()).toBe(true);
  expect(await result.authorizeProviderRequest?.()).toBe(true);
  expect(f.uses.map((use) => use.usePhase)).toEqual(["provider_request", "provider_request"]);
  expect(
    new Set([
      f.calls[0]?.connectionUseContext?.physicalRequestId,
      ...f.uses.map((use) => use.physicalRequestId),
    ]).size,
  ).toBe(3);
  f.revoke();
  expect(await result.authorizeProviderRequest?.()).toBe(false);
});

test("account-qualified routes refuse sibling identities and canonical fallback before resolution", async () => {
  const personal = {
    serverId: "example-personal",
    canonicalServerId: "example",
    connectionId,
    originWorkspaceId: "workspace-1",
    providerDomain: "example.test",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
    ownerSubjectId: "external_user:alice",
    accountLabel: "Alice",
    connectionRef: { ...request.connectionRef },
  };
  const workspace = {
    ...personal,
    serverId: "example-workspace",
    connectionId: "33333333-3333-4333-8333-333333333333",
    subjectScope: "workspace" as const,
    ownerSubjectId: null,
    accountLabel: "Team",
    connectionRef: {
      ...request.connectionRef,
      connectionId: "33333333-3333-4333-8333-333333333333",
      subjectScope: "workspace" as const,
    },
  };
  const f = fixture({
    resolve: async (input) => ({
      status: "ok",
      headers: {},
      connectionId: input.connectionRef.connectionId!,
      connectionVersion: 1,
    }),
    turn: {
      mcpAccountBindings: [personal, workspace],
      personalConnectionDelegations: [
        {
          serverId: personal.serverId,
          connectionId,
          ownerSubjectId: personal.ownerSubjectId,
          providerDomain: personal.providerDomain,
          kind: personal.kind,
        },
      ],
    },
  });
  for (const denied of [
    request,
    { ...request, serverId: personal.serverId, subjectId: "external_user:bob" },
    {
      ...request,
      serverId: personal.serverId,
      connectionRef: { ...request.connectionRef, connectionId: workspace.connectionId },
    },
    { ...request, serverId: workspace.serverId },
    {
      ...request,
      serverId: personal.serverId,
      connectionRef: { ...request.connectionRef, scopes: ["unaccepted.admin"] },
    },
  ]) {
    expect((await f.resolve(denied)).status).toBe("auth_needed");
  }
  expect(f.calls).toHaveLength(0);
  expect((await f.resolve({ ...request, serverId: personal.serverId })).status).toBe("ok");
  expect(
    (
      await f.resolve({
        ...request,
        serverId: workspace.serverId,
        connectionRef: {
          ...request.connectionRef,
          connectionId: workspace.connectionId,
          subjectScope: "workspace",
        },
      })
    ).status,
  ).toBe("ok");
  expect(f.calls.map((call) => call.serverId)).toEqual([personal.serverId, workspace.serverId]);
  expect(f.calls[1]?.subjectId).toBeUndefined();
});

test("account routes pin authority generation and reject a resolver returning a different account", async () => {
  const f = fixture({
    turn: {
      mcpAccountBindings: [
        {
          serverId: "example-personal",
          canonicalServerId: "example",
          connectionId,
          originWorkspaceId: "workspace-1",
          providerDomain: "example.test",
          kind: "oauth2",
          subjectScope: "subject",
          ownerSubjectId: "external_user:alice",
          accountLabel: "Alice",
          connectionRef: { ...request.connectionRef },
          connectionAuthorityGeneration: 17,
        },
      ],
      personalConnectionDelegations: [
        {
          serverId: "example-personal",
          connectionId,
          ownerSubjectId: "external_user:alice",
          providerDomain: "example.test",
          kind: "oauth2",
        },
      ],
    },
    resolve: async () => ({
      status: "ok",
      connectionId: "33333333-3333-4333-8333-333333333333",
      headers: { Authorization: "Bearer must-not-escape" },
    }),
  });
  const result = await f.resolve({
    ...request,
    serverId: "example-personal",
    expectedAuthorityGeneration: 999,
  });
  expect(result.status).toBe("auth_needed");
  expect(JSON.stringify(result)).not.toContain("must-not-escape");
  expect(f.calls[0]?.expectedAuthorityGeneration).toBe(17);
});

test("an empty accepted account set cannot acquire a canonical default", async () => {
  const f = fixture({ turn: { mcpAccountBindings: [] } });
  expect((await f.resolve(request)).status).toBe("auth_needed");
  expect(
    (
      await f.resolve({
        ...request,
        connectionRef: { ...request.connectionRef, subjectScope: "workspace" },
      })
    ).status,
  ).toBe("auth_needed");
  expect(f.calls).toHaveLength(0);
});

test("personal use without the exact accepted selection never enters credential resolution", async () => {
  for (const turn of [
    { personalConnectionDelegations: [] },
    { personalConnectionDelegations: [{ serverId: "other", connectionId }] },
  ]) {
    const f = fixture({ turn: turn as Partial<SessionTurnForExecution> });
    expect(await f.resolve(request)).toMatchObject({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
    });
    expect(f.calls).toHaveLength(0);
  }
});

test("host provenance cannot alias a native UUID or invoke a fallback", async () => {
  const f = fixture();
  expect(
    await f.resolve({
      ...request,
      connectionRef: { ...request.connectionRef, authoritySource: "host" },
    }),
  ).toMatchObject({
    status: "auth_needed",
    reason: "unsupported_auth",
  });
  expect(f.calls).toHaveLength(0);
});

test.each(["missing_connection", "personal_authority_unavailable"] as const)(
  "native denial %s is returned without retrying another authority",
  async (reason) => {
    const denied: ResolveConnectionCredentialResult = {
      status: "auth_needed",
      reason,
      providerDomain: "example.test",
    };
    const f = fixture({ resolve: async () => denied });
    expect(await f.resolve(request)).toBe(denied);
    expect(f.calls).toHaveLength(1);
    expect(f.uses).toHaveLength(0);
  },
);

test("delayed credential acquisition still rechecks live authority before provider use", async () => {
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    resolve: async () => {
      await acquired;
      return { status: "ok", connectionId, headers: {}, connectionUseAttribution: attribution };
    },
  });
  const pending = f.resolve(request);
  f.revoke();
  release();
  const result = await pending;
  if (result.status !== "ok") throw new Error("expected credentials");
  expect(await result.authorizeProviderRequest?.()).toBe(false);
});

test("recovery identity follows the accepted human across background continuations", async () => {
  const digest = async (turn: Partial<SessionTurnForExecution>, subjectId = "untrusted") => {
    const result = await fixture({ turn }).resolve({ ...request, subjectId });
    if (result.status !== "ok") throw new Error("expected credentials");
    expect(result.operationAuthorityDigest).toMatch(/^[a-f0-9]{64}$/);
    return result.operationAuthorityDigest;
  };
  const original = await digest({});
  expect(await digest({ initiator: { kind: "service", subjectId: "runner" } })).toBe(original);
  expect(await digest({}, "forged-other-user")).toBe(original);
  expect(await digest({ initiatingHumanSubjectId: "external_user:bob" })).not.toBe(original);
});

test("activated workspaces reject unresolved selections instead of legacy lookup", async () => {
  const f = fixture();
  const ref = {
    providerDomain: "example.test",
    kind: "oauth2" as const,
    subjectScope: "workspace" as const,
  };
  expect(await f.resolve({ ...request, connectionRef: ref })).toMatchObject({
    status: "auth_needed",
    reason: "missing_connection",
  });
  expect(f.calls).toHaveLength(0);
});

test("workspace selection uses native context without borrowing a personal owner", async () => {
  const f = fixture({ turn: { personalConnectionDelegations: [] } });
  const result = await f.resolve({
    ...request,
    connectionRef: { ...request.connectionRef, subjectScope: "workspace" },
  });
  expect(result.status).toBe("ok");
  expect(f.calls).toHaveLength(1);
  if (result.status !== "ok") throw new Error("expected credentials");
  expect(await result.authorizeProviderRequest?.()).toBe(true);
  expect(f.uses[0]).not.toHaveProperty("ownerSubjectId");
});

test("only the reserved GitHub API consumer accepts a personal GitHub selection", async () => {
  const f = fixture({
    turn: {
      personalConnectionDelegations: [
        {
          serverId: "github:personal",
          connectionType: "github_personal",
          connectionId,
          ownerSubjectId: "external_user:alice",
          providerDomain: "github.com",
          kind: "oauth2",
          userDelegation: { grantId: "grant-1" },
          personalGitHubRepositorySelection: {},
        },
      ] as SessionTurnForExecution["personalConnectionDelegations"],
    },
  });
  const github: ResolveConnectionCredentialInput = {
    ...request,
    serverId: "github:personal",
    destinationUrl: "https://api.github.com/repos/example/repository",
    credentialTarget: "http_api",
    connectionRef: { ...request.connectionRef, provider: "github", providerDomain: "github.com" },
  };
  expect(await f.resolve(github)).toMatchObject({ status: "ok" });
  for (const changed of [
    { serverId: "other" },
    { destinationUrl: "https://api.github.com.attacker.test/token" },
    { credentialTarget: "mcp" as const },
  ]) {
    expect(await f.resolve({ ...github, ...changed })).toMatchObject({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
    });
  }
  expect(f.calls).toHaveLength(1);
});
