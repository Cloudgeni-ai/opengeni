import { OpenGeniApiError, type ToolGatewayCallResponse } from "@opengeni/sdk";
import {
  createSiteToolBridge as createSharedSiteToolBridge,
  type CreateSiteToolBridgeOptions,
} from "@opengeni/sdk/site";
import type { PublishedHtmlArtifactToolBridge } from "../../artifacts";
import { ApiError, type AppApiHost } from "./app-api";
import type { SiteToolConsentHost } from "./site-tool-consent";

type NativeOptions<T = CreateSiteToolBridgeOptions> = T extends CreateSiteToolBridgeOptions
  ? Omit<
      T,
      "callTool" | "isCatalogStale" | "fetchResponse" | "confirmToolCall" | "connectForToolCall"
    > & {
      callTool?: CreateSiteToolBridgeOptions["callTool"] | undefined;
      /** The Opengeni frame's confirmation; without it, calls needing the viewer fail. */
      consent?: SiteToolConsentHost | null | undefined;
    }
  : never;

/** Native authentication only; Site routing, origin, filtering and version pinning are shared. */
export function createSiteToolBridge(
  api: AppApiHost,
  input: NativeOptions,
): PublishedHtmlArtifactToolBridge {
  const { consent, ...options } = input;
  return createSharedSiteToolBridge({
    ...options,
    ...(consent
      ? {
          confirmToolCall: consent.confirmToolCall,
          connectForToolCall: (prompt) =>
            consent.connectForToolCall({ ...prompt, workspaceId: input.workspaceId }),
        }
      : {}),
    isCatalogStale: isCatalogStaleApiError,
    fetchResponse: (path, init) => api.requestResponse(path, init),
    callTool:
      options.callTool ??
      (async ({ workspaceId, request: body, signal }) =>
        api.request<ToolGatewayCallResponse>(
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
