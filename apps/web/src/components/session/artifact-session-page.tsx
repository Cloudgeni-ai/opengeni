import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** A full-page artifact opened from chat retains an explicit, reload-safe way home. */
export function ArtifactSessionPage({
  workspaceId,
  fromSession,
  children,
}: {
  workspaceId: string;
  fromSession?: string | undefined;
  children: ReactNode;
}) {
  if (!fromSession) return children;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-end border-b border-border p-2">
        <Button asChild variant="ghost" size="sm">
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId, sessionId: fromSession }}
          >
            <XIcon className="size-4" aria-hidden />
            Back to session
          </Link>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  );
}
