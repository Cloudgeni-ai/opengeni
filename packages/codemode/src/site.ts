import { siteRequestHeaders } from "@opengeni/contracts/site-session-http";
import { randomUUID } from "node:crypto";
import { generateToolDeclarations, digestToolGatewayDefinition } from "@opengeni/tool-gateway";
import { ToolGatewayResolveRequest, ToolGatewayInvokeRequest } from "@opengeni/contracts";
import { SITE_BROWSER_RUNTIME, SITE_CLIENT_SCRIPT_PATH } from "@opengeni/sdk/site-document";

import { CodemodeClient, CodemodeTransportError } from "./index";
import { environmentCodemodeClient, type CodemodeClientProvider } from "./environment";

export const CODEMODE_SITE_LOCAL_PATH = "/__opengeni/site-tools" as const;

export type CodemodeSiteRequestHandler = (request: Request) => Promise<Response>;

/**
 * Same-origin local Site preview adapter. The Bun host retains the exact
 * attempt bearer; browser code receives only the ordinary Site tool protocol.
 */
export function createCodemodeSiteRequestHandler(
  client: CodemodeClient | CodemodeClientProvider = () => environmentCodemodeClient(),
): CodemodeSiteRequestHandler {
  const provide = typeof client === "function" ? client : () => client;
  return async (request) => {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === SITE_CLIENT_SCRIPT_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        return new Response(request.method === "HEAD" ? null : SITE_BROWSER_RUNTIME, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache",
          },
        });
      }
      const active = await provide();
      if (
        request.method === "POST" &&
        (pathname === `${CODEMODE_SITE_LOCAL_PATH}/resolve` ||
          pathname === `${CODEMODE_SITE_LOCAL_PATH}/invoke`)
      ) {
        const invoking = pathname.endsWith("/invoke");
        const body: unknown = await request.json().catch(() => null);
        const parsed = (invoking ? ToolGatewayInvokeRequest : ToolGatewayResolveRequest).safeParse(
          body,
        );
        if (
          !parsed.success ||
          parsed.data.siteArtifactId ||
          parsed.data.siteVersionId ||
          ("approvalToken" in parsed.data && parsed.data.approvalToken)
        )
          return siteError(400, "invalid_request", "Invalid Site target request");
        const catalog = await active.catalog({ signal: request.signal });
        const target = parsed.data.target;
        const entries = catalog.entries.filter((entry) =>
          "identity" in target
            ? entry.identity.serverId === target.identity.serverId &&
              entry.identity.toolName === target.identity.toolName
            : entry.codemodePath.length === target.path.length &&
              entry.codemodePath.every((part, index) => part === target.path[index]),
        );
        if (entries.length !== 1) return siteError(404, "tool_unavailable", "Tool unavailable");
        const entry = entries[0]!;
        const tool = {
          version: 1,
          entry,
          definitionDigest: digestToolGatewayDefinition(catalog, entry),
        };
        if (!invoking) return Response.json(tool);
        const input = ToolGatewayInvokeRequest.parse(body);
        if (
          input.expectedDefinitionDigest !== undefined &&
          input.expectedDefinitionDigest !== tool.definitionDigest
        )
          return siteError(409, "tool_definition_stale", "The tool definition changed", true);
        request.signal.throwIfAborted();
        const result = await active.call(entry.identity, input.arguments, {
          operationId: input.operationId,
          expectedDefinitionDigest: tool.definitionDigest,
          signal: request.signal,
        });
        return Response.json({ operationId: input.operationId, tool, result });
      }
      if (pathname.startsWith(`${CODEMODE_SITE_LOCAL_PATH}/sdk/`)) {
        const path =
          pathname.slice(`${CODEMODE_SITE_LOCAL_PATH}/sdk`.length) + new URL(request.url).search;
        const response = await active.sessionRequest(path, {
          method: request.method,
          signal: request.signal,
          headers: siteRequestHeaders(request.headers),
          ...(request.body ? { body: await request.text() } : {}),
        });
        // Fetch decodes compressed upstream bodies. Forward decoded bytes with
        // fresh transport headers, or the preview browser decompresses twice.
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      if (request.method === "GET" && pathname === `${CODEMODE_SITE_LOCAL_PATH}/catalog`) {
        const catalog = await active.catalog({ signal: request.signal });
        return Response.json(projectSiteCatalog(catalog));
      }
      if (request.method === "GET" && pathname === `${CODEMODE_SITE_LOCAL_PATH}/declarations`) {
        const catalog = await active.catalog({ signal: request.signal });
        return Response.json({
          catalogDigest: catalog.digest,
          moduleSpecifier: "@opengeni/sdk",
          source: generateToolDeclarations(
            { digest: catalog.digest, entries: catalog.entries },
            {
              moduleSpecifier: "@opengeni/sdk",
              interfaceName: "OpenGeniGeneratedTools",
              callOptionsType: "OpenGeniToolCallOptions",
              fallbackResultType: "ToolGatewayResult",
              generatedBy: "@opengeni/codemode local Site preview",
              catalogDigestLabel: "Attempt catalog digest",
            },
          ),
        });
      }
      if (request.method === "POST" && pathname === `${CODEMODE_SITE_LOCAL_PATH}/calls`) {
        const body = await request.json();
        if (!isSiteCall(body)) return siteError(400, "invalid_request", "Invalid Site tool call");
        const catalog = await active.catalog({ signal: request.signal });
        if (body.catalogDigest !== catalog.digest) {
          return siteError(409, "catalog_stale", "The local Site tool catalog changed", true);
        }
        const operationId = body.operationId ?? randomUUID();
        const entry = catalog.entries.find(
          (entry) =>
            entry.identity.serverId === body.identity.serverId &&
            entry.identity.toolName === body.identity.toolName,
        );
        if (!entry) return siteError(404, "tool_unavailable", "Tool unavailable");
        const result = await active.call(body.identity, body.arguments, {
          operationId,
          expectedDefinitionDigest: digestToolGatewayDefinition(catalog, entry),
          signal: request.signal,
        });
        return Response.json({
          operationId,
          catalogDigest: catalog.digest,
          result,
        });
      }
      return siteError(404, "not_found", "Local Site tool endpoint not found");
    } catch (error) {
      if (error instanceof CodemodeTransportError) {
        const staleLegacyPin =
          new URL(request.url).pathname === `${CODEMODE_SITE_LOCAL_PATH}/calls` &&
          error.remoteCode === "tool_definition_stale" &&
          error.retryable === true &&
          error.outcomeUnknown === false;
        return siteError(
          error.status && error.status >= 400 && error.status <= 599 ? error.status : 502,
          staleLegacyPin ? "catalog_stale" : (error.remoteCode ?? error.code),
          error.message,
          error.retryable === true,
          error.outcomeUnknown === true,
        );
      }
      return siteError(
        500,
        "local_codemode_error",
        error instanceof Error ? error.message : "Local Site tool request failed",
      );
    }
  };
}

function projectSiteCatalog(catalog: Awaited<ReturnType<CodemodeClient["catalog"]>>) {
  return {
    version: catalog.version,
    generation: catalog.generation,
    digest: catalog.digest,
    createdAt: catalog.createdAt,
    entries: catalog.entries,
  };
}

function isSiteCall(value: unknown): value is {
  operationId?: string;
  catalogDigest: string;
  identity: { serverId: string; toolName: string };
  arguments: Record<string, unknown>;
} {
  if (!isRecord(value) || typeof value.catalogDigest !== "string") return false;
  if (value.operationId !== undefined && typeof value.operationId !== "string") return false;
  return (
    isRecord(value.identity) &&
    typeof value.identity.serverId === "string" &&
    typeof value.identity.toolName === "string" &&
    isRecord(value.arguments)
  );
}

function siteError(
  status: number,
  code: string,
  message: string,
  retryable = false,
  outcomeUnknown = false,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        retryable,
        ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
      },
    },
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
