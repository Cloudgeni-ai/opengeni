import { useCallback, useState } from "react";
import { SkillDiscovery } from "@opengeni/react/connect";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { SkillsPanel } from "@/routes/skills-panel";
import { useSourcePackages } from "@/components/capabilities/use-source-packages";
import { LoadErrorState } from "@/components/common";

/** Same editor, installed strip, discovery cache and import flow as Capabilities. */
export function KnowledgeSkills({
  workspaceId,
  personalWorkspace,
  query,
}: {
  workspaceId: string;
  personalWorkspace: boolean;
  query: string;
}) {
  const context = useAppContext();
  const { refreshWorkspaceMcpServers } = context;
  const [revision, setRevision] = useState(0);
  const canManage = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "capabilities:manage",
  );
  const onChanged = useCallback(() => {
    setRevision((value) => value + 1);
    void refreshWorkspaceMcpServers(workspaceId);
  }, [refreshWorkspaceMcpServers, workspaceId]);
  const source = useSourcePackages({
    client: context.client,
    workspaceId,
    connections: null,
    canManage,
    onChanged,
  });
  return (
    <>
      <SkillsPanel
        key={workspaceId}
        refreshRevision={revision}
        workspaceId={workspaceId}
        personalWorkspace={personalWorkspace}
        query={query}
        onImportSkill={() => source.importSkill()}
        onFindSkill={() =>
          document.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')?.focus()
        }
      />
      {source.loadError ? (
        <LoadErrorState
          title="Couldn’t load installed skills"
          error={source.loadError}
          onRetry={source.reload}
        />
      ) : null}
      <SkillDiscovery
        client={context.client}
        workspaceId={workspaceId}
        query={query}
        canManage={canManage}
        installedSkills={source.skills}
        onImport={(url) => source.importSkill(url)}
      />
      {source.dialogs}
    </>
  );
}
