import { Link } from "../../lib/navigation";
import { PanelsTopLeftIcon } from "lucide-react";
import { sessionSiteOrigin } from "../../lib/session-site-origin";
import type { RailSession as Session } from "../../lib/session-list-entry";
/** Where a session came from: opens its Site view with this conversation selected. */
export function SiteOriginLink({
  session,
  compact = false,
}: {
  session: Session;
  compact?: boolean | undefined;
}) {
  const origin = sessionSiteOrigin(session);
  if (!origin) return null;
  return (
    <Link
      to="/workspaces/$workspaceId/sites/$siteId"
      params={{ workspaceId: session.workspaceId, siteId: origin.siteId }}
      search={session.parentSessionId === null ? { conversation: session.id } : undefined}
      title={`Created through ${origin.title}`}
      aria-label={`Created through ${origin.title}. Open Site`}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
    >
      <PanelsTopLeftIcon aria-hidden="true" className="size-3.5" />
      {/* Narrow chat headers keep the icon; its name says which Site. */}
      {!compact && (
        <span className="max-w-40 truncate max-sm:hidden @max-[34rem]/titlebar:hidden">
          {origin.title}
        </span>
      )}
    </Link>
  );
}
