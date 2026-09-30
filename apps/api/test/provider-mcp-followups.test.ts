import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { RunContext } from "@openai/agents";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import type { Session } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  encryptEnvironmentValue,
  getSession,
  listSessionTurns,
  upsertOrganizationCredentialProvider,
  upsertWorkspaceCredentialProvider,
  type DbClient,
} from "@opengeni/db";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  RunMcpCredentials,
  selectedSessionRemoteMcpTargets,
} from "@opengeni/runtime";
import { OpenGeniClient, verifyCredentialProviderRequest } from "@opengeni/sdk";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { bindRunCredentialResolver } from "../../worker/src/activities/run-credentials";
import { prepareTurnToolPolicy } from "../../worker/src/activities/agent-turn/tool-environment";
import { registerSessionRoutes } from "../src/routes/sessions";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("provider-mcp-followups");
  if (!acquired) throw new Error("Provider follow-up regressions require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

test.each([
  ["workspace", "composer"],
  ["workspace", "send"],
  ["organization", "composer"],
  ["organization", "send"],
] as const)(
  "%s provider supplies headers on first and %s follow-up turns",
  async (lane, delivery) => {
    const access = await bootstrapWorkspace(db.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Provider follow-ups",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Provider follow-ups",
      subjectId: "user:owner",
    });
    const grant = access.workspaceGrants[0]!;
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
    const permissions = organizationApiKeyPermissionsForAccess("full");
    const token = crypto.randomUUID();
    await createOrganizationApiKey(db.db, {
      accountId: scope.accountId,
      name: "Provider fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions,
    });
    const secret = "synthetic-provider-signing-key";
    const requests: Array<{ lane: string; mcpServers: unknown; turnId: string }> = [];
    const headers: Array<string | null> = [];
    const transports: WebStandardStreamableHTTPServerTransport[] = [];
    const receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/credentials") {
          const payload = await verifyCredentialProviderRequest({
            body: await request.text(),
            headers: request.headers,
            secret,
          });
          requests.push(payload);
          return Response.json({
            status: "ok",
            mcp: payload.mcpServers.map(({ url }) => ({
              url,
              headers: { Authorization: `Bearer synthetic-${payload.turnId}` },
            })),
          });
        }
        headers.push(request.headers.get("authorization"));
        const server = new McpServer({ name: "provider", version: "1.0.0" });
        server.registerTool("read", { inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "authenticated" }],
        }));
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        transports.push(transport);
        await server.connect(transport);
        return transport.handleRequest(request);
      },
    });
    try {
      const remote = { id: "product", url: `https://127.0.0.1:${receiver.port}/mcp` };
      const unselected = { id: "unselected", url: `https://127.0.0.1:${receiver.port}/unused` };
      const settings = testSettings({
        databaseUrl: shared.appUrl,
        sandboxBackend: "docker",
        productAccessMode: "configured",
        environmentsEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
        mcpServers: [],
        integrationsAllowPrivateNetworkTargets: true,
      });
      const provider = {
        ...scope,
        url: `http://127.0.0.1:${receiver.port}/credentials`,
        secretEncrypted: encryptEnvironmentValue(environmentsEncryptionKeyBytes(settings)!, secret),
        enabled: true,
        workspaceFilter: null,
        timeoutMs: 2000,
        createdBySubjectId: null,
      };
      if (lane === "workspace") await upsertWorkspaceCredentialProvider(db.db, provider);
      else
        await upsertOrganizationCredentialProvider(db.db, {
          accountId: provider.accountId,
          url: provider.url,
          secretEncrypted: provider.secretEncrypted,
          enabled: provider.enabled,
          timeoutMs: provider.timeoutMs,
          workspaceFilter: provider.workspaceFilter,
          createdBySubjectId: provider.createdBySubjectId,
        });
      const noop = async () => undefined;
      const deps = {
        db: db.db,
        settings,
        bus: new MemoryEventBus(),
        objectStorage: null,
        workflowClient: {
          signalUserMessage: noop,
          wakeSessionWorkflow: noop,
          requestSessionWorkflowWakeDispatch: noop,
          signalSessionControl: noop,
        },
        githubStateSecret: "test",
      } as unknown as ApiRouteDeps;
      const app = new Hono();
      app.onError((error, c) => {
        if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
        throw error;
      });
      registerSessionRoutes(app, deps);
      const sdk = new OpenGeniClient({
        baseUrl: "http://fixture",
        apiKey: token,
        fetch: (input, init) => app.request(input, init),
      });
      const created = await sdk.createSession(scope.workspaceId, {
        initialMessage: "First",
        tools: [{ kind: "mcp", id: remote.id, optional: true, eager: true }],
        mcpServers: [remote, unselected],
        idempotencyKey: crypto.randomUUID(),
      });
      const session = (await getSession(
        db.db,
        scope.workspaceId,
        created.id,
      )) as unknown as Session;
      const runSettings = { ...settings, mcpServers: session.mcpServers };
      for (const stage of [0, 1]) {
        if (stage === 1) {
          if (delivery === "composer") {
            const draft = await sdk.getComposerDraft(scope.workspaceId, created.id);
            const saved = await sdk.saveComposerDraft(scope.workspaceId, created.id, {
              ...draft,
              text: "Composer follow-up",
              expectedRevision: draft.revision,
            });
            await sdk.submitComposerDraft(scope.workspaceId, created.id, {
              ...saved,
              annotations: [],
              expectedDraftRevision: saved.revision,
              clientEventId: crypto.randomUUID(),
              delivery: "send",
            });
          } else {
            await sdk.sendMessage(scope.workspaceId, created.id, { text: "Send follow-up" });
          }
        }
        const turns = await listSessionTurns(db.db, scope.workspaceId, created.id);
        expect(turns).toHaveLength(stage + 1);
        const turn = turns.at(-1)!;
        if (stage === 1) expect(turn.tools).toEqual([]);
        const policy = await prepareTurnToolPolicy({
          input: { ...scope, sessionId: session.id } as never,
          db: db.db,
          cancellationSignal: undefined,
          connectionCredentials: undefined,
          turn: turn as never,
          session: session as never,
          fileAuthoritySubjectId: null,
          capabilitySettings: runSettings,
          runSettings,
          rigVersion: null,
          workspaceRefs: {} as never,
        });
        expect(policy.turnTools).toEqual([
          { kind: "mcp", id: remote.id, optional: true, eager: true },
        ]);
        const resolver = await bindRunCredentialResolver({
          db: db.db,
          settings: runSettings,
          ...scope,
          session,
          turn,
          effectiveTools: policy.turnTools,
          attemptId: crypto.randomUUID(),
          effectiveSandboxBackend: "docker",
          variableSet: null,
        });
        const material = await resolver!.resolve({ purpose: "provision", forceRefresh: false });
        expect(requests.at(-1)).toMatchObject({ lane, mcpServers: [remote], turnId: turn.id });
        const credentials = new RunMcpCredentials(
          selectedSessionRemoteMcpTargets(runSettings, session.mcpServers, policy.turnTools),
        );
        credentials.replace(material);
        const offset = headers.length;
        const prepared = await prepareAgentTools(runSettings, policy.turnTools, {
          runMcpCredentials: credentials,
          sessionAttachedRemoteMcpTargets: [remote],
          mcpFetchImpl: async (_url, init) => fetch(`http://127.0.0.1:${receiver.port}/mcp`, init),
        });
        try {
          const agent = buildOpenGeniAgent(runSettings, [], { mcpServers: prepared.mcpServers });
          const tool = (await agent.getMcpTools(new RunContext())).find(
            (candidate) => candidate.type === "function" && candidate.name === "product__read",
          );
          if (!tool || tool.type !== "function") throw new Error("Selected MCP tool missing");
          await tool.invoke(new RunContext(), "{}", {
            toolCall: { callId: crypto.randomUUID() },
          } as never);
          expect(headers.length).toBeGreaterThan(offset);
          expect(
            headers.slice(offset).every((header) => header === `Bearer synthetic-${turn.id}`),
          ).toBe(true);
        } finally {
          await prepared.close();
          credentials.close();
        }
      }
      expect(requests).toHaveLength(2);
    } finally {
      for (const transport of transports) await transport.close();
      receiver.stop(true);
    }
  },
  60_000,
);
