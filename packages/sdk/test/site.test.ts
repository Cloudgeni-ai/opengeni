import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_REQUEST,
  OPENGENI_SITE_BRIDGE_RESPONSE,
  OPENGENI_SITE_BRIDGE_VERSION,
  createOpenGeniSiteClient,
  type OpenGeniSiteBridgeConnectMessage,
  type OpenGeniSiteBridgeRequestMessage,
} from "../src/site";
import type { ToolGatewayCatalog } from "../src/types";

const catalog: ToolGatewayCatalog = {
  version: 1,
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  generation: 1,
  digest: "a".repeat(64),
  createdAt: "2026-09-02T12:00:00.000Z",
  entries: [
    {
      identity: { serverId: "docs", toolName: "search" },
      modelName: "docs__search",
      codemodePath: ["docs", "search"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      source: "docs",
      approval: "none",
    },
  ],
};

describe("OpenGeni Site client", () => {
  test("exposes direct typed tools over one parent-held MessagePort", async () => {
    const calls: OpenGeniSiteBridgeRequestMessage[] = [];
    const hostPorts: MessagePort[] = [];
    const parentWindow = {
      postMessage: (
        message: OpenGeniSiteBridgeConnectMessage,
        targetOrigin: string,
        transfer: Transferable[],
      ) => {
        expect(message).toEqual({
          type: "opengeni.site.connect",
          version: OPENGENI_SITE_BRIDGE_VERSION,
        });
        expect(targetOrigin).toBe("*");
        const port = transfer[0] as MessagePort;
        hostPorts.push(port);
        port.addEventListener("message", (event: MessageEvent<unknown>) => {
          const request = event.data as OpenGeniSiteBridgeRequestMessage;
          calls.push(request);
          if (request.type !== OPENGENI_SITE_BRIDGE_REQUEST) return;
          port.postMessage({
            type: OPENGENI_SITE_BRIDGE_RESPONSE,
            version: OPENGENI_SITE_BRIDGE_VERSION,
            requestId: request.requestId,
            ok: true,
            value:
              request.method === "catalog"
                ? catalog
                : {
                    operationId: "00000000-0000-4000-8000-000000000003",
                    catalogDigest: catalog.digest,
                    result: {
                      content: [{ type: "text", text: "Found one document" }],
                      structuredContent: { documents: [{ id: "document-1" }] },
                    },
                  },
          });
        });
        port.start();
        port.postMessage({
          type: OPENGENI_SITE_BRIDGE_READY,
          version: OPENGENI_SITE_BRIDGE_VERSION,
        });
      },
    };
    const client = createOpenGeniSiteClient({
      parentWindow: parentWindow as unknown as Pick<Window, "postMessage">,
    });

    expect((client.tools as unknown as { then?: unknown }).then).toBeUndefined();
    expect(await client.tools.$catalog()).toEqual(catalog);
    expect(await client.tools["docs"]!["search"]!({ query: "roadmap" })).toEqual({
      documents: [{ id: "document-1" }],
    });
    expect(calls.map((call) => call.method)).toEqual(["catalog", "call"]);
    expect(calls[1]).toMatchObject({
      payload: {
        catalogDigest: catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: { query: "roadmap" },
      },
    });
    expect(calls[1]?.method === "call" ? calls[1].payload : null).not.toHaveProperty(
      "approvalToken",
    );
    await expect(
      client.tools.$approve(catalog.entries[0]!.identity, { query: "roadmap" }),
    ).rejects.toThrow("Unsupported Site bridge request");

    client.close();
    for (const port of hostPorts) port.close();
  });
});
