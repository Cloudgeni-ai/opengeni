import { OpenGeniApiError, type ToolGatewayCallResponse } from "@opengeni/sdk";
import {
  createSiteToolBridge as createSharedSiteToolBridge,
  type CreateSiteToolBridgeOptions,
} from "@opengeni/sdk/site";
import type { PublishedHtmlArtifactToolBridge } from "@opengeni/react/artifacts";
import { ApiError, request, requestResponse } from "@/api";

/** Native authentication only; Site routing, filtering and version pinning are shared. */
export function createSiteToolBridge(
  input: Omit<CreateSiteToolBridgeOptions, "callTool" | "isCatalogStale" | "fetchResponse"> & {
    callTool?: CreateSiteToolBridgeOptions["callTool"];
  },
): PublishedHtmlArtifactToolBridge {
  return createSharedSiteToolBridge({
    ...input,
    isCatalogStale: isCatalogStaleApiError,
    fetchResponse: (path, init) => requestResponse(path, init),
    callTool:
      input.callTool ??
      (async ({ workspaceId, request: body, signal }) =>
        request<ToolGatewayCallResponse>(
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/tools/calls`,
          {
            method: "POST",
            signal,
            body: JSON.stringify(body),
          },
        )),
  });
}

export function isCatalogStaleApiError(error: unknown): boolean {
  return (
    (error instanceof OpenGeniApiError || error instanceof ApiError) &&
    error.status === 409 &&
    (error.details?.code === "catalog_stale" ||
      (error instanceof ApiError && error.code === "catalog_stale"))
  );
}
