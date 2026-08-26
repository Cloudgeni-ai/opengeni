import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, BrainCircuitIcon } from "lucide-react";

import { PageHeader } from "@/components/common";
import { MemoryPane } from "@/components/knowledge/memory-pane";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";

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
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const memoryEnabled = workspace?.settings?.memoryEnabled === true;
  const personalWorkspace = isPersonalWorkspace(workspace, context.managedSelfContext);

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BrainCircuitIcon className="size-4" />}
        title={personalWorkspace ? "Your Memory" : "Memory"}
        description={
          personalWorkspace
            ? "Review the private facts, incidents, decisions, and procedures agents remember inside your personal workspace."
            : "Review and curate durable facts, preferences, decisions, and procedures agents carry across sessions."
        }
      />
      {returnToBrain ? (
        <Link
          to="/workspaces/$workspaceId/state"
          params={{ workspaceId }}
          search={{}}
          className="mt-6 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          <ArrowLeftIcon className="size-3" />
          Back to Agent Knowledge
        </Link>
      ) : null}
      <MemoryPane
        workspaceId={workspaceId}
        memoryEnabled={memoryEnabled}
        personalWorkspace={personalWorkspace}
        focusMemoryId={focusMemoryId}
      />
    </ContentPage>
  );
}
