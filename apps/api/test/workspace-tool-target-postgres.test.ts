// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  acquireSharedTestDatabase,
  startTestMcpServer,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  createOrganizationApiKey,
  revokeOrganizationApiKey,
  updateConnectorToolPermissionPolicies,
  type DbClient,
} from "@opengeni/db";
import { accessGrantAuthorizationFromContext, type ApiRouteDeps } from "@opengeni/core";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import {
  approveWorkspaceToolTarget,
  invokeWorkspaceToolTarget,
  type TargetGatewayOptions,
} from "../src/workspace-tool-target";
import { createApp } from "../src/app";
import {
  prepareWorkspaceToolGateway,
  prepareWorkspaceToolGatewayForGrant,
} from "../src/workspace-tool-gateway";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("target-adapter-approval");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("Real PostgreSQL required");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("adapter-generated v2 approval provenance on PostgreSQL", () => {
  test.each(["raw", "local"] as const)(
    "production %s assembly retains approval provenance across Ask to Allow without injected private digests",
    async (kind) => {
      if (!client || !shared) return;
      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "target-real-assembly",
        accountExternalId: suffix,
        accountName: "Target assembly",
        workspaceExternalSource: "target-real-assembly",
        workspaceExternalId: suffix,
        workspaceName: "Target assembly",
        subjectId: `human:${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const authorization = accessGrantAuthorizationFromContext(access, grant);
      authorization.canonicalManagedHumanSession = true;
      let effects = 0;
      let changedSchema = false;
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const mcp = new McpServer({ name: "raw-approval-test", version: "1.0.0" });
          mcp.registerTool(
            "search_documents",
            {
              inputSchema: {
                query: z.string(),
                ...(changedSchema ? { added: z.boolean().optional() } : {}),
              },
            },
            async () => {
              effects++;
              return { content: [{ type: "text", text: "ok" }] };
            },
          );
          const transport = new WebStandardStreamableHTTPServerTransport({
            enableJsonResponse: true,
          });
          await mcp.connect(transport);
          return transport.handleRequest(request);
        },
      });
      const identity =
        kind === "raw"
          ? { serverId: "raw-probe", toolName: "search_documents" }
          : { serverId: "opengeni", toolName: "sessions_list" };
      const url = `${provider.url}mcp`;
      const settings = testSettings({
        mcpServers: [
          { id: identity.serverId, url, cacheToolsList: false, allowedTools: [identity.toolName] },
        ],
      });
      const deps = { db: client.db, settings } as ApiRouteDeps;
      const config = settings.mcpServers[0]!;
      const setPolicy = async (policy: "ask" | "allow") =>
        updateConnectorToolPermissionPolicies(client!.db, {
          ...grant,
          connectionId: `session-mcp:${identity.serverId}:${createHash("sha256").update(config.url).digest("hex")}`,
          serverId: identity.serverId,
          toolNames: [identity.toolName],
          policy,
        });
      const args = kind === "raw" ? { query: "test" } : {};
      const provenance = async (legacy = false) => {
        const prepared = legacy
          ? await prepareWorkspaceToolGatewayForGrant(deps, grant, [identity])
          : await prepareWorkspaceToolGateway(deps, authorization, {
              target: { identity },
              firstPartySettings: "caller",
            });
        try {
          const call = await prepared.toolGateway.prepareCall(
            {
              operationId: crypto.randomUUID(),
              catalogDigest: prepared.toolGatewayCatalog.digest,
              identity,
              arguments: args,
              caller: { kind: "http", subjectId: grant.subjectId },
            },
            { transportMeta: { approvalConfirmed: true } },
          );
          return { effect: call.effectDigest, authority: call.approvalAuthorityDigest };
        } finally {
          await prepared.close();
        }
      };
      try {
        for (const supplyToken of [true, false]) {
          await setPolicy("ask");
          const request = { identity, operationId: crypto.randomUUID(), arguments: args };
          const asked = await provenance();
          const legacyAsk = await provenance(true);
          const approved = await approveWorkspaceToolTarget(deps, authorization, request);
          await setPolicy("allow");
          const allowed = await provenance();
          expect(allowed).toEqual(asked);
          expect((await provenance(true)).authority).not.toBe(legacyAsk.authority);
          const called = await invokeWorkspaceToolTarget(deps, authorization, {
            ...request,
            target: { identity },
            ...(supplyToken ? { approvalToken: approved.approvalToken } : {}),
          });
          expect(called.result.isError).not.toBe(true);
          expect(called.tool.entry.approval).toBe("policy");
          expect(called.tool.definitionDigest).not.toBe(approved.tool.definitionDigest);
          for (const token of [approved.approvalToken, undefined])
            await expect(
              invokeWorkspaceToolTarget(deps, authorization, {
                ...request,
                target: { identity },
                ...(token ? { approvalToken: token } : {}),
              }),
            ).rejects.toMatchObject({ status: 409, retryable: false, outcomeUnknown: true });
        }
        expect(effects).toBe(kind === "raw" ? 2 : 0);
        // Existing runtime effect provenance and exact selected private config
        // remain fences, even when policy is now Allow and the token is omitted.
        for (const drift of kind === "raw"
          ? ["schema", "headers", "endpoint"]
          : ["headers", "endpoint"]) {
          changedSchema = false;
          delete config.headers;
          config.url = url;
          await setPolicy("ask");
          const request = { identity, operationId: crypto.randomUUID(), arguments: args };
          const before = await provenance();
          const approved = await approveWorkspaceToolTarget(deps, authorization, request);
          await setPolicy("allow");
          if (drift === "schema") changedSchema = true;
          if (drift === "headers") config.headers = { "x-private-test-authority": "changed" };
          if (drift === "endpoint") config.url = `${url}?authority=changed`;
          const after = await provenance();
          if (drift === "schema") expect(after.effect).not.toBe(before.effect);
          else expect(after.authority).not.toBe(before.authority);
          for (const supplyToken of [true, false])
            await expect(
              invokeWorkspaceToolTarget(deps, authorization, {
                ...request,
                target: { identity },
                ...(supplyToken ? { approvalToken: approved.approvalToken } : {}),
              }),
            ).rejects.toMatchObject({ status: 409 });
        }
        expect(effects).toBe(kind === "raw" ? 2 : 0);
      } finally {
        provider.stop(true);
        await deleteWorkspace(client.db, grant.workspaceId);
      }
    },
    180_000,
  );
  test("real organization-key authentication is revoked in flight before the physical tool call", async () => {
    if (!client || !shared) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "target-route",
      accountExternalId: suffix,
      accountName: "Target route",
      workspaceExternalSource: "target-route",
      workspaceExternalId: suffix,
      workspaceName: "Target route",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const bearer = `ogk_route_${crypto.randomUUID().replaceAll("-", "")}`;
    const key = await createOrganizationApiKey(client.db, {
      accountId: grant.accountId,
      name: "Disposable route test",
      prefix: bearer.slice(0, 12),
      keyHash: createHash("sha256").update(bearer).digest("hex"),
      permissions: ["workspace:read"],
    });
    let revoked = false;
    const provider = startTestMcpServer({
      validateAuthorization: async () => {
        if (!revoked && provider.requests.at(-1)?.jsonRpcMethod === "tools/list") {
          await revokeOrganizationApiKey(client!.db, grant.accountId, key.id);
          revoked = true;
        }
        return true;
      },
    });
    const app = createApp({
      settings: testSettings({
        productAccessMode: "configured",
        mcpServers: [{ id: "route-probe", url: provider.url, cacheToolsList: false }],
      }),
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      objectStorage: null,
    });
    try {
      const response = await app.request(
        `http://localhost/v1/workspaces/${grant.workspaceId}/tools/invoke`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({
            target: { identity: { serverId: "route-probe", toolName: "search_documents" } },
            arguments: { query: "test" },
            operationId: crypto.randomUUID(),
          }),
        },
      );
      expect(revoked).toBe(true);
      expect([401, 403]).toContain(response.status);
      expect(provider.calls).toHaveLength(0);
      expect(
        provider.requests.filter((request) => request.jsonRpcMethod === "tools/call"),
      ).toHaveLength(0);
    } finally {
      provider.close();
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  }, 180_000);
  test("Ask to Allow preserves executable provenance, independent of the optional public pin", async () => {
    if (!client || !shared) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "target-adapter",
      accountExternalId: suffix,
      accountName: "Target adapter",
      workspaceExternalSource: "target-adapter",
      workspaceExternalId: suffix,
      workspaceName: "Target adapter",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const authorization = accessGrantAuthorizationFromContext(access, grant);
    authorization.canonicalManagedHumanSession = true;
    const deps = { db: client.db } as ApiRouteDeps;
    const identity = { serverId: "selected", toolName: "write" };
    let ask = true;
    let schemaChanged = false;
    let privateAuthority = "a".repeat(64);
    let effects = 0;
    const options: TargetGatewayOptions = {
      authorizeSite: async () => undefined,
      prepare: async () => {
        const { gateway, catalog } = createWorkspaceToolGateway({
          ...grant,
          generation: 1,
          definitions: [
            {
              identity,
              source: "mcp",
              modelName: "selected__write",
              approval: ask ? "human" : "policy",
              inputSchema: {
                type: "object",
                properties: schemaChanged ? { extra: { type: "string" } } : {},
              },
              // Independent executable and private credential authority fences.
              effectAuthorityDigest: "e".repeat(64),
              approvalAuthorityDigest: privateAuthority,
              execute: () => {
                effects++;
                return { content: [] };
              },
            },
          ],
          resolveApproval: () => (ask ? "ask" : "allow"),
        });
        return { toolGateway: gateway, toolGatewayCatalog: catalog, close: async () => undefined };
      },
    };
    try {
      for (const supplyToken of [true, false]) {
        ask = true;
        const request = { identity, operationId: crypto.randomUUID(), arguments: {} };
        const approved = await approveWorkspaceToolTarget(deps, authorization, request, options);
        expect(approved.tool.entry.approval).toBe("human");
        ask = false;
        const invoke = {
          ...request,
          target: { identity },
          ...(supplyToken ? { approvalToken: approved.approvalToken } : {}),
        };
        // Full public pins remain available, and fail before consuming provenance.
        await expect(
          invokeWorkspaceToolTarget(
            deps,
            authorization,
            {
              ...invoke,
              expectedDefinitionDigest: approved.tool.definitionDigest,
            },
            options,
          ),
        ).rejects.toMatchObject({ status: 409, details: { code: "tool_definition_stale" } });
        const called = await invokeWorkspaceToolTarget(deps, authorization, invoke, options);
        expect(called.tool.entry.approval).toBe("policy");
        expect(called.tool.definitionDigest).not.toBe(approved.tool.definitionDigest);
        for (const token of [approved.approvalToken, undefined]) {
          await expect(
            invokeWorkspaceToolTarget(
              deps,
              authorization,
              {
                ...request,
                target: { identity },
                ...(token ? { approvalToken: token } : {}),
              },
              options,
            ),
          ).rejects.toMatchObject({ status: 409, outcomeUnknown: true, retryable: false });
        }
        ask = true;
        await expect(
          approveWorkspaceToolTarget(deps, authorization, request, options),
        ).rejects.toMatchObject({ status: 409, outcomeUnknown: true });
      }
      expect(effects).toBe(2);
      for (const changed of ["effect", "authority", "site", "arguments", "identity"] as const) {
        ask = true;
        schemaChanged = false;
        privateAuthority = "a".repeat(64);
        const request = { identity, operationId: crypto.randomUUID(), arguments: {} };
        const approved = await approveWorkspaceToolTarget(deps, authorization, request, options);
        ask = false;
        schemaChanged = changed === "effect";
        if (changed === "authority") privateAuthority = "b".repeat(64);
        for (const supplyToken of [true, false]) {
          await expect(
            invokeWorkspaceToolTarget(
              deps,
              authorization,
              {
                target: {
                  identity: changed === "identity" ? { ...identity, toolName: "other" } : identity,
                },
                arguments: changed === "arguments" ? { changed: true } : {},
                operationId: request.operationId,
                ...(supplyToken ? { approvalToken: approved.approvalToken } : {}),
                ...(changed === "site"
                  ? { siteArtifactId: crypto.randomUUID(), siteVersionId: crypto.randomUUID() }
                  : {}),
              },
              options,
            ),
          ).rejects.toMatchObject({ status: changed === "identity" ? 404 : 409 });
        }
      }
      expect(effects).toBe(2);
    } finally {
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  }, 180_000);
});
