import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, BrainCircuitIcon } from "lucide-react";

import { PageHeader } from "@/components/common";
import { MemoryPane } from "@/components/knowledge/memory-pane";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";

/** First-class workspace memory: presentation only; hierarchy stays an API concern. */
export function MemoryRoute({
  workspaceId,
  focusMemoryId,
  returnToBrain = false,
}: {
  workspaceId: string;
  focusMemoryId?: string | undefined;
  returnToBrain?: boolean;
}) {
  const context = useAppContext();
  const memoryEnabled =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.settings
      ?.memoryEnabled === true;

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BrainCircuitIcon className="size-4" />}
        title="Memory"
        description="Review and curate durable facts, preferences, decisions, and procedures agents carry across sessions."
      />
      {returnToBrain ? (
        <Link
          to="/workspaces/$workspaceId/state"
          params={{ workspaceId }}
          search={{}}
          className="mt-6 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          <ArrowLeftIcon className="size-3" />
          Back to Company Brain
        </Link>
      ) : null}
      <MemoryPane
        workspaceId={workspaceId}
        memoryEnabled={memoryEnabled}
        focusMemoryId={focusMemoryId}
      />
    </ContentPage>
  );
}
