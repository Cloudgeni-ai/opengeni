import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL,
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_REQUEST,
  OPENGENI_SITE_BRIDGE_RESPONSE,
  OPENGENI_SITE_BRIDGE_VERSION,
  createOpenGeniSiteClient,
  sanitizeOpenGeniSiteToolCallRequest,
  type OpenGeniSiteBridgeConnectMessage,
  type OpenGeniSiteBridgeRequestMessage,
} from "../src/site";
import type { OpenGeniSiteToolCatalog } from "../src/site";

const catalog: OpenGeniSiteToolCatalog = {
  version: 1,
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
  test("strips host-only approval and Site transport authority", () => {
    expect(
      sanitizeOpenGeniSiteToolCallRequest({
        operationId: "00000000-0000-4000-8000-000000000003",
        catalogDigest: catalog.digest,
        identity: catalog.entries[0]!.identity,
        arguments: { query: "roadmap" },
        approvalToken: `ogta_${"a".repeat(43)}`,
        siteArtifactId: "00000000-0000-4000-8000-000000000004",
        siteVersionId: "00000000-0000-4000-8000-000000000005",
        siteApprovalBypass: true,
      }),
    ).toEqual({
      operationId: "00000000-0000-4000-8000-000000000003",
      catalogDigest: catalog.digest,
      identity: catalog.entries[0]!.identity,
      arguments: { query: "roadmap" },
    });
  });

  test("exposes direct typed tools over one parent-held MessagePort", async () => {
    const calls: OpenGeniSiteBridgeRequestMessage[] = [];
    const hostPorts: MessagePort[] = [];
    const bootstrap = new MessageChannel();
    bootstrap.port1.addEventListener("message", (bootstrapEvent: MessageEvent<unknown>) => {
      const message = bootstrapEvent.data as OpenGeniSiteBridgeConnectMessage;
      const port = bootstrapEvent.ports[0] as MessagePort;
      expect(message).toEqual({
        type: "opengeni.site.connect",
        version: OPENGENI_SITE_BRIDGE_VERSION,
      });
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
    });
    bootstrap.port1.start();
    const client = createOpenGeniSiteClient({
      bootstrapPort: bootstrap.port2,
    });

    expect((client.tools as unknown as { then?: unknown }).then).toBeUndefined();
    expect(await client.tools.$catalog()).toEqual(catalog);
    expect(await client.tools.$catalog()).not.toHaveProperty("accountId");
    expect(await client.tools.$catalog()).not.toHaveProperty("workspaceId");
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
    expect(calls[1]?.method === "call" ? calls[1].payload : null).not.toHaveProperty(
      "siteVersionId",
    );
    expect(calls[1]?.method === "call" ? calls[1].payload : null).not.toHaveProperty(
      "siteArtifactId",
    );
    await expect(
      client.tools.$approve(catalog.entries[0]!.identity, { query: "roadmap" }),
    ).rejects.toThrow("Unsupported Site bridge request");

    client.close();
    bootstrap.port1.close();
    for (const port of hostPorts) port.close();
  });

  test("connects after load through the document-retained bootstrap port", async () => {
    const bootstrap = new MessageChannel();
    const hostPorts: MessagePort[] = [];
    bootstrap.port1.addEventListener("message", (bootstrapEvent: MessageEvent<unknown>) => {
      const port = bootstrapEvent.ports[0] as MessagePort;
      hostPorts.push(port);
      port.addEventListener("message", (event: MessageEvent<unknown>) => {
        const request = event.data as OpenGeniSiteBridgeRequestMessage;
        port.postMessage({
          type: OPENGENI_SITE_BRIDGE_RESPONSE,
          version: OPENGENI_SITE_BRIDGE_VERSION,
          requestId: request.requestId,
          ok: true,
          value: catalog,
        });
      });
      port.start();
      port.postMessage({
        type: OPENGENI_SITE_BRIDGE_READY,
        version: OPENGENI_SITE_BRIDGE_VERSION,
      });
    });
    bootstrap.port1.start();
    const parentWindow = {} as MessageEventSource;
    const siteWindow = {
      parent: parentWindow,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Pick<Window, "parent" | "addEventListener" | "removeEventListener">;
    Object.defineProperty(siteWindow, OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL, {
      configurable: true,
      value: { port: bootstrap.port2 },
    });

    const client = createOpenGeniSiteClient({ siteWindow, parentWindow });
    expect(await client.tools.$catalog()).toEqual(catalog);

    client.close();
    bootstrap.port1.close();
    bootstrap.port2.close();
    for (const port of hostPorts) port.close();
  });

  test("preserves uncertain mutation settlement from the host bridge", async () => {
    const hostPorts: MessagePort[] = [];
    const bootstrap = new MessageChannel();
    bootstrap.port1.addEventListener("message", (bootstrapEvent: MessageEvent<unknown>) => {
      const port = bootstrapEvent.ports[0] as MessagePort;
      hostPorts.push(port);
      port.addEventListener("message", (event: MessageEvent<unknown>) => {
        const request = event.data as OpenGeniSiteBridgeRequestMessage;
        port.postMessage({
          type: OPENGENI_SITE_BRIDGE_RESPONSE,
          version: OPENGENI_SITE_BRIDGE_VERSION,
          requestId: request.requestId,
          ok: false,
          error: {
            code: "tool_outcome_unknown",
            message: "Provider settlement is unknown",
            retryable: false,
            outcomeUnknown: true,
          },
        });
      });
      port.start();
      port.postMessage({
        type: OPENGENI_SITE_BRIDGE_READY,
        version: OPENGENI_SITE_BRIDGE_VERSION,
      });
    });
    bootstrap.port1.start();
    const client = createOpenGeniSiteClient({
      bootstrapPort: bootstrap.port2,
    });

    await expect(client.tools.$catalog()).rejects.toMatchObject({
      code: "tool_outcome_unknown",
      retryable: false,
      outcomeUnknown: true,
    });
    client.close();
    bootstrap.port1.close();
    for (const port of hostPorts) port.close();
  });

  test("marks a timed-out tool call as outcome unknown instead of retryable", async () => {
    const bootstrap = new MessageChannel();
    const hostPorts: MessagePort[] = [];
    bootstrap.port1.addEventListener("message", (bootstrapEvent: MessageEvent<unknown>) => {
      const port = bootstrapEvent.ports[0] as MessagePort;
      hostPorts.push(port);
      port.addEventListener("message", (event: MessageEvent<unknown>) => {
        const request = event.data as OpenGeniSiteBridgeRequestMessage;
        if (request.method !== "catalog") return;
        port.postMessage({
          type: OPENGENI_SITE_BRIDGE_RESPONSE,
          version: OPENGENI_SITE_BRIDGE_VERSION,
          requestId: request.requestId,
          ok: true,
          value: catalog,
        });
      });
      port.start();
      port.postMessage({
        type: OPENGENI_SITE_BRIDGE_READY,
        version: OPENGENI_SITE_BRIDGE_VERSION,
      });
    });
    bootstrap.port1.start();
    const client = createOpenGeniSiteClient({
      bootstrapPort: bootstrap.port2,
      requestTimeoutMs: 5,
    });

    await expect(client.tools["docs"]!["search"]!({ query: "roadmap" })).rejects.toMatchObject({
      code: "timeout",
      retryable: false,
      outcomeUnknown: true,
    });
    client.close();
    bootstrap.port1.close();
    for (const port of hostPorts) port.close();
  });
});
