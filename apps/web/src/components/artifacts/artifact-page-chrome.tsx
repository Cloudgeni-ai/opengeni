// Pieces every artifact page shares: the type glyph and tile, the detail
// frame and the back link to the library. Kept apart from the library and the
// Site route so a file page does not load either.
import { useNavigate } from "@tanstack/react-router";
import {
  FileIcon,
  FileTextIcon,
  Globe2Icon,
  ImageIcon,
  PresentationIcon,
  Table2Icon,
} from "lucide-react";
import type { MouseEvent } from "react";

import type { DetailBackLink } from "@/components/ui/detail-page";
import { LogoTile } from "@/components/ui/logo-tile";
import { artifactKindLabel, type ArtifactKind } from "@/lib/artifact-catalog";

const icons = {
  site: Globe2Icon,
  image: ImageIcon,
  document: FileTextIcon,
  spreadsheet: Table2Icon,
  presentation: PresentationIcon,
  file: FileIcon,
};

export function ArtifactTypeIcon({ kind, className }: { kind: ArtifactKind; className?: string }) {
  const Icon = icons[kind];
  return <Icon className={className ?? "size-4"} aria-hidden />;
}

/** The artifact's leading tile on its own page: its type glyph on the neutral tile. */
export function ArtifactKindTile({ kind }: { kind: ArtifactKind }) {
  return <LogoTile icon={<ArtifactTypeIcon kind={kind} />} name={artifactKindLabel[kind]} />;
}

/** Detail pages fill the content column; `DetailPage` draws the 960px frame. */
export const ARTIFACT_DETAIL_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

/** "← Artifacts", keeping the way back to the session it was opened from. */
export function useArtifactsBackLink(workspaceId: string, fromSession?: string): DetailBackLink {
  const navigate = useNavigate();
  return {
    label: "Artifacts",
    href: `/workspaces/${encodeURIComponent(workspaceId)}/artifacts${
      fromSession ? `?fromSession=${encodeURIComponent(fromSession)}` : ""
    }`,
    // The link keeps a real href (new tab, copy); a plain click stays in the router.
    onClick: (event?: MouseEvent) => {
      if (event && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)) return;
      event?.preventDefault();
      void navigate({
        to: "/workspaces/$workspaceId/artifacts",
        params: { workspaceId },
        search: fromSession ? { fromSession } : {},
      });
    },
  };
}
