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
  callWorkspaceToolGateway,
  prepareWorkspaceToolGateway,
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
  test("lists the live server's tools, answers a dead server's call with try again, and keeps targeted preparation strict", async () => {
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
    try {
      // Untargeted (catalog, app tool list): the dead server is left out.
      const prepared = await prepareWorkspaceToolGateway(deps, authorization);
      try {
        const identities = prepared.toolGatewayCatalog.entries.map(
          (entry) => `${entry.identity.serverId}/${entry.identity.toolName}`,
        );
        expect(identities).toContain("live-probe/search_documents");
        expect(identities.some((identity) => identity.startsWith("dead-probe/"))).toBe(false);
        // Calling the dead server's tool says "try again", not tool_not_found.
        const failure = await callWorkspaceToolGateway(prepared, grant, {
          identity: deadIdentity,
          arguments: { query: "x" },
          catalogDigest: prepared.toolGatewayCatalog.digest,
          operationId: crypto.randomUUID(),
        }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({
          status: 503,
          retryable: true,
          details: { code: "tool_server_unreachable" },
        });
      } finally {
        await prepared.close();
      }
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
    } finally {
      await provider.stop(true);
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  }, 120_000);
});
