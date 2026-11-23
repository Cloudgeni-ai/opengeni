// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { bootstrapWorkspace, createDb, deleteWorkspace, type DbClient } from "@opengeni/db";
import { accessGrantAuthorizationFromContext, type ApiRouteDeps } from "@opengeni/core";
import { createTargetFence } from "../src/workspace-tool-target";
import {
  callWorkspaceToolGatewayForCaller,
  prepareAttestedWorkspaceToolGateway,
  prepareWorkspaceToolGateway,
  prepareWorkspaceToolGatewayForGrant,
} from "../src/workspace-tool-gateway";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("tool-catalog-unreachable");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("Real PostgreSQL required");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("untargeted tool gateway preparation with an unreachable MCP server on PostgreSQL", () => {
  test("the catalog and calls to live tools leave the dead server out; calls to it stay strict", async () => {
    if (!client || !shared) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "tool-catalog-unreachable",
      accountExternalId: suffix,
      accountName: "Tool catalog unreachable",
      workspaceExternalSource: "tool-catalog-unreachable",
      workspaceExternalId: suffix,
      workspaceName: "Tool catalog unreachable",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const authorization = accessGrantAuthorizationFromContext(access, grant);
    authorization.canonicalManagedHumanSession = true;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const mcp = new McpServer({ name: "live-probe", version: "1.0.0" });
        mcp.registerTool("search_documents", { inputSchema: { query: z.string() } }, async () => ({
          content: [{ type: "text", text: "ok" }],
        }));
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await mcp.connect(transport);
        return transport.handleRequest(request);
      },
    });
    const settings = testSettings({
      mcpServers: [
        { id: "live-probe", url: `${provider.url}mcp`, cacheToolsList: false },
        // A custom server whose host no longer resolves.
        { id: "dead-probe", url: "https://dead.opengeni-audit.invalid/mcp", cacheToolsList: false },
      ],
    });
    const deps = { db: client.db, settings } as ApiRouteDeps;
    const deadIdentity = { serverId: "dead-probe", toolName: "search_documents" };
    const liveIdentity = { serverId: "live-probe", toolName: "search_documents" };
    try {
      // GET /tools/catalog and /tools/declarations: the dead server is left out.
      const prepared = await prepareAttestedWorkspaceToolGateway(deps, authorization, undefined);
      let catalogDigest: string;
      try {
        catalogDigest = prepared.toolGatewayCatalog.digest;
        const identities = prepared.toolGatewayCatalog.entries.map(
          (entry) => `${entry.identity.serverId}/${entry.identity.toolName}`,
        );
        expect(identities).toContain("live-probe/search_documents");
        expect(identities.some((identity) => identity.startsWith("dead-probe/"))).toBe(false);
      } finally {
        await prepared.close();
      }
      // POST /tools/calls without a remembered catalog (another replica, an
      // expired attestation or an approval token): the live tool still runs.
      const live = await callWorkspaceToolGatewayForCaller(deps, authorization, {
        operationId: crypto.randomUUID(),
        catalogDigest,
        identity: liveIdentity,
        arguments: { query: "x" },
      });
      expect(live.timing.scope).toBe("complete");
      expect(live.response.catalogDigest).toBe(catalogDigest);
      expect(JSON.stringify(live.response.result)).toContain('"ok"');
      // A call to the dead server's tool reports that server's failure.
      expect(
        await callWorkspaceToolGatewayForCaller(deps, authorization, {
          operationId: crypto.randomUUID(),
          catalogDigest,
          identity: deadIdentity,
          arguments: { query: "x" },
        }).then(
          () => null,
          (error: unknown) => error,
        ),
      ).not.toBeNull();
      const fails = (promise: Promise<{ close: () => Promise<void> }>) =>
        promise.then(
          async (result) => {
            await result.close();
            return null;
          },
          (error: unknown) => error,
        );
      // A preparation that names neither a listing nor a call keeps every server.
      expect(await fails(prepareWorkspaceToolGateway(deps, authorization))).not.toBeNull();
      // Targeted at the dead server: its own failure is still reported.
      const fence = createTargetFence(
        deps,
        authorization,
        { reauthorize: async () => undefined },
        true,
      );
      try {
        const targeted = await prepareWorkspaceToolGateway(deps, authorization, {
          target: { identity: deadIdentity },
          firstPartySettings: "caller",
          fence,
        }).then(
          async (result) => {
            await result.close();
            return null;
          },
          (error: unknown) => error,
        );
        expect(targeted).not.toBeNull();
      } finally {
        fence.close();
      }
      // One server's identities (as app sync prepares): its own failure too.
      expect(
        await fails(prepareWorkspaceToolGatewayForGrant(deps, grant, [deadIdentity])),
      ).not.toBeNull();
    } finally {
      await provider.stop(true);
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  }, 120_000);
});
