import type { ReactNode } from "react";
import { sessionArtifactFromHref } from "@/lib/session-artifact-navigation";

export function ArtifactLinkBoundary({
  workspaceId,
  onOpen,
  children,
}: {
  workspaceId: string;
  onOpen: (artifact: { id: string; editable: boolean; kind?: "file" }) => boolean;
  children: ReactNode;
}) {
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
          window.location.origin,
          workspaceId,
        );
        if (target && onOpen(target)) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
