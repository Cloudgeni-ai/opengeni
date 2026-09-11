import { BrainCircuitIcon } from "lucide-react";
import { PageHeader } from "@/components/common";
import { KnowledgeBrowser } from "@/components/knowledge/knowledge-browser";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";

/** The historical Memory URL remains a link-compatible entry into Knowledge. */
export function MemoryRoute({
  workspaceId,
  focusMemoryId,
  fileId,
}: {
  workspaceId: string;
  focusMemoryId?: string | undefined;
  fileId?: string;
  returnToBrain?: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BrainCircuitIcon className="size-4" />}
        title={personal ? "Your Knowledge" : "Agent Knowledge"}
        description="Sources and useful findings, connected across files, conversations and agent work."
      />
      <div className="mt-6">
        <KnowledgeBrowser
          key={workspaceId}
          workspaceId={workspaceId}
          personal={personal}
          {...(fileId ? { fileId } : {})}
          {...(focusMemoryId ? { focusEntryId: focusMemoryId } : {})}
        />
      </div>
    </ContentPage>
  );
}
