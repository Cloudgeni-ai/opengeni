import { useState } from "react";
import { AgentLearningSettingsEditor } from "@/components/knowledge/agent-learning-settings";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { canManageWorkspaceSettings } from "@/lib/permissions";
import { isPersonalWorkspace } from "@/lib/managed-self-context";

export function WorkspaceLearningAdministration({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  const [selectedScope, setSelectedScope] = useState<"workspace" | "personal">("workspace");
  const scope = personal ? "personal" : selectedScope;
  const canEdit =
    scope === "personal" ||
    canManageWorkspaceSettings(context.accessContext, workspace, context.managedSelfContext);
  return (
    <section aria-labelledby="agent-learning-heading" className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="agent-learning-heading" className="sr-only">
          Agent learning
        </h2>
        {!personal ? (
          <Select
            aria-label="Agent learning defaults for"
            value={scope}
            onChange={(event) => setSelectedScope(event.target.value as "workspace" | "personal")}
          >
            <option value="workspace">Workspace defaults</option>
            <option value="personal">My defaults</option>
          </Select>
        ) : null}
      </div>
      <p className="text-xs text-fg-muted">
        Choose how agents retain knowledge and improve their instructions and skills. Chats and
        scheduled tasks can override these defaults.
      </p>
      <AgentLearningSettingsEditor
        key={`${workspaceId}:${scope}`}
        workspaceId={workspaceId}
        scope={scope}
        canEdit={canEdit}
      />
    </section>
  );
}
