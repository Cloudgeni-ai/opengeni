import { useState } from "react";
import { toast } from "sonner";

import { RowSelect } from "@/components/settings/row-select";
import { SettingRow } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import { hasWorkspacePermission } from "@/lib/permissions";
import { useWorkspaceRigs } from "@/lib/use-workspace-rigs";

const NONE = "none";

/**
 * The Sandbox Environment new sessions start on unless someone picks another
 * under "+" > Runs on. It is the workspace default rig (`rigs:manage`); the
 * row is hidden while the workspace has no environments to choose from.
 */
export function DefaultSandboxEnvironmentRow({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "rigs:manage");
  const rigs = useWorkspaceRigs({ workspaceId });
  const [saving, setSaving] = useState(false);
  // A personal ("Only me") environment is never a workspace default.
  const choices = rigs.rigs.filter((rig) => rig.scope !== "user");
  const current = workspace?.defaultRigId ?? null;
  if (!rigs.loading && choices.length === 0 && current === null) return null;

  async function change(value: string) {
    const rigId = value === NONE ? null : value;
    if (!canManage || saving || rigId === current) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    setSaving(true);
    try {
      const updated = await context.setWorkspaceDefaultRig(workspaceId, rigId);
      if (updated && context.ownsWorkspaceInvocation(workspaceId, invocation)) {
        const name = choices.find((rig) => rig.id === rigId)?.name;
        toast.success(
          name
            ? `New sessions now use ${name}`
            : "New sessions no longer use a default environment",
        );
      }
    } catch (error) {
      if (context.ownsWorkspaceInvocation(workspaceId, invocation)) {
        toast.error("Couldn't change the default environment", {
          description: userErrorText(error),
        });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingRow
      label="Sandbox environment"
      description="New sessions use it unless someone picks another under + > Runs on."
      controlWidth="select"
      control={
        <RowSelect
          options={[
            { value: NONE, label: "None" },
            ...choices.map((rig) => ({ value: rig.id, label: rig.name })),
            // A default that was deleted or made personal still shows as the value.
            ...(current && !rigs.loading && !choices.some((rig) => rig.id === current)
              ? [{ value: current, label: "Unavailable environment" }]
              : []),
          ]}
          value={current ?? NONE}
          loading={rigs.loading}
          disabled={!canManage || saving}
          disabledReason={
            canManage ? undefined : "Only people who manage sandbox environments can change this."
          }
          onValueChange={(value) => void change(value)}
        />
      }
    />
  );
}
