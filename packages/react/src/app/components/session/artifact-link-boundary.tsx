import type { ReactNode } from "react";
import { sessionArtifactFromHref } from "../../lib/session-artifact-navigation";
import { usePage } from "../../lib/navigation";

export function ArtifactLinkBoundary({
  workspaceId,
  onOpen,
  children,
}: {
  workspaceId: string;
  onOpen: (artifact: { id: string; editable: boolean; kind?: "file" | undefined }) => boolean;
  children: ReactNode;
}) {
  const page = usePage();
  return (
    <div
      className="contents"
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!link || link.hasAttribute("download")) return;
        const target = sessionArtifactFromHref(
          link.getAttribute("href") ?? "",
          page.origin(),
          workspaceId,
        );
        if (target && onOpen(target)) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
