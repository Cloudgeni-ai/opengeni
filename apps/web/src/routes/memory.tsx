import { BrainCircuitIcon } from "lucide-react";

import { PageHeader } from "@/components/common";
import { MemoryPane } from "@/components/knowledge/memory-pane";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";

/** First-class workspace memory: presentation only; hierarchy stays an API concern. */
export function MemoryRoute({
  workspaceId,
  focusMemoryId,
}: {
  workspaceId: string;
  focusMemoryId?: string | undefined;
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
      <MemoryPane
        workspaceId={workspaceId}
        memoryEnabled={memoryEnabled}
        focusMemoryId={focusMemoryId}
      />
    </ContentPage>
  );
}
