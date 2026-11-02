import { LinkIcon } from "lucide-react";
import { useCallback } from "react";

import { Button } from "../../../ui/button";
import { artifactPath, type ArtifactKind } from "../../lib/artifact-catalog";
import { copyLink } from "../../lib/copy-link";
import { usePage } from "../../lib/navigation";
import { cn } from "../../lib/utils";

export const COPY_ARTIFACT_LINK = "Copy link";

/**
 * Copies an artifact's own address, the one its row, page and chat panel all
 * open, with the same "Link copied" a chat's Copy link says.
 */
export function useCopyArtifactLink(workspaceId: string) {
  const page = usePage();
  return useCallback(
    (item: { kind: ArtifactKind; id: string }) =>
      copyLink(`${page.origin()}${artifactPath(workspaceId, item)}`),
    [page, workspaceId],
  );
}

/** The icon button artifact headers show beside their other controls. */
export function CopyArtifactLinkButton({
  workspaceId,
  item,
  className,
}: {
  workspaceId: string;
  item: { kind: ArtifactKind; id: string };
  className?: string | undefined;
}) {
  const copy = useCopyArtifactLink(workspaceId);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn("shrink-0", className)}
      aria-label={COPY_ARTIFACT_LINK}
      title={COPY_ARTIFACT_LINK}
      data-copy-artifact-link=""
      onClick={() => void copy(item)}
    >
      <LinkIcon className="size-4" aria-hidden="true" />
    </Button>
  );
}
