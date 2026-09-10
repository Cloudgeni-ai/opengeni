import { OpenGeniApiError } from "./errors";
import { siteSessionPath, type SiteHttpRequest } from "./site-http";
import type { OpenGeniSiteToolCatalog } from "./site";
import type { OpenGeniWorkspaceTools } from "./tools";
import type { ToolGatewayCallRequest, ToolGatewayCallResponse, ToolGatewayIdentity } from "./types";

export type SiteToolCallRequest = ToolGatewayCallRequest & {
  siteArtifactId: string;
  siteVersionId: string;
};
export type SiteToolCaller = (input: {
  workspaceId: string;
  request: SiteToolCallRequest;
  signal: AbortSignal;
}) => Promise<ToolGatewayCallResponse>;
export type SiteToolBridge = {
  fetch?: (request: SiteHttpRequest, signal: AbortSignal) => Promise<Response>;
  catalog: (options: { signal: AbortSignal }) => Promise<OpenGeniSiteToolCatalog>;
  call: (
    request: ToolGatewayCallRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayCallResponse>;
};
export type CreateSiteToolBridgeOptions = {
  workspaceTools: Pick<OpenGeniWorkspaceTools, "$catalog">;
  workspaceId: string;
  artifactId: string;
  siteVersionId: string;
  requestedTools: readonly ToolGatewayIdentity[];
  callTool: SiteToolCaller;
  isCatalogStale?: (error: unknown) => boolean;
  /** Optional authenticated host transport for the host-bound workspace API.
   * Omit to expose tools only. Site-provided authorization headers are never forwarded. */
  fetchResponse?: (path: string, init: RequestInit) => Promise<Response>;
};

/** Host-side bridge for the opaque Site frame. Supply an authenticated transport;
 * the server independently checks live viewer access and the exact Site version.
 * Recreate on actor/version change. Never take these pinned fields from HTML. */
export function createSiteToolBridge(input: CreateSiteToolBridgeOptions): SiteToolBridge {
  const allowed = new Set(input.requestedTools.map(identityKey));
  let projectedCatalog: OpenGeniSiteToolCatalog | null = null;
  const loadCatalog = async ({
    signal,
    refresh = false,
  }: {
    signal: AbortSignal;
    refresh?: boolean;
  }): Promise<OpenGeniSiteToolCatalog> => {
    signal.throwIfAborted();
    if (projectedCatalog && !refresh) return projectedCatalog;
    const current = await input.workspaceTools.$catalog({
      signal,
      ...(refresh ? { refresh } : {}),
    });
    signal.throwIfAborted();
    if (current.workspaceId !== input.workspaceId)
      throw new Error("Site catalog workspace mismatch");
    projectedCatalog = {
      version: current.version,
      generation: current.generation,
      digest: current.digest,
      createdAt: current.createdAt,
      entries: current.entries.filter((entry) => allowed.has(identityKey(entry.identity))),
    };
    return projectedCatalog;
  };
  return {
    ...(input.fetchResponse
      ? {
          fetch: async (message: SiteHttpRequest, signal: AbortSignal) => {
            const path = siteSessionPath(
              message.path,
              input.workspaceId,
              message.method,
              input.artifactId,
            );
            const headers = new Headers();
            headers.set("x-opengeni-site-id", input.artifactId);
            headers.set("x-opengeni-site-version", input.siteVersionId);
            for (const [name, value] of message.headers) {
              if (["content-type", "accept", "last-event-id"].includes(name.toLowerCase()))
                headers.set(name, value);
            }
            return input.fetchResponse!(path, {
              method: message.method,
              signal,
              headers: Object.fromEntries(headers),
              ...(message.body === undefined ? {} : { body: message.body }),
            });
          },
        }
      : {}),
    catalog: loadCatalog,
    call: async (request, { signal }) => {
      if (!allowed.has(identityKey(request.identity)))
        throw new Error("This tool is not available to the Site");
      const call = async (refresh = false) => {
        const catalog = await loadCatalog({ signal, refresh });
        if (
          !catalog.entries.some(
            (entry) => identityKey(entry.identity) === identityKey(request.identity),
          )
        )
          throw new Error("This requested tool is not enabled in the workspace");
        return input.callTool({
          workspaceId: input.workspaceId,
          signal,
          request: {
            ...(request.operationId ? { operationId: request.operationId } : {}),
            catalogDigest: catalog.digest,
            identity: request.identity,
            arguments: request.arguments,
            siteArtifactId: input.artifactId,
            siteVersionId: input.siteVersionId,
          },
        });
      };
      try {
        return await call();
      } catch (error) {
        // Only pre-execution catalog rejection permits one retry. Never retry
        // transport failures, expired credentials or uncertain tool effects.
        if (!(input.isCatalogStale ?? isSiteCatalogStaleError)(error)) throw error;
        projectedCatalog = null;
        return await call(true);
      }
    },
  };
}

export function isSiteCatalogStaleError(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    error.status === 409 &&
    error.details?.code === "catalog_stale"
  );
}
function identityKey(identity: ToolGatewayIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}
