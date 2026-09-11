import { AgentKnowledgePage } from "@/components/knowledge/agent-knowledge-page";
import { KnowledgeBrowser } from "@/components/knowledge/knowledge-browser";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";

type KnowledgePanelProps = {
  workspaceId: string;
  focusMemoryId?: string | undefined;
  fileId?: string;
  returnToBrain?: boolean;
};

/** The historical Memory URL remains a link-compatible entry into Knowledge. */
export function MemoryRoute(props: KnowledgePanelProps) {
  return (
    <AgentKnowledgePage workspaceId={props.workspaceId} section="knowledge">
      <KnowledgePanel {...props} />
    </AgentKnowledgePage>
  );
}

export function KnowledgePanel({ workspaceId, focusMemoryId, fileId }: KnowledgePanelProps) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  return (
    <KnowledgeBrowser
      key={`${workspaceId}:${fileId ?? "all"}`}
      workspaceId={workspaceId}
      personal={personal}
      {...(fileId ? { fileId } : {})}
      {...(focusMemoryId ? { focusEntryId: focusMemoryId } : {})}
    />
  );
}
