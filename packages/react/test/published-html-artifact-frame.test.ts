import { describe, expect, test } from "bun:test";
import {
  SiteBridgeDocumentLease,
  SiteBridgeRequestRegistry,
  siteBridgeError,
  handleSiteBridgeRequest,
  publishedHtmlArtifactDocument,
} from "../src/components/artifacts/published-html-artifact-frame";
import { OpenGeniClient } from "@opengeni/sdk";
import { createSiteToolBridge } from "../../sdk/src/site-tool-bridge";
import {
  createOpenGeniSiteClient,
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_RESPONSE,
  OPENGENI_SITE_BRIDGE_VERSION,
  type OpenGeniSiteBridgeRequestMessage,
} from "@opengeni/sdk/site";

test("the published frame supplies the SDK only for the optional client tag", () => {
  const ordinary = "<!doctype html><main>Normal bundled Site</main>";
  expect(publishedHtmlArtifactDocument(ordinary, true)).not.toContain("createOpenGeniSiteClient");
  const optedIn =
    '<!doctype html><script src="/__opengeni/site-tools/client.js"></script><main>HTML Site</main>';
  const document = publishedHtmlArtifactDocument(optedIn, true);
  expect(document).toContain("createOpenGeniSiteClient");
  expect(document).not.toContain('src="/__opengeni/site-tools/client.js"');
  expect(document.indexOf("opengeni.site")).toBeLessThan(
    document.indexOf("createOpenGeniSiteClient"),
  );
  expect(publishedHtmlArtifactDocument(optedIn, false)).toBe(optedIn);
});

function port(): MessagePort & { closeCount: number } {
  return {
    closeCount: 0,
    close() {
      this.closeCount += 1;
    },
  } as MessagePort & { closeCount: number };
}

describe("Site bridge request ownership", () => {
  test("SDK host errors retain only proven preexecution stale codes", () => {
    for (const code of ["tool_definition_stale", "catalog_stale", "arbitrary_private_code"]) {
      for (const flags of [
        { retryable: true, outcomeUnknown: false },
        { retryable: false, outcomeUnknown: false },
        { retryable: true, outcomeUnknown: true },
      ]) {
        const result = siteBridgeError({ code: "conflict", details: { code }, ...flags });
        expect(result.code).toBe(
          flags.retryable && !flags.outcomeUnknown && code !== "arbitrary_private_code"
            ? code
            : "conflict",
        );
      }
    }
  });
  test("actual SDK → host bridge → MessagePort refreshes a warm modern Site and a missing legacy manifest", async () => {
    for (const legacy of [false, true]) {
      const identity = { serverId: "docs", toolName: "search" };
      let digest = "a".repeat(64);
      let effects = 0;
      const paths: string[] = [];
      const resolved = () => ({
        version: 1 as const,
        definitionDigest: digest,
        entry: {
          identity,
          modelName: "docs__search",
          codemodePath: ["docs", "search"],
          source: "docs" as const,
          approval: "policy" as const,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      });
      const host = new OpenGeniClient({
        baseUrl: "https://host.invalid",
        fetch: (async (input, init) => {
          const path = String(input).split("/").at(-1)!;
          const body = JSON.parse(String(init?.body));
          paths.push(path);
          if (path === "manifest")
            return Response.json({ version: 1, digest, tools: [resolved()] });
          if (path === "resolve") return Response.json(resolved());
          if (body.expectedDefinitionDigest && body.expectedDefinitionDigest !== digest)
            return Response.json(
              {
                error: {
                  code: "conflict",
                  details: { code: "tool_definition_stale" },
                  retryable: true,
                  outcomeUnknown: false,
                },
              },
              { status: 409 },
            );
          effects++;
          return Response.json({
            operationId: body.operationId,
            tool: resolved(),
            result: { content: [], structuredContent: { digest } },
          });
        }) as typeof fetch,
      });
      const createBridge = () =>
        createSiteToolBridge({
          workspaceTools: host.tools.forWorkspace("workspace"),
          workspaceId: "workspace",
          artifactId: "artifact",
          siteVersionId: "version",
          requestedTools: [identity],
          callTool: async () => {
            throw new Error("No workspace-wide legacy call");
          },
        });
      let bridge = createBridge();
      const bootstrap = new MessageChannel();
      const ports: MessagePort[] = [];
      bootstrap.port1.addEventListener("message", (event) => {
        const port = event.ports[0]!;
        ports.push(port);
        port.addEventListener("message", async (event) => {
          const message = event.data as OpenGeniSiteBridgeRequestMessage;
          const envelope = {
            type: OPENGENI_SITE_BRIDGE_RESPONSE,
            version: OPENGENI_SITE_BRIDGE_VERSION,
            requestId: message.requestId,
          };
          try {
            const value = await handleSiteBridgeRequest(
              bridge,
              message,
              new AbortController().signal,
            );
            port.postMessage({ ...envelope, ok: true, value });
          } catch (error) {
            port.postMessage({ ...envelope, ok: false, error: siteBridgeError(error) });
          }
        });
        port.start();
        port.postMessage({
          type: OPENGENI_SITE_BRIDGE_READY,
          version: OPENGENI_SITE_BRIDGE_VERSION,
          targetTools: 1,
        });
      });
      bootstrap.port1.start();
      const site = createOpenGeniSiteClient({
        bootstrapPort: bootstrap.port2,
        ...(legacy ? { toolGatewayMode: "catalog" as const } : {}),
      });
      try {
        expect(await site.tools.docs!.search!({})).toEqual({ digest });
        digest = "b".repeat(64);
        if (legacy) bridge = createBridge(); // Host replacement has no retained manifest.
        expect(await site.tools.docs!.search!({})).toEqual({ digest });
        expect(effects).toBe(2);
        expect(paths).toEqual(
          legacy
            ? ["manifest", "invoke", "manifest", "invoke"]
            : ["invoke", "invoke", "resolve", "invoke"],
        );
      } finally {
        site.close();
        bootstrap.port1.close();
        bootstrap.port2.close();
        for (const port of ports) port.close();
      }
    }
  });
  test("preserves uncertain mutation settlement in bridge errors", () => {
    expect(
      siteBridgeError(
        Object.assign(new Error("Provider settlement is unknown"), {
          code: "tool_outcome_unknown",
          retryable: false,
          outcomeUnknown: true,
        }),
      ),
    ).toEqual({
      code: "tool_outcome_unknown",
      message: "Provider settlement is unknown",
      retryable: false,
      outcomeUnknown: true,
    });
  });

  test("keeps concurrent clients independent until document teardown", () => {
    const registry = new SiteBridgeRequestRegistry();
    const firstPort = port();
    const secondPort = port();
    registry.addPort(firstPort);
    const first = registry.start(firstPort, "request-1");
    expect(first).not.toBeNull();
    expect(registry.start(firstPort, "request-1")).toBeNull();

    registry.addPort(secondPort);
    expect(first?.signal.aborted).toBe(false);
    expect(firstPort.closeCount).toBe(0);
    const second = registry.start(secondPort, "request-1");
    expect(second).not.toBeNull();

    registry.cancel(secondPort, "request-1");
    expect(second?.signal.aborted).toBe(true);
    expect(first?.signal.aborted).toBe(false);
    registry.closeAll();
    expect(first?.signal.aborted).toBe(true);
    expect(firstPort.closeCount).toBe(1);
    expect(secondPort.closeCount).toBe(1);
  });

  test("issues one document bootstrap and revokes it on iframe navigation", async () => {
    const channels: MessageChannel[] = [];
    const attached: MessagePort[] = [];
    let closeActiveCount = 0;
    const posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const lease = new SiteBridgeDocumentLease(
      (_data, ports) => attached.push(...ports),
      () => {
        closeActiveCount += 1;
      },
      () => {
        const channel = new MessageChannel();
        channels.push(channel);
        return channel;
      },
    );
    const frameWindow = {
      postMessage(message: unknown, _targetOrigin: string, transfer: Transferable[]) {
        posted.push({ message, transfer });
      },
    } as Pick<Window, "postMessage">;

    expect(lease.load(frameWindow)).toBe(true);
    expect(posted).toHaveLength(1);
    const childBootstrap = posted[0]!.transfer[0] as MessagePort;
    const toolChannel = new MessageChannel();
    childBootstrap.postMessage({ type: "opengeni.site.connect", version: 2 }, [toolChannel.port1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attached).toEqual([toolChannel.port1]);

    expect(lease.load(frameWindow)).toBe(false);
    expect(posted).toHaveLength(1);
    expect(closeActiveCount).toBe(1);
    lease.close();
    childBootstrap.close();
    toolChannel.port2.close();
    for (const channel of channels) channel.port1.close();
  });
});
