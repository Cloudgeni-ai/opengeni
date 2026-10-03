import { ChatInteractiveBlock as SharedChatInteractiveBlock } from "@opengeni/react/artifacts";
import type { SiteToolBridgeFactory } from "@opengeni/react/artifacts";
import { useCallback } from "react";

import { useAppContext } from "@/context";
import { useAppearance } from "@/lib/appearance";
import { createSiteToolBridge } from "@/lib/site-tool-bridge";

export type ChatInteractiveBlockProps = {
  workspaceId: string;
  kind: "html" | "site";
  content: string;
};

/** Console data access for the shared inline Site/HTML preview. */
export function ChatInteractiveBlock(props: ChatInteractiveBlockProps) {
  const { resolvedTheme } = useAppearance();
  const { client } = useAppContext();
  const { workspaceId } = props;
  const toolBridge = useCallback<SiteToolBridgeFactory>(
    (site) => {
      const scope = { workspaceTools: client.tools.forWorkspace(workspaceId), workspaceId };
      return site
        ? createSiteToolBridge({
            ...scope,
            artifactId: site.artifactId,
            siteVersionId: site.siteVersionId,
            requestedTools: site.requestedTools,
          })
        : createSiteToolBridge(scope);
    },
    [client, workspaceId],
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
