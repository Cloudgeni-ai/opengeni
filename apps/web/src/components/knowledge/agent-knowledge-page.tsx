import { useNavigate } from "@tanstack/react-router";
import { BrainCircuitIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { CatalogActionContext } from "@/components/capabilities/catalog-header";
import { PageHeader } from "@/components/common";
import { ContentPage } from "@/components/ui/content-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type AgentKnowledgeSection = "knowledge" | "files" | "instructions" | "skills";

/** Shared by the canonical page and historical file/Memory deep links. */
export function AgentKnowledgePage({
  workspaceId,
  section,
  children,
  search,
}: {
  workspaceId: string;
  section: AgentKnowledgeSection;
  children: ReactNode;
  search?: ReactNode;
}) {
  const navigate = useNavigate();
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const toolbar = useMemo(
    () => ({ target, activeTitle: section === "skills" ? "Skills" : "" }),
    [target, section],
  );
  return (
    <ContentPage width="standard">
      <PageHeader
        className="border-0 pb-0"
        icon={<BrainCircuitIcon className="size-4" />}
        title="Agent Knowledge"
      />
      {search}
      <CatalogActionContext.Provider value={toolbar}>
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
          <div className="capabilities-tab-bar">
            <TabsList variant="line" aria-label="Agent Knowledge sections" className="gap-5 p-0">
              <TabsTrigger
                value="knowledge"
                className="rounded-none border-0 px-1 py-2 shadow-none"
              >
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
            <div ref={setTarget} className="capabilities-tab-action" />
          </div>
          <TabsContent value={section} className="min-w-0">
            {children}
          </TabsContent>
        </Tabs>
      </CatalogActionContext.Provider>
    </ContentPage>
  );
}
