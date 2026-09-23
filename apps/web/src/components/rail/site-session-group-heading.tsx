import { ChevronDownIcon, ChevronRightIcon, PanelsTopLeftIcon } from "lucide-react";
import { RailTrailingMetadata } from "./session-row-content";
import type { RailAggregateStatus } from "@/lib/sessions-group";
import type { SessionSiteOrigin } from "@/lib/session-site-origin";

export function SiteSessionGroupHeading({
  origin,
  workspaceId,
  expanded,
  onToggle,
  summary,
}: {
  origin: SessionSiteOrigin;
  workspaceId: string;
  expanded: boolean;
  onToggle: () => void;
  summary: RailAggregateStatus;
}) {
  return (
    <div className="flex min-h-8 items-center gap-1 rounded-md px-1 hover:bg-surface-2">
      <button
        type="button"
        aria-label={`${expanded ? "Collapse" : "Expand"} conversations from ${origin.title}`}
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex size-7 shrink-0 items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-accent"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
      </button>
      <a
        className="flex min-w-0 flex-1 items-center gap-1.5 text-sm focus-visible:ring-2 focus-visible:ring-accent"
        href={`/workspaces/${workspaceId}/artifacts/${origin.siteId}`}
      >
        <PanelsTopLeftIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{origin.title}</span>
      </a>
      <RailTrailingMetadata summary={summary} />
    </div>
  );
}
