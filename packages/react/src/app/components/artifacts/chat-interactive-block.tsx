import { ChatInteractiveBlock as SharedChatInteractiveBlock } from "../../../artifacts";
import type { SiteToolBridgeFactory } from "../../../artifacts";
import { useCallback } from "react";

import { useAppContext } from "../../app-context";
import { useAppearance } from "../../lib/appearance";
import { useAppApi } from "../../lib/app-api";
import { createSiteToolBridge } from "../../lib/site-tool-bridge";
import { useSiteToolConsentHost } from "../../lib/site-tool-consent";

export type ChatInteractiveBlockProps = {
  workspaceId: string;
  kind: "html" | "site";
  content: string;
};

/** Console data access for the shared inline Site/HTML preview. */
export function ChatInteractiveBlock(props: ChatInteractiveBlockProps) {
  const { resolvedTheme } = useAppearance();
  const { client } = useAppContext();
  const api = useAppApi();
  const consent = useSiteToolConsentHost();
  const { workspaceId } = props;
  const toolBridge = useCallback<SiteToolBridgeFactory>(
    (site) => {
      const scope = { workspaceTools: client.tools.forWorkspace(workspaceId), workspaceId };
      return site
        ? createSiteToolBridge(api, {
            ...scope,
            artifactId: site.artifactId,
            siteVersionId: site.siteVersionId,
            requestedTools: site.requestedTools,
            consent,
          })
        : createSiteToolBridge(api, scope);
    },
    [api, client, consent, workspaceId],
  );
  return (
    <SharedChatInteractiveBlock
      {...props}
      client={client}
      toolBridge={toolBridge}
      theme={resolvedTheme}
    />
  );
}
