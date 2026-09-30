import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Session, ToolRef } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  enqueueSessionTurn,
  getSession,
  upsertWorkspaceCredentialProvider,
  encryptEnvironmentValue,
  type DbClient,
  type SessionTurnForExecution,
} from "@opengeni/db";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  prepareAgentTools,
  RunMcpCredentials,
  selectedSessionRemoteMcpTargets,
} from "@opengeni/runtime";
import { resolveTurnToolPolicy } from "@opengeni/core";
import { expandMcpAccountRoutes } from "../../worker/src/activities/mcp-account-routes";
import { bindNativeConnectionCredentialsToTurn } from "../../worker/src/activities/mcp-credentials";
import { bindRunCredentialResolver } from "../../worker/src/activities/run-credentials";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("provider-mcp-authority-review");
  if (!acquired) throw new Error("This review requires real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

// SQL NULL bindings intentionally reproduce retained pre-0494 work, not a
// newly admitted account selection. New [] bindings already fail closed.
test.each(["undelegated_personal", "unpinned_workspace"] as const)(
  "provider must not receive a native-denied legacy follow-up: %s",
  async (lane) => {
    const access = await bootstrapWorkspace(db.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Provider authority review",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Provider authority review",
      subjectId: "user:review-owner",
    });
    const grant = access.workspaceGrants[0]!;
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
    const connectionRef = {
      providerDomain: "legacy.example",
      kind: "oauth2" as const,
      ...(lane === "undelegated_personal"
        ? { subjectScope: "subject" as const, connectionId: crypto.randomUUID() }
        : { subjectScope: "workspace" as const }),
    };
    const remote = { id: "legacy", url: "https://legacy.example/mcp", connectionRef };
    const providerRequests: Array<{ mcpServers: unknown }> = [];
    const receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        providerRequests.push(await request.json());
        return Response.json({
          status: "ok",
          mcp: [{ url: remote.url, headers: { Authorization: "Bearer synthetic-product" } }],
        });
      },
    });
    try {
      const settings = testSettings({
        environmentsEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
        integrationsAllowPrivateNetworkTargets: true,
        mcpServers: [remote],
      });
      await upsertWorkspaceCredentialProvider(db.db, {
        ...scope,
        url: `http://127.0.0.1:${receiver.port}/credentials`,
        secretEncrypted: encryptEnvironmentValue(
          environmentsEncryptionKeyBytes(settings)!,
          "synthetic-review-signing-key",
        ),
        enabled: true,
        timeoutMs: 2000,
        createdBySubjectId: null,
      });
      const tools: ToolRef[] = [{ kind: "mcp", id: remote.id, optional: true, eager: true }];
      const created = await createSession(db.db, {
        ...scope,
        initialMessage: "Legacy session",
        tools,
        toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
        mcpServers: [remote],
        mcpAccountBindings: null,
        personalConnectionDelegations: [],
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "docker",
      });
      const session = (await getSession(db.db, scope.workspaceId, created.id)) as Session;
      const queued = await enqueueSessionTurn(db.db, {
        ...scope,
        sessionId: session.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `review-${session.id}`,
        source: "api",
        prompt: "Retained follow-up",
        tools: [],
        toolsProvided: false,
        mcpAccountBindings: null,
        personalConnectionDelegations: [],
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        sandboxBackend: "docker",
        initiator: { kind: "service", subjectId: "service:review" },
      });
      const turn = {
        ...queued,
        mcpAccountBindings: null,
        personalConnectionDelegations: [],
        initiatingHumanSubjectId: null,
      } as SessionTurnForExecution;
      expect(selectedSessionRemoteMcpTargets(settings, session.mcpServers, turn.tools)).toEqual([]);
      const policy = resolveTurnToolPolicy({
        toolPolicy: session.toolPolicy,
        session,
        turn,
        availableMcpServerIds: settings.mcpServers.map(({ id }) => id),
      });
      const routes = expandMcpAccountRoutes({
        settings,
        tools: policy.toolRefs,
        bindings: turn.mcpAccountBindings,
      });
      const resolver = await bindRunCredentialResolver({
        ...scope,
        db: db.db,
        settings: routes.settings,
        session,
        turn,
        effectiveTools: routes.tools,
        attemptId: crypto.randomUUID(),
        effectiveSandboxBackend: "docker",
        variableSet: null,
      });
      const material = await resolver!.resolve({ purpose: "provision", forceRefresh: false });
      let nativeCalls = 0;
      let physicalRequests = 0;
      const native = bindNativeConnectionCredentialsToTurn(
        {
          ...scope,
          db: db.db,
          settings: routes.settings,
          sessionId: session.id,
          attemptId: crypto.randomUUID(),
          turn,
        },
        async () => {
          nativeCalls += 1;
          throw new Error("Native acquisition must be denied before lookup");
        },
      );
      const credentials = new RunMcpCredentials(
        selectedSessionRemoteMcpTargets(routes.settings, session.mcpServers, routes.tools),
      );
      credentials.replace(material);
      const prepared = await prepareAgentTools(routes.settings, routes.tools, {
        workspaceId: scope.workspaceId,
        resolveCredential: native,
        runMcpCredentials: credentials,
        mcpFetchImpl: async () => {
          physicalRequests += 1;
          throw new Error("Native-denied route must not reach the network");
        },
      });
      await prepared.close();
      credentials.close();
      expect(nativeCalls).toBe(0);
      expect(physicalRequests).toBe(0);
      // Previous raw turn.tools selected no callback targets. PR #3055 sends
      // this non-executable native ref instead, despite native denial above.
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]!.mcpServers).toEqual([]);
    } finally {
      receiver.stop(true);
    }
  },
  60_000,
);

test("legacy provider headers must not substitute the authorized native account", async () => {
  const headers: Array<string | null> = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      headers.push(request.headers.get("authorization"));
      const server = new McpServer({ name: "account-review", version: "1.0.0" });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  const remote = {
    id: "legacy",
    url: `https://127.0.0.1:${receiver.port}/mcp`,
    connectionRef: {
      connectionId: crypto.randomUUID(),
      providerDomain: "legacy.example",
      kind: "oauth2" as const,
      subjectScope: "workspace" as const,
    },
  };
  const settings = testSettings({ mcpServers: [remote] });
  const turn = {
    id: crypto.randomUUID(),
    executionGeneration: 1,
    initiator: { kind: "service", subjectId: "service:review" },
    initiatingHumanSubjectId: null,
    mcpAccountBindings: null,
    personalConnectionDelegations: [],
    tools: [],
    metadata: {},
  } as unknown as SessionTurnForExecution;
  const policy = resolveTurnToolPolicy({
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    session: { tools: [{ kind: "mcp", id: remote.id, eager: true }] },
    turn,
    availableMcpServerIds: [remote.id],
  });
  const routes = expandMcpAccountRoutes({ settings, tools: policy.toolRefs, bindings: null });
  let authorizations = 0;
  // Isolate header precedence after successful native authorization. Native
  // authority is scripted here; transport and production header merging are real.
  const native = bindNativeConnectionCredentialsToTurn(
    {
      db: db.db,
      settings,
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      turn,
      authorizeAcceptedUse: async () => {
        authorizations += 1;
        return {
          status: "authorized",
          originWorkspaceId: crypto.randomUUID(),
          connectionKind: "oauth2",
          attribution: {
            organizationId: crypto.randomUUID(),
            workspaceId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            connectionId: remote.connectionRef.connectionId,
            connectionGeneration: 1,
            scope: "workspace",
            ownerSubjectId: null,
            authorityId: crypto.randomUUID(),
            grantId: null,
          },
        };
      },
    },
    async () => ({
      status: "ok",
      connectionId: remote.connectionRef.connectionId,
      headers: { Authorization: "Bearer synthetic-native-A" },
    }),
  );
  const credentials = new RunMcpCredentials(
    selectedSessionRemoteMcpTargets(routes.settings, [remote], routes.tools),
  );
  credentials.replace({
    expiresAt: null,
    mcp: [{ url: remote.url, headers: { authorization: "Bearer synthetic-provider-B" } }],
  });
  try {
    const prepared = await prepareAgentTools(routes.settings, routes.tools, {
      workspaceId: crypto.randomUUID(),
      resolveCredential: native,
      runMcpCredentials: credentials,
      mcpFetchImpl: async (_url, init) => fetch(`http://127.0.0.1:${receiver.port}/mcp`, init),
    });
    await prepared.close();
    expect(authorizations).toBeGreaterThan(0);
    expect(headers.length).toBeGreaterThan(0);
    expect([...new Set(headers)]).toEqual(["Bearer synthetic-native-A"]);
  } finally {
    credentials.close();
    for (const transport of transports) await transport.close();
    receiver.stop(true);
  }
});
