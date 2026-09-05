import { randomUUID } from "node:crypto";
import { generateToolDeclarations } from "@opengeni/tool-gateway";

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
      const active = await provide();
      const pathname = new URL(request.url).pathname;
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
        const result = await active.call(body.identity, body.arguments, {
          operationId,
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
        return siteError(
          error.status && error.status >= 400 && error.status <= 599 ? error.status : 502,
          error.remoteCode ?? error.code,
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
