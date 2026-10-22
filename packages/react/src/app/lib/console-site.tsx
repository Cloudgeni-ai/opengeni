import type { SiteViewer } from "@opengeni/sdk";
import { useCallback, useMemo } from "react";
import type { SiteToolBridgeFactory } from "../../artifacts";
import { useAppContext } from "../app-context";
import { useAppApi } from "./app-api";
import { createSiteToolBridge } from "./site-tool-bridge";

/** The signed-in member as Site code sees them (`site.viewer`) in the console. */
export function useConsoleSiteViewer(): SiteViewer {
  const { accessContext, authSession } = useAppContext();
  const subjectId = accessContext.subjectId;
  const name = authSession?.user?.name ?? null;
  const email = authSession?.user?.email ?? null;
  return useMemo(
    () => ({ kind: "member", id: `user:${subjectId}`, name, email, signedIn: true }),
    [email, name, subjectId],
  );
}

/** Console tool access for a `SiteView`, pinned to the loaded Site version. */
export function useConsoleSiteToolBridge(workspaceId: string): SiteToolBridgeFactory {
  const { client } = useAppContext();
  const api = useAppApi();
  return useCallback<SiteToolBridgeFactory>(
    (site) => {
      const scope = { workspaceTools: client.tools.forWorkspace(workspaceId), workspaceId };
      return site
        ? createSiteToolBridge(api, {
            ...scope,
            artifactId: site.artifactId,
            siteVersionId: site.siteVersionId,
            requestedTools: site.requestedTools,
          })
        : createSiteToolBridge(api, scope);
    },
    [api, client, workspaceId],
  );
}
