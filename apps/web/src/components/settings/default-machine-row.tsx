import { workspaceDefaultMachine } from "@opengeni/react/app/lib/workspace-default-machine";
import { useState } from "react";
import { toast } from "sonner";
import { RowSelect } from "@opengeni/react/app/components/settings/row-select";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { useAppContext } from "@opengeni/react/app/app-context";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { canManageWorkspaceSettings } from "@opengeni/react/app/lib/permissions";
import { useWorkspaceMachines } from "@opengeni/react/app/lib/use-workspace-machines";

export function DefaultMachineRow({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId);
  const fleet = useWorkspaceMachines({ workspaceId });
  const [saving, setSaving] = useState(false);
  // Like the workspace's other settings: its administrators, or the owner of a
  // Personal workspace (who never holds workspace:admin there).
  const canManage = canManageWorkspaceSettings(
    context.accessContext,
    workspace ?? null,
    context.managedSelfContext,
  );
  const target = workspaceDefaultMachine(workspace?.settings);
  const backend = context.clientConfig.defaultSandboxBackend;
  const current =
    target?.kind === "machine"
      ? target.targetSandboxId
      : target?.kind === "managed" || (backend !== "selfhosted" && backend !== "none")
        ? "managed"
        : backend === "none"
          ? "none"
          : null;
  const machines = fleet.machines.filter(
    (item) => item.kind === "selfhosted" && !item.isSessionGroup && item.scope !== "user",
  );
  const unavailable =
    target?.kind === "machine" &&
    !fleet.loading &&
    !machines.some((item) => item.sandboxId === current);
  async function choose(value: string) {
    if (!canManage || saving || (value === current && target !== null)) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    setSaving(true);
    try {
      await context.updateWorkspaceSettings(workspaceId, {
        defaultExecutionTarget:
          value === "none"
            ? null
            : value === "managed"
              ? { kind: "managed" }
              : { kind: "machine", targetSandboxId: value },
      });
    } catch (error) {
      if (context.ownsWorkspaceInvocation(workspaceId, invocation))
        toast.error("Couldn't change the default machine", {
          description: userErrorText(error),
        });
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingRow
      label="Default machine"
      description={
        unavailable
          ? "Machine unavailable. Choose a replacement to start new chats."
          : "Used by new chats and automations following the workspace default."
      }
      controlWidth="select"
      control={
        <RowSelect
          value={current}
          placeholder="Choose a machine"
          loading={fleet.loading}
          disabled={!canManage || saving}
          disabledReason={canManage ? undefined : "Only workspace administrators can change this."}
          onValueChange={(value) => void choose(value)}
          options={[
            ...(backend === "none"
              ? [{ value: "none", label: "No computer" }]
              : [
                  {
                    value: "managed",
                    label:
                      context.clientConfig.defaultSandboxBackend === "none"
                        ? "No computer"
                        : "Managed sandbox",
                    disabled: context.clientConfig.defaultSandboxBackend === "selfhosted",
                    disabledReason: "This server requires a connected machine.",
                  },
                ]),
            ...machines.map((item) => ({
              value: item.sandboxId,
              label: item.name,
              description: item.state === "online" ? undefined : "Offline",
            })),
            ...(unavailable && target?.kind === "machine"
              ? [{ value: target.targetSandboxId, label: "Machine unavailable" }]
              : []),
          ]}
        />
      }
    />
  );
}
