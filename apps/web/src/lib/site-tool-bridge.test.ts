import { describe, expect, test } from "bun:test";
import {
  OpenGeniApiError,
  type OpenGeniWorkspaceTools,
  type ToolGatewayCallResponse,
  type ToolGatewayCatalog,
} from "@opengeni/sdk";

import { createSiteToolBridge } from "./site-tool-bridge";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const siteVersionId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const identity = { serverId: "inventory", toolName: "lookup" };
const signal = new AbortController().signal;

function catalog(digestCharacter: string, includeTool = true): ToolGatewayCatalog {
  return {
    version: 1,
    accountId: "55555555-5555-4555-8555-555555555555",
    workspaceId,
    generation: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
    digest: digestCharacter.repeat(64),
    entries: includeTool
      ? [
          {
            identity,
            modelName: "inventory__lookup",
            codemodePath: ["inventory", "lookup"],
            title: "Inventory lookup",
            description: "Looks up inventory",
            inputSchema: { type: "object" },
            source: "mcp",
            approval: "none",
          },
        ]
      : [],
  };
}

function staleCatalogError(): OpenGeniApiError {
  return new OpenGeniApiError(
    409,
    JSON.stringify({
      error: {
        status: 409,
        code: "conflict",
        message: "The workspace tool catalog changed; retry with the current catalog.",
        retryable: true,
        details: { code: "catalog_stale" },
      },
    }),
    { mutation: true },
  );
}

describe("Site tool bridge catalog refresh", () => {
  test("retries stale approval and calls with the newly approved catalog digest", async () => {
    const catalogs = [catalog("a"), catalog("b"), catalog("c")];
    const catalogCalls: Array<boolean | undefined> = [];
    let approvalCalls = 0;
    let callRequest: Record<string, unknown> | null = null;
    const workspaceTools = {
      $catalog: async (options?: { refresh?: boolean }) => {
        catalogCalls.push(options?.refresh);
        return catalogs.shift() ?? catalog("c");
      },
      $approve: async () => {
        approvalCalls += 1;
        if (approvalCalls === 1) throw staleCatalogError();
        return {
          operationId,
          approvalToken: `ogta_${"x".repeat(43)}`,
          expiresAt: "2026-09-02T00:05:00.000Z",
        };
      },
    } as unknown as OpenGeniWorkspaceTools;
    const bridge = createSiteToolBridge({
      workspaceTools,
      workspaceId,
      artifactId,
      siteVersionId,
      requestedTools: [identity],
      callTool: async (input) => {
        callRequest = input.request;
        return {
          operationId,
          catalogDigest: input.request.catalogDigest,
          result: { content: [{ type: "text", text: "ok" }] },
        } as ToolGatewayCallResponse;
      },
    });

    expect((await bridge.catalog({ signal })).digest).toBe("a".repeat(64));
    const approval = await bridge.approve(
      {
        operationId,
        catalogDigest: "a".repeat(64),
        identity,
        arguments: { sku: "SKU-1" },
      },
      { signal },
    );
    await bridge.call(
      {
        operationId,
        approvalToken: approval.approvalToken,
        catalogDigest: "a".repeat(64),
        identity,
        arguments: { sku: "SKU-1" },
      },
      { signal },
    );

    expect(catalogCalls).toEqual([undefined, true, true]);
    expect(approvalCalls).toBe(2);
    expect(callRequest).toMatchObject({
      catalogDigest: "c".repeat(64),
      siteArtifactId: artifactId,
      siteVersionId,
    });
  });

  test("stops the retry when the refreshed catalog no longer exposes the Site tool", async () => {
    const catalogs = [catalog("a"), catalog("b"), catalog("c", false)];
    let approvalCalls = 0;
    const bridge = createSiteToolBridge({
      workspaceTools: {
        $catalog: async () => catalogs.shift() ?? catalog("c", false),
        $approve: async () => {
          approvalCalls += 1;
          throw staleCatalogError();
        },
      } as unknown as OpenGeniWorkspaceTools,
      workspaceId,
      artifactId,
      siteVersionId,
      requestedTools: [identity],
    });

    await bridge.catalog({ signal });
    await expect(
      bridge.approve(
        {
          operationId,
          catalogDigest: "a".repeat(64),
          identity,
          arguments: { sku: "SKU-1" },
        },
        { signal },
      ),
    ).rejects.toThrow("This requested tool is not enabled in the workspace");
    expect(approvalCalls).toBe(1);
  });

  test("refreshes both catalog caches when the approved call races another catalog change", async () => {
    const catalogs = [catalog("a"), catalog("b"), catalog("c")];
    const catalogCalls: Array<boolean | undefined> = [];
    const bridge = createSiteToolBridge({
      workspaceTools: {
        $catalog: async (options?: { refresh?: boolean }) => {
          catalogCalls.push(options?.refresh);
          return catalogs.shift() ?? catalog("c");
        },
        $approve: async () => ({
          operationId,
          approvalToken: `ogta_${"x".repeat(43)}`,
          expiresAt: "2026-09-02T00:05:00.000Z",
        }),
      } as unknown as OpenGeniWorkspaceTools,
      workspaceId,
      artifactId,
      siteVersionId,
      requestedTools: [identity],
      callTool: async () => {
        throw staleCatalogError();
      },
    });

    await bridge.catalog({ signal });
    const approval = await bridge.approve(
      {
        operationId,
        catalogDigest: "a".repeat(64),
        identity,
        arguments: { sku: "SKU-1" },
      },
      { signal },
    );
    await expect(
      bridge.call(
        {
          operationId,
          approvalToken: approval.approvalToken,
          catalogDigest: "a".repeat(64),
          identity,
          arguments: { sku: "SKU-1" },
        },
        { signal },
      ),
    ).rejects.toBeInstanceOf(OpenGeniApiError);

    expect(catalogCalls).toEqual([undefined, true, true]);
    expect((await bridge.catalog({ signal })).digest).toBe("c".repeat(64));
  });
});
