import { siteRequestHeaders } from "@opengeni/contracts/site-session-http";
import { OpenGeniApiError } from "./errors";
import { createSharedCatalogLoader } from "./shared-catalog-loader";
import { siteSessionPath, type SiteHttpRequest } from "./site-http";
import type { OpenGeniSiteToolCatalog } from "./site";
import type { OpenGeniWorkspaceTools } from "./tools";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayIdentity,
  ToolGatewayResolveRequest,
  ToolGatewayResolvedTool,
  ToolGatewayInvokeRequest,
  ToolGatewayInvokeResponse,
} from "./types";

export type SiteToolCallRequest = ToolGatewayCallRequest & {
  siteArtifactId: string;
  siteVersionId: string;
};
export type SiteToolCaller = (input: {
  workspaceId: string;
  request: ToolGatewayCallRequest &
    Partial<Pick<SiteToolCallRequest, "siteArtifactId" | "siteVersionId">>;
  signal: AbortSignal;
}) => Promise<ToolGatewayCallResponse>;
export type SiteToolBridge = {
  resolve?: (
    request: ToolGatewayResolveRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayResolvedTool>;
  invoke?: (
    request: ToolGatewayInvokeRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayInvokeResponse>;
  fetch?: (request: SiteHttpRequest, signal: AbortSignal) => Promise<Response>;
  catalog: (options: { signal: AbortSignal }) => Promise<OpenGeniSiteToolCatalog>;
  call: (
    request: ToolGatewayCallRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayCallResponse>;
};
export type CreateSiteToolBridgeOptions = {
  workspaceTools: Pick<OpenGeniWorkspaceTools, "$catalog"> &
    Partial<Pick<OpenGeniWorkspaceTools, "$targetProtocol" | "$resolve" | "$invoke" | "$manifest">>;
  workspaceId: string;

  callTool: SiteToolCaller;
  isCatalogStale?: (error: unknown) => boolean;
  /** Optional authenticated host transport for the host-bound workspace API.
   * Omit to expose tools only. Site-provided authorization headers are never forwarded. */
  fetchResponse?: (path: string, init: RequestInit) => Promise<Response>;
} & (
  | { artifactId: string; siteVersionId: string; requestedTools: readonly ToolGatewayIdentity[] }
  | { artifactId?: never; siteVersionId?: never; requestedTools?: never }
);

/** Host-side bridge for the opaque Site frame. Supply an authenticated transport;
 * the server independently checks live viewer access and the exact Site version.
 * Recreate on actor/version change. Never take these pinned fields from HTML. */
export function createSiteToolBridge(input: CreateSiteToolBridgeOptions): SiteToolBridge {
  const allowed = input.requestedTools ? new Set(input.requestedTools.map(identityKey)) : null;
  const targeted =
    input.workspaceTools.$targetProtocol === 1 &&
    input.workspaceTools.$resolve &&
    input.workspaceTools.$invoke &&
    input.workspaceTools.$manifest;
  const context = input.artifactId
    ? { siteArtifactId: input.artifactId, siteVersionId: input.siteVersionId }
    : {};
  const manifests = new Map<string, readonly ToolGatewayResolvedTool[]>();
  const resolve = async (
    request: ToolGatewayResolveRequest,
    { signal }: { signal: AbortSignal },
  ) => {
    if (
      allowed &&
      "identity" in request.target &&
      !allowed.has(identityKey(request.target.identity))
    )
      throw new Error("This tool is not available to the Site");
    const tool = await input.workspaceTools.$resolve!(request.target, { signal, ...context });
    if (allowed && !allowed.has(identityKey(tool.entry.identity)))
      throw new Error("This tool is not available to the Site");
    return tool;
  };
  const invoke = async (request: ToolGatewayInvokeRequest, { signal }: { signal: AbortSignal }) => {
    if (
      allowed &&
      "identity" in request.target &&
      !allowed.has(identityKey(request.target.identity))
    )
      throw new Error("This tool is not available to the Site");
    return await input.workspaceTools.$invoke!(
      {
        target: request.target,
        operationId: request.operationId,
        arguments: request.arguments,
        ...(request.expectedDefinitionDigest
          ? { expectedDefinitionDigest: request.expectedDefinitionDigest }
          : {}),
        ...context,
      },
      { signal },
    );
  };
  // One shared load serves every concurrent Site request (cancelled only when
  // all of them abort); a stale rejection reloads once for all requests
  // rejected on that digest.
  const projectedCatalog = createSharedCatalogLoader<OpenGeniSiteToolCatalog>(
    async (refresh, signal) => {
      if (targeted && input.requestedTools) {
        const manifest = await input.workspaceTools.$manifest!(
          { identities: [...input.requestedTools], ...context },
          { signal },
        );
        signal.throwIfAborted();
        if (manifests.size >= 4) manifests.delete(manifests.keys().next().value!);
        manifests.set(manifest.digest, manifest.tools);
        return {
          version: 1,
          generation: 1,
          digest: manifest.digest,
          createdAt: new Date().toISOString(),
          entries: manifest.tools.map((tool) => tool.entry),
        };
      }
      const current = await input.workspaceTools.$catalog({
        signal,
        ...(refresh ? { refresh } : {}),
      });
      if (current.workspaceId !== input.workspaceId)
        throw new Error("Site catalog workspace mismatch");
      return {
        version: current.version,
        generation: current.generation,
        digest: current.digest,
        createdAt: current.createdAt,
        entries: current.entries.filter(
          (entry) => !allowed || allowed.has(identityKey(entry.identity)),
        ),
      };
    },
  );
  const loadCatalog = async ({
    signal,
    staleDigest,
  }: {
    signal: AbortSignal;
    staleDigest?: string;
  }): Promise<OpenGeniSiteToolCatalog> => {
    signal.throwIfAborted();
    const catalog =
      staleDigest === undefined
        ? await projectedCatalog.load({ signal })
        : await projectedCatalog.reloadAfterStale(staleDigest, signal);
    signal.throwIfAborted();
    return catalog;
  };
  return {
    ...(targeted ? { resolve, invoke } : {}),
    ...(input.fetchResponse
      ? {
          fetch: async (message: SiteHttpRequest, signal: AbortSignal) => {
            const path = siteSessionPath(
              message.path,
              input.workspaceId,
              message.method,
              input.artifactId,
            );
            const headers = siteRequestHeaders(message.headers);
            if (input.artifactId) {
              headers.set("x-opengeni-site-id", input.artifactId);
              headers.set("x-opengeni-site-version", input.siteVersionId);
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
    catalog: async ({ signal }) => await loadCatalog({ signal }),
    call: async (request, { signal }) => {
      if (allowed && !allowed.has(identityKey(request.identity)))
        throw new Error("This tool is not available to the Site");
      if (targeted && input.requestedTools) {
        const tool = manifests
          .get(request.catalogDigest)
          ?.find(
            (candidate) => identityKey(candidate.entry.identity) === identityKey(request.identity),
          );
        if (!tool)
          throw new OpenGeniApiError(
            409,
            JSON.stringify({
              error: { code: "conflict", details: { code: "catalog_stale" }, retryable: true },
            }),
          );
        try {
          const response = await invoke(
            {
              operationId: request.operationId ?? crypto.randomUUID(),
              target: { identity: request.identity },
              arguments: request.arguments,
              expectedDefinitionDigest: tool.definitionDigest,
            },
            { signal },
          );
          return {
            operationId: response.operationId,
            catalogDigest: request.catalogDigest,
            result: response.result,
          };
        } catch (error) {
          if (
            error instanceof OpenGeniApiError &&
            error.details?.code === "tool_definition_stale"
          ) {
            projectedCatalog.invalidate(request.catalogDigest);
            manifests.delete(request.catalogDigest);
            throw new OpenGeniApiError(
              409,
              JSON.stringify({
                error: {
                  code: "catalog_stale",
                  details: { code: "catalog_stale" },
                  retryable: true,
                },
              }),
            );
          }
          throw error;
        }
      }
      let usedDigest: string | undefined;
      const call = async (staleDigest?: string) => {
        const catalog = await loadCatalog({
          signal,
          ...(staleDigest === undefined ? {} : { staleDigest }),
        });
        usedDigest = catalog.digest;
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
            ...(input.artifactId
              ? { siteArtifactId: input.artifactId, siteVersionId: input.siteVersionId }
              : {}),
          },
        });
      };
      try {
        return await call();
      } catch (error) {
        // Only pre-execution catalog rejection permits one retry. Never retry
        // transport failures, expired credentials or uncertain tool effects.
        if (!(input.isCatalogStale ?? isSiteCatalogStaleError)(error) || usedDigest === undefined)
          throw error;
        return await call(usedDigest);
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
