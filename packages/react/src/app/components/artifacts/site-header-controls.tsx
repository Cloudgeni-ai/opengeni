import {
  ArchiveIcon,
  CopyIcon,
  LinkIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PinIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useArtifactLabels } from "../../../components/artifacts/artifact-chrome";
import { Button } from "../../../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { Link } from "../../lib/navigation";
import { useSiteSidebarActions } from "../../lib/site-sidebar-bridge";
import { useSiteActions } from "./site-actions";

/** Right-click the Site's title: copy it or the Site's address. */
export function SiteTitleMenu({
  workspaceId,
  origin,
  children,
}: {
  workspaceId: string;
  origin: { siteId: string; title: string };
  children: ReactNode;
}) {
  const site = useSiteActions(workspaceId, origin);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40" data-site-title-menu="">
        <ContextMenuItem onSelect={site.copyTitle}>
          <CopyIcon className="size-4" />
          Copy title
        </ContextMenuItem>
        <ContextMenuItem onSelect={site.copyLink}>
          <LinkIcon className="size-4" />
          Copy app link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function SiteActionsMenu({
  workspaceId,
  origin,
  hasVersion,
  onReload,
  onFullScreen,
}: {
  workspaceId: string;
  origin: { siteId: string; title: string };
  hasVersion: boolean;
  onReload: () => void;
  /** Absent while the app is already full screen. */
  onFullScreen?: (() => void) | undefined;
}) {
  const site = useSiteActions(workspaceId, origin, { hasVersion });
  const sidebar = useSiteSidebarActions(workspaceId, origin);
  const labels = useArtifactLabels();
  return (
    <span data-site-actions-root="" className="contents">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More app actions"
            title="More"
            data-site-actions-menu=""
            className="size-8 rounded-md text-fg-muted hover:text-fg pointer-coarse:size-11"
          >
            <MoreHorizontalIcon aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {onFullScreen ? (
            <DropdownMenuItem onSelect={onFullScreen}>
              <Maximize2Icon aria-hidden="true" />
              {labels.openFullScreen}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onReload}>
            <RefreshCwIcon aria-hidden="true" />
            {labels.reloadSite}
          </DropdownMenuItem>
          {sidebar ? (
            <DropdownMenuItem onSelect={sidebar.togglePin}>
              <PinIcon aria-hidden="true" className={sidebar.pinned ? "fill-current" : undefined} />
              {sidebar.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem asChild>
            <Link {...site.details} state={{ artifactDetailFromSite: origin.siteId }}>
              <Settings2Icon aria-hidden="true" />
              Settings
            </Link>
          </DropdownMenuItem>
          {sidebar ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={sidebar.archive}>
                <ArchiveIcon aria-hidden="true" />
                Archive
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
