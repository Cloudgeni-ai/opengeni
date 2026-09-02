import {
  OpenGeniApiError,
  type OpenGeniWorkspaceTools,
  type ToolGatewayCallRequest,
  type ToolGatewayCallResponse,
  type ToolGatewayCatalog,
  type ToolGatewayIdentity,
} from "@opengeni/sdk";
import type { PublishedHtmlArtifactToolBridge } from "@opengeni/react/artifacts";

import { request } from "@/api";

type SiteToolCallRequest = ToolGatewayCallRequest & {
  siteArtifactId: string;
  siteVersionId: string;
};

type SiteToolCaller = (input: {
  workspaceId: string;
  request: SiteToolCallRequest;
  signal: AbortSignal;
}) => Promise<ToolGatewayCallResponse>;

export function createSiteToolBridge(input: {
  workspaceTools: OpenGeniWorkspaceTools;
  workspaceId: string;
  artifactId: string;
  siteVersionId: string;
  requestedTools: readonly ToolGatewayIdentity[];
  callTool?: SiteToolCaller;
}): PublishedHtmlArtifactToolBridge {
  const allowed = new Set(input.requestedTools.map(toolIdentityKey));
  const approvedCatalogDigests = new Map<string, string>();
  const callTool = input.callTool ?? callWorkspaceTool;
  let projectedCatalog: ToolGatewayCatalog | null = null;

  const loadCatalog = async ({
    signal,
    refresh = false,
  }: {
    signal: AbortSignal;
    refresh?: boolean;
  }): Promise<ToolGatewayCatalog> => {
    if (projectedCatalog && !refresh) return projectedCatalog;
    const current = await input.workspaceTools.$catalog({
      signal,
      ...(refresh ? { refresh } : {}),
    });
    projectedCatalog = {
      ...current,
      entries: current.entries.filter((entry) => allowed.has(toolIdentityKey(entry.identity))),
    };
    return projectedCatalog;
  };

  const requireEnabledIdentity = (
    catalog: ToolGatewayCatalog,
    identity: ToolGatewayIdentity,
  ): void => {
    if (
      !catalog.entries.some(
        (entry) => toolIdentityKey(entry.identity) === toolIdentityKey(identity),
      )
    ) {
      throw new Error("This requested tool is not enabled in the workspace");
    }
  };

  return {
    catalog: async ({ signal }) => await loadCatalog({ signal }),
    approve: async (toolRequest, { signal }) => {
      requireAllowedIdentity(allowed, toolRequest.identity);

      const approveAgainstCurrentCatalog = async (): Promise<{
        catalog: ToolGatewayCatalog;
        response: Awaited<ReturnType<OpenGeniWorkspaceTools["$approve"]>>;
      }> => {
        const catalog = await loadCatalog({ signal, refresh: true });
        requireEnabledIdentity(catalog, toolRequest.identity);
        const response = await input.workspaceTools.$approve(
          toolRequest.identity,
          toolRequest.arguments,
          {
            operationId: toolRequest.operationId,
            site: { artifactId: input.artifactId, versionId: input.siteVersionId },
            signal,
          },
        );
        return { catalog, response };
      };

      let approved: Awaited<ReturnType<typeof approveAgainstCurrentCatalog>>;
      try {
        approved = await approveAgainstCurrentCatalog();
      } catch (error) {
        if (!isCatalogStaleApiError(error)) throw error;
        projectedCatalog = null;
        approved = await approveAgainstCurrentCatalog();
      }
      approvedCatalogDigests.clear();
      approvedCatalogDigests.set(toolRequest.operationId, approved.catalog.digest);
      return approved.response;
    },
    call: async (toolRequest, { signal }) => {
      requireAllowedIdentity(allowed, toolRequest.identity);
      const approvedCatalogDigest = approvedCatalogDigests.get(toolRequest.operationId ?? "");
      const current = approvedCatalogDigest ? null : await loadCatalog({ signal });
      if (current) requireEnabledIdentity(current, toolRequest.identity);
      const catalogDigest = approvedCatalogDigest ?? current?.digest;
      if (!catalogDigest) throw new Error("Site tool approval is no longer available");

      try {
        return await callTool({
          workspaceId: input.workspaceId,
          signal,
          request: {
            ...toolRequest,
            catalogDigest,
            siteArtifactId: input.artifactId,
            siteVersionId: input.siteVersionId,
          },
        });
      } catch (error) {
        if (isCatalogStaleApiError(error)) {
          projectedCatalog = null;
          try {
            await loadCatalog({ signal, refresh: true });
          } catch {
            projectedCatalog = null;
          }
        }
        throw error;
      } finally {
        if (toolRequest.operationId) approvedCatalogDigests.delete(toolRequest.operationId);
      }
    },
  };
}

export function isCatalogStaleApiError(error: unknown): boolean {
  if (!(error instanceof OpenGeniApiError) || error.status !== 409) return false;
  if (error.details?.code === "catalog_stale") return true;
  return error.body.includes("catalog_stale") || error.message.includes("catalog_stale");
}

function requireAllowedIdentity(allowed: ReadonlySet<string>, identity: ToolGatewayIdentity): void {
  if (!allowed.has(toolIdentityKey(identity))) {
    throw new Error("This tool is not available to the Site");
  }
}

function toolIdentityKey(identity: ToolGatewayIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

async function callWorkspaceTool(input: {
  workspaceId: string;
  request: SiteToolCallRequest;
  signal: AbortSignal;
}): Promise<ToolGatewayCallResponse> {
  return await request<ToolGatewayCallResponse>(`/v1/workspaces/${input.workspaceId}/tools/calls`, {
    method: "POST",
    signal: input.signal,
    body: JSON.stringify(input.request),
  });
}
