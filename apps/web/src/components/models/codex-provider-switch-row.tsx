import { useState } from "react";
import { toast } from "sonner";

import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";

/**
 * "Allow switching to other providers": the default for NEW Codex chats. Off
 * (`remote_v2`) keeps ChatGPT's compaction, so long chats stay accurate but
 * can only use Codex models. On (`portable`) lets a chat switch to other
 * providers. Chats already started keep the setting they started with.
 */
export function CodexProviderSwitchRow({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const portable = workspace?.settings?.codexCompactionDefault === "portable";
  const [saving, setSaving] = useState(false);

  async function toggle(nextPortable: boolean) {
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        codexCompactionDefault: nextPortable ? "portable" : "remote_v2",
      });
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        toast.success(
          nextPortable
            ? "New Codex chats can switch to other providers"
            : "New Codex chats stay on Codex",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingRow
      label="Allow switching to other providers"
      description="Lets a Codex chat move to a model from another provider. Off keeps long chats more accurate."
      control={
        <Switch
          checked={portable}
          pending={saving}
          disabled={!canManage || saving}
          disabledReason={canManage ? undefined : "Only workspace admins can change this."}
          onCheckedChange={(next) => void toggle(next)}
        />
      }
    />
  );
}
