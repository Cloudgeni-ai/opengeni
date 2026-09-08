import { PanelsTopLeftIcon } from "lucide-react";
import { sessionSiteOrigin } from "@/lib/session-site-origin";
import type { Session } from "@/types";
export function SiteOriginLink({
  session,
  compact = false,
}: {
  session: Session;
  compact?: boolean;
}) {
  const origin = sessionSiteOrigin(session);
  if (!origin) return null;
  return (
    <a
      href={`/workspaces/${session.workspaceId}/artifacts/${origin.siteId}`}
      title={`Created through ${origin.title}`}
      aria-label={`Created through ${origin.title}. Open Site`}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <PanelsTopLeftIcon aria-hidden="true" className="size-3.5" />
      {!compact && <span className="max-w-40 truncate">{origin.title}</span>}
    </a>
  );
}
