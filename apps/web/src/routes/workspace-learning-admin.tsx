import { useEffect, useState } from "react";
import type { AgentLearningOverrideRecord, AgentLearningContext } from "@opengeni/sdk";
import { AgentLearningSettingsEditor } from "@/components/knowledge/agent-learning-settings";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  const [overrides, setOverrides] = useState<AgentLearningOverrideRecord[]>([]);
  const [editing, setEditing] = useState<AgentLearningOverrideRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setOverrides([]);
    setEditing(null);
    setError(null);
    void context.client
      .listAgentLearningOverrides(workspaceId, scope)
      .then((rows) => {
        if (current) setOverrides(rows);
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      current = false;
    };
  }, [context.client, workspaceId, scope, revision]);
  const editingSource = editing
    ? ({
        kind: editing.contextKey.startsWith("chat:") ? "chat" : "scheduled_task",
        id: editing.contextKey.slice(editing.contextKey.indexOf(":") + 1),
      } as AgentLearningContext)
    : null;
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
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Chat and task overrides</h3>
        {error ? (
          <p role="alert" className="text-xs text-status-error">
            {error}
          </p>
        ) : !overrides.length ? (
          <p className="text-xs text-fg-muted">
            No overrides in this workspace. Set them from Chat settings or a scheduled task.
          </p>
        ) : null}
        {overrides.map((item) => (
          <div
            key={item.contextKey}
            className="flex items-center justify-between gap-3 border-t border-border py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{item.label}</p>
              <p className="text-xs text-fg-muted">
                {item.contextKey.startsWith("chat:") ? "Chat" : "Scheduled task"}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(item)}>
              Edit
            </Button>
          </div>
        ))}
      </div>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setRevision((n) => n + 1);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.label}</DialogTitle>
            <DialogDescription>
              Agent learning overrides. Choose Use default to remove an override.
            </DialogDescription>
          </DialogHeader>
          {editingSource ? (
            <AgentLearningSettingsEditor
              key={`${scope}:${editing?.contextKey}`}
              workspaceId={workspaceId}
              scope={scope}
              source={editingSource}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
