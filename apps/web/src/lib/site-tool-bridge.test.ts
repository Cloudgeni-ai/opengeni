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
            approval: "human",
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

describe("Site tool bridge direct calls", () => {
  test("calls an allowed live tool directly with host-owned Site context", async () => {
    const catalogCalls: Array<boolean | undefined> = [];
    let callRequest: Record<string, unknown> | null = null;
    const bridge = createSiteToolBridge({
      workspaceTools: {
        $catalog: async (options?: { refresh?: boolean }) => {
          catalogCalls.push(options?.refresh);
          return catalog("a");
        },
      } as unknown as OpenGeniWorkspaceTools,
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

    await bridge.call(
      {
        operationId,
        catalogDigest: "f".repeat(64),
        identity,
        arguments: { sku: "SKU-1" },
      },
      { signal },
    );

    expect(catalogCalls).toEqual([undefined]);
    expect(callRequest).toMatchObject({
      catalogDigest: "a".repeat(64),
      siteArtifactId: artifactId,
      siteVersionId,
    });
    expect(callRequest).not.toHaveProperty("approvalToken");
  });

  test("refreshes and retries when a call loses a catalog race", async () => {
    const catalogs = [catalog("a"), catalog("b")];
    const catalogCalls: Array<boolean | undefined> = [];
    const callDigests: string[] = [];
    const bridge = createSiteToolBridge({
      workspaceTools: {
        $catalog: async (options?: { refresh?: boolean }) => {
          catalogCalls.push(options?.refresh);
          return catalogs.shift() ?? catalog("b");
        },
      } as unknown as OpenGeniWorkspaceTools,
      workspaceId,
      artifactId,
      siteVersionId,
      requestedTools: [identity],
      callTool: async (input) => {
        callDigests.push(input.request.catalogDigest);
        if (callDigests.length === 1) throw staleCatalogError();
        return {
          operationId,
          catalogDigest: input.request.catalogDigest,
          result: { content: [{ type: "text", text: "ok" }] },
        } as ToolGatewayCallResponse;
      },
    });

    await bridge.call(
      {
        operationId,
        catalogDigest: "a".repeat(64),
        identity,
        arguments: { sku: "SKU-1" },
      },
      { signal },
    );

    expect(catalogCalls).toEqual([undefined, true]);
    expect(callDigests).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  test("does not retry when the refreshed catalog no longer exposes the Site tool", async () => {
    const catalogs = [catalog("a"), catalog("b", false)];
    let callCount = 0;
    const bridge = createSiteToolBridge({
      workspaceTools: {
        $catalog: async () => catalogs.shift() ?? catalog("b", false),
      } as unknown as OpenGeniWorkspaceTools,
      workspaceId,
      artifactId,
      siteVersionId,
      requestedTools: [identity],
      callTool: async () => {
        callCount += 1;
        throw staleCatalogError();
      },
    });

    await expect(
      bridge.call(
        {
          operationId,
          catalogDigest: "a".repeat(64),
          identity,
          arguments: { sku: "SKU-1" },
        },
        { signal },
      ),
    ).rejects.toThrow("This requested tool is not enabled in the workspace");
    expect(callCount).toBe(1);
  });
});
