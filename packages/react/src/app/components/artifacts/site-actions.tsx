import { ArrowUpRightIcon } from "lucide-react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { MouseEvent } from "react";

import { useAppContext } from "../../app-context";
import { copyTitle } from "../../lib/copy-link";
import { hasWorkspacePermission } from "../../lib/permissions";
import type { SessionSiteOrigin } from "../../lib/session-site-origin";
import { useDuplicateSite } from "../../lib/use-duplicate-site";
import { DropdownMenuItem } from "../../../ui/dropdown-menu";
import { useCopyArtifactLink } from "./copy-artifact-link";
import { openPublishedSite, publishedSiteLink, useSitePublicationLink } from "./site-public-link";

/**
 * What a Site's row and its page both offer besides the sidebar's Pin,
 * Archive and Move: copy its title or address, duplicate it (for people who
 * can publish), and its details (versions, sharing, archive). Wired to the
 * same capabilities as the Artifacts page.
 */
export function useSiteActions(workspaceId: string, origin: SessionSiteOrigin) {
  const { accessContext } = useAppContext();
  const copyArtifactLink = useCopyArtifactLink(workspaceId);
  const copies = useDuplicateSite(workspaceId);
  const canDuplicate = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  return {
    copyTitle: () => void copyTitle(origin.title),
    copyLink: () => void copyArtifactLink({ kind: "site", id: origin.siteId }),
    duplicate: canDuplicate
      ? {
          busy: copies.busy,
          run: () => void copies.duplicate({ id: origin.siteId, title: origin.title }),
        }
      : null,
    /** Site details: its Settings tab, which shows Versions to everyone. */
    details: {
      to: "/workspaces/$workspaceId/artifacts/$artifactId",
      params: { workspaceId, artifactId: origin.siteId },
      search: { tab: "settings" },
    } as const,
  };
}

type MenuItem = typeof DropdownMenuItem;

/**
 * "Open published Site", once the menu it sits in has learned the Site is on
 * the web: it reads the address when the menu opens, and shows nothing for a
 * Site that isn't published (or while it doesn't know yet).
 */
export function OpenPublishedSiteItem(props: {
  item: MenuItem;
  workspaceId: string;
  siteId: string;
}) {
  const { client } = useAppContext();
  // An embed's older client may not read publications.
  if (typeof client.getSitePublicationLink !== "function") return null;
  return <PublishedSiteItem {...props} client={client} />;
}

function PublishedSiteItem({
  item: Item,
  workspaceId,
  siteId,
  client,
}: {
  item: MenuItem;
  workspaceId: string;
  siteId: string;
  client: Pick<OpenGeniBrowserClient, "getSitePublicationLink">;
}) {
  const { load } = useSitePublicationLink({ client, workspaceId, siteId });
  const link = publishedSiteLink(load);
  if (!link) return null;
  return (
    <Item asChild>
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        data-site-action="open-published"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          // The desktop app opens it in the default browser.
          if (openPublishedSite(link.url)) event.preventDefault();
        }}
      >
        <ArrowUpRightIcon aria-hidden="true" />
        Open published Site
      </a>
    </Item>
  );
}
