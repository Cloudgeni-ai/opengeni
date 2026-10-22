import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  createSiteToolBridge,
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_RESPONSE,
  OPENGENI_SITE_BRIDGE_VERSION,
  type OpenGeniSiteClient,
  type OpenGeniSiteClientOptions,
  type OpenGeniSiteBridgeRequestMessage,
} from "@opengeni/sdk/site";
import type { ToolGatewayResult } from "../../sdk/src/types";
import { SITE_BROWSER_RUNTIME as currentRuntime } from "../../sdk/src/site-browser-runtime.gen";
import {
  handleSiteBridgeRequest,
  siteBridgeError,
} from "../src/components/artifacts/published-html-artifact-frame";

const identity = { serverId: "docs", toolName: "search" };
const success: ToolGatewayResult = { content: [], structuredContent: { found: true } };
const clients = ["historical", "current-catalog", "current-target"] as const;
type Client = (typeof clients)[number];

// Retain the generated module as immutable test data, not current product source.
// Verify before evaluation; load via the JS module parser, without a Git dependency.
const historicalSource = await Bun.file(
  new URL("./fixtures/site-browser-runtime.e080c190.txt", import.meta.url),
).text();
const historicalHash = createHash("sha256").update(historicalSource).digest("hex");
const expectedHistoricalHash = "0db71e767389ee86cefb77823d17976d4f14f2322900e7cd72d3ada2fba057f3";
if (historicalHash !== expectedHistoricalHash) throw new Error("Historical Site fixture changed");
const { SITE_BROWSER_RUNTIME: historicalRuntime } = await import(
  `data:text/javascript;base64,${Buffer.from(historicalSource).toString("base64")}`
);

function fixture(
  client: Client,
  options: {
    result?: ToolGatewayResult;
    apiMode?: "target" | "catalog";
    drift?: boolean;
    refusal?: { code: string; retryable: boolean; outcomeUnknown: boolean };
  } = {},
) {
  const apiPaths: string[] = [];
  const messages: string[] = [];
  const operations: string[] = [];
  const responses: unknown[] = [];
  let effects = 0;
  let digest = "a".repeat(64);
  const resolved = () => ({
    version: 1 as const,
    definitionDigest: digest,
    entry: {
      identity,
      modelName: "docs__search",
      codemodePath: ["docs", "search"],
      source: "docs",
      approval: "policy" as const,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  });
  const host = new OpenGeniClient({
    baseUrl: "https://host.invalid",
    apiKey: "host-credential-must-not-cross",
    toolGatewayMode: options.apiMode ?? "target",
    fetch: (async (input, init) => {
      const path = String(input).split("/").at(-1)!;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      apiPaths.push(path);
      if (path === "resolve") return Response.json(resolved());
      if (path === "manifest" || path === "catalog") {
        const response = Response.json(
          path === "manifest"
            ? { version: 1, digest, tools: [resolved()] }
            : {
                version: 1,
                generation: 1,
                digest,
                accountId: "account",
                workspaceId: "workspace",
                createdAt: new Date().toISOString(),
                entries: [resolved().entry],
              },
        );
        if (options.drift) digest = "b".repeat(64);
        return response;
      }
      if (path !== "invoke" && path !== "calls") throw new Error(`Unexpected API path ${path}`);
      operations.push(body.operationId);
      if (options.refusal) return Response.json({ error: options.refusal }, { status: 409 });
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
        ...(path === "invoke" ? { tool: resolved() } : { catalogDigest: digest }),
        // A replay falsely succeeds, matching the original failure reproduction.
        result: effects === 1 ? (options.result ?? success) : success,
      });
    }) as typeof fetch,
  });
  const bridge = createSiteToolBridge({
    workspaceTools: host.tools.forWorkspace("workspace"),
    workspaceId: "workspace",
    artifactId: "artifact",
    siteVersionId: "version",
    requestedTools: [identity],
    callTool: ({ request }) =>
      host.callWorkspaceSiteTool("workspace", {
        ...request,
        siteArtifactId: "artifact",
        siteVersionId: "version",
      }),
  });
  const bootstrap = new MessageChannel();
  const ports: MessagePort[] = [];
  bootstrap.port1.addEventListener("message", (bootstrapEvent) => {
    const port = bootstrapEvent.ports[0]!;
    ports.push(port);
    port.addEventListener("message", async (event) => {
      const message = event.data as OpenGeniSiteBridgeRequestMessage;
      messages.push(message.method);
      const envelope = {
        type: OPENGENI_SITE_BRIDGE_RESPONSE,
        version: OPENGENI_SITE_BRIDGE_VERSION,
        requestId: message.requestId,
      };
      let response: unknown;
      try {
        response = {
          ...envelope,
          ok: true,
          value: await handleSiteBridgeRequest(bridge, message, new AbortController().signal),
        };
      } catch (error) {
        response = {
          ...envelope,
          ok: false,
          error: siteBridgeError(error, message.method === "call"),
        };
      }
      responses.push(response);
      port.postMessage(response);
    });
    port.start();
    port.postMessage({
      type: OPENGENI_SITE_BRIDGE_READY,
      version: OPENGENI_SITE_BRIDGE_VERSION,
      targetTools: 1,
    });
  });
  bootstrap.port1.start();
  const realm = {
    MessageChannel,
    AbortController,
    DOMException,
    Headers,
    Request,
    Response,
    URL,
    TextEncoder,
    TextDecoder,
    crypto,
    setTimeout,
    clearTimeout,
  } as Record<string, unknown>;
  runInNewContext(client === "historical" ? historicalRuntime : currentRuntime, realm);
  const createClient = realm.createOpenGeniSiteClient as (
    options: OpenGeniSiteClientOptions,
  ) => OpenGeniSiteClient;
  const site = createClient({
    bootstrapPort: bootstrap.port2,
    requestTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    ...(client === "current-catalog" ? { toolGatewayMode: "catalog" as const } : {}),
  });
  return {
    site,
    apiPaths,
    messages,
    operations,
    responses,
    get effects() {
      return effects;
    },
    close: () => {
      site.close();
      bootstrap.port1.close();
      bootstrap.port2.close();
      for (const port of ports) port.close();
    },
  };
}

test("historical built runtime fixture is the exact retained source blob", () => {
  expect(historicalHash).toBe(expectedHistoricalHash);
});

describe.each([...clients])(
  "%s built Site runtime through the current host MessagePort",
  (client) => {
    test("executed stale-named provider errors never authorize another effect and retain diagnostics", async () => {
      for (const apiMode of client === "current-target"
        ? (["target"] as const)
        : (["target", "catalog"] as const))
        for (const code of ["catalog_stale", "tool_definition_stale"])
          for (const flags of [
            { retryable: false, outcomeUnknown: true },
            { retryable: false, outcomeUnknown: false },
            { retryable: true, outcomeUnknown: false },
            {},
          ]) {
            const originalError = {
              code,
              message: "Provider diagnostic",
              ...flags,
              details: { reason: "provider-owned" },
            };
            const result: ToolGatewayResult = {
              isError: true,
              content: [{ type: "text", text: "Original provider content" }],
              structuredContent: { error: originalError, extra: { retained: true } },
            };
            const f = fixture(client, { apiMode, result });
            const operationId = crypto.randomUUID();
            try {
              const failure = await f.site.tools.docs!.search!(
                { query: "argument-must-not-leak" },
                { operationId, approvalToken: "approval-token-must-not-leak" },
              ).then(
                () => undefined,
                (error) => error,
              );
              expect(f.effects).toBe(1);
              expect(failure).toBeDefined();
              expect(f.operations).toEqual([operationId]);
              expect(f.messages).toEqual(
                client === "current-target" ? ["invoke"] : ["catalog", "call"],
              );
              expect(failure.result.content).toEqual(result.content);
              expect(failure.result.structuredContent.extra).toEqual({ retained: true });
              if (client === "current-target") {
                expect(failure.code).toBe(code);
                expect(failure.result).toEqual(result);
              } else {
                expect(failure.code).toBe("site_tool_execution_failed");
                expect(failure.retryable).toBe(false);
                expect(failure.result.structuredContent.error.providerError).toEqual(originalError);
              }
              expect(failure.message).toBe("Provider diagnostic");
              const wire = JSON.stringify(f.responses);
              expect(wire).not.toContain("argument-must-not-leak");
              expect(wire).not.toContain("host-credential-must-not-cross");
              expect(wire).not.toContain("approval-token-must-not-leak");
            } finally {
              f.close();
            }
          }
    });

    test("ordinary provider errors and success outputs are unchanged", async () => {
      for (const result of [
        {
          isError: true,
          content: [],
          structuredContent: {
            error: { code: "provider_unavailable", message: "Preserved", details: [1, 2] },
          },
        },
        {
          isError: false,
          content: [],
          structuredContent: { error: { code: "catalog_stale" }, ordinaryData: true },
        },
      ]) {
        const f = fixture(client, { result });
        try {
          if (result.isError) {
            const error = await f.site.tools.docs!.search!({}).then(
              () => undefined,
              (rejection) => rejection,
            );
            expect(error.code).toBe("provider_unavailable");
            expect(error.result).toEqual(result);
          } else {
            expect(await f.site.tools.docs!.search!({})).toEqual(result.structuredContent);
          }
          expect(f.effects).toBe(1);
          expect(f.responses.at(-1)).toMatchObject({ ok: true, value: { result } });
        } finally {
          f.close();
        }
      }
    });
  },
);

test.each(["historical", "current-catalog"] as const)(
  "%s still refreshes on a genuine preexecution stale control signal",
  async (client) => {
    const f = fixture(client, { drift: true });
    const operationId = crypto.randomUUID();
    try {
      expect(await f.site.tools.docs!.search!({}, { operationId })).toEqual(
        success.structuredContent,
      );
      expect(f.messages).toEqual(["catalog", "call", "catalog", "call"]);
      expect(f.apiPaths).toEqual(["manifest", "invoke", "manifest", "invoke"]);
      expect(f.operations).toEqual([operationId, operationId]);
      expect(f.effects).toBe(1);
    } finally {
      f.close();
    }
  },
);

test("historical client cannot treat uncertain transport error codes as preexecution control", async () => {
  for (const code of ["catalog_stale", "tool_definition_stale"])
    for (const flags of [
      { retryable: true, outcomeUnknown: true },
      { retryable: false, outcomeUnknown: false },
    ]) {
      const f = fixture("historical", { refusal: { code, ...flags } });
      try {
        await expect(f.site.tools.docs!.search!({})).rejects.toMatchObject({
          code: "site_tool_call_failed",
          ...flags,
        });
        expect(f.operations).toHaveLength(1);
        expect(f.messages).toEqual(["catalog", "call"]);
        expect(JSON.stringify(f.responses.at(-1))).toContain(code);
      } finally {
        f.close();
      }
    }
});
