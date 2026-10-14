import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useArtifactsBackLink } from "@/components/artifacts/artifact-page-chrome";
import { ArtifactBrowseControls } from "@/components/artifacts/artifact-browse-controls";

/** Explicit, reload-safe navigation for full-page artifacts (never embedded viewers). */
export function ArtifactSessionPage({
  workspaceId,
  artifactId,
  fromSession,
  showAllArtifacts = false,
  children,
}: {
  workspaceId: string;
  artifactId?: string;
  fromSession?: string | undefined;
  /** Opt in when the detail content does not already own its library link. */
  showAllArtifacts?: boolean;
  children: ReactNode;
}) {
  if (!fromSession && !showAllArtifacts && !artifactId) return children;
  return (
    <ArtifactSessionNavigation
      workspaceId={workspaceId}
      artifactId={artifactId}
      fromSession={fromSession}
      showAllArtifacts={showAllArtifacts}
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
  children,
}: {
  workspaceId: string;
  artifactId?: string;
  fromSession?: string;
  showAllArtifacts: boolean;
  children: ReactNode;
}) {
  const back = useArtifactsBackLink(workspaceId, fromSession);
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
