import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Explicit, reload-safe navigation for full-page artifacts (never embedded viewers). */
export function ArtifactSessionPage({
  workspaceId,
  fromSession,
  showAllArtifacts = false,
  children,
}: {
  workspaceId: string;
  fromSession?: string | undefined;
  /** Opt in when the detail content does not already own its library link. */
  showAllArtifacts?: boolean;
  children: ReactNode;
}) {
  if (!fromSession && !showAllArtifacts) return children;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b border-border p-2">
        {showAllArtifacts ? (
          <Button asChild variant="ghost" size="sm" className="mr-auto">
            <Link to="/workspaces/$workspaceId/artifacts" params={{ workspaceId }}>
              <ArrowLeftIcon className="size-4" aria-hidden />
              All artifacts
            </Link>
          </Button>
        ) : null}
        {fromSession ? (
          <Button asChild variant="ghost" size="sm">
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
