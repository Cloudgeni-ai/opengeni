import { useNavigate } from "@tanstack/react-router";
import { BrainCircuitIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/common";
import { ContentPage } from "@/components/ui/content-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  return (
    <ContentPage width="standard">
      <PageHeader
        className="border-0 pb-0"
        icon={<BrainCircuitIcon className="size-4" />}
        title="Agent Knowledge"
      />
      <Tabs
        className="mt-7 min-w-0 gap-7"
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
          <TabsList variant="line" aria-label="Agent Knowledge sections" className="gap-5 p-0">
            <TabsTrigger value="knowledge" className="rounded-none border-0 px-1 py-2 shadow-none">
              Knowledge
            </TabsTrigger>
            <TabsTrigger value="files" className="rounded-none border-0 px-1 py-2 shadow-none">
              Files
            </TabsTrigger>
            <TabsTrigger
              value="instructions"
              className="rounded-none border-0 px-1 py-2 shadow-none"
            >
              Instructions
            </TabsTrigger>
            <TabsTrigger value="skills" className="rounded-none border-0 px-1 py-2 shadow-none">
              Skills
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value={section} className="min-w-0">
          {children}
        </TabsContent>
      </Tabs>
    </ContentPage>
  );
}
