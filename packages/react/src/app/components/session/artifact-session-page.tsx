import { Link } from "../../lib/navigation";
import { ArrowLeftIcon, LinkIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../../ui/button";
import { useArtifactsBackLink } from "../artifacts/artifact-page-chrome";
import { ArtifactBrowseControls } from "../artifacts/artifact-browse-controls";
import { COPY_ARTIFACT_LINK, useCopyArtifactLink } from "../artifacts/copy-artifact-link";
import type { ArtifactKind } from "../../lib/artifact-catalog";

/** Explicit, reload-safe navigation for full-page artifacts (never embedded viewers). */
export function ArtifactSessionPage({
  workspaceId,
  artifactId,
  fromSession,
  showAllArtifacts = false,
  linkKind,
  children,
}: {
  workspaceId: string;
  artifactId?: string | undefined;
  fromSession?: string | undefined;
  /** Opt in when the detail content does not already own its library link. */
  showAllArtifacts?: boolean | undefined;
  /** Shows Copy link here, for pages whose own header has no place for it. */
  linkKind?: ArtifactKind | undefined;
  children: ReactNode;
}) {
  if (!fromSession && !showAllArtifacts && !artifactId) return children;
  return (
    <ArtifactSessionNavigation
      workspaceId={workspaceId}
      artifactId={artifactId}
      fromSession={fromSession}
      showAllArtifacts={showAllArtifacts}
      linkKind={linkKind}
    >
      {children}
    </ArtifactSessionNavigation>
  );
}

function ArtifactSessionNavigation({
  workspaceId,
  artifactId,
  fromSession,
  showAllArtifacts,
  linkKind,
  children,
}: {
  workspaceId: string;
  artifactId?: string | undefined;
  fromSession?: string | undefined;
  showAllArtifacts: boolean;
  linkKind?: ArtifactKind | undefined;
  children: ReactNode;
}) {
  const back = useArtifactsBackLink(workspaceId, fromSession);
  const copyLink = useCopyArtifactLink(workspaceId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b border-border px-4 py-2 empty:hidden max-sm:px-2">
        {showAllArtifacts ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="mr-auto text-fg-muted hover:text-fg pointer-coarse:h-11"
          >
            <a href={back.href} onClick={back.onClick}>
              <ArrowLeftIcon className="size-4" aria-hidden />
              Artifacts
            </a>
          </Button>
        ) : null}
        {artifactId && linkKind ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-fg-muted hover:text-fg pointer-coarse:h-11"
            onClick={() => void copyLink({ kind: linkKind, id: artifactId })}
          >
            <LinkIcon className="size-4" aria-hidden />
            {COPY_ARTIFACT_LINK}
          </Button>
        ) : null}
        {artifactId ? (
          <ArtifactBrowseControls
            workspaceId={workspaceId}
            artifactId={artifactId}
            fromSession={fromSession}
          />
        ) : null}
        {fromSession ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-fg-muted hover:text-fg pointer-coarse:h-11"
          >
            <Link
              to="/workspaces/$workspaceId/sessions/$sessionId"
              params={{ workspaceId, sessionId: fromSession }}
            >
              <XIcon className="size-4" aria-hidden />
              Back to session
            </Link>
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  );
}
