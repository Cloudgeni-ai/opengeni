import { useNavigate } from "@tanstack/react-router";
import { BrainCircuitIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/common";
import { ContentPage } from "@/components/ui/content-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";

export type AgentKnowledgeSection = "knowledge" | "files" | "instructions" | "skills";

/** Shared by the canonical page and historical file/Memory deep links. */
export function AgentKnowledgePage({
  workspaceId,
  section,
  children,
}: {
  workspaceId: string;
  section: AgentKnowledgeSection;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BrainCircuitIcon className="size-4" />}
        title="Agent Knowledge"
        description={
          personal
            ? "Your saved knowledge, files, and guidance for agents."
            : "Saved knowledge, files, and guidance for agents in this workspace."
        }
      />
      <Tabs
        className="mt-6 min-w-0 gap-6"
        value={section}
        onValueChange={(value) => {
          const next = value as AgentKnowledgeSection;
          void navigate({
            to: "/workspaces/$workspaceId/state",
            params: { workspaceId },
            search: next === "knowledge" ? {} : { view: next },
            resetScroll: false,
          });
        }}
      >
        <div className="min-w-0 overflow-x-auto border-b border-border pb-1">
          <TabsList variant="line" aria-label="Agent Knowledge sections">
            <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value={section} className="min-w-0">
          {children}
        </TabsContent>
      </Tabs>
    </ContentPage>
  );
}
