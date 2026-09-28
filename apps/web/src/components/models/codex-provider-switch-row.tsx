import { useState } from "react";
import { toast } from "sonner";

import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";

/**
 * Whether NEW Codex chats here are portable (`codexCompactionDefault`).
 * On (`portable`): long chats are compacted into a plain-text summary any
 * provider can read, so the chat can move to another provider's model.
 * Off (`remote_v2`, the default): ChatGPT's own compaction, which keeps long
 * chats more accurate but only admits Codex models for the chat's lifetime.
 * Chats already started keep the setting they started with.
 */
export function useCodexChatsPortable(workspaceId: string): boolean {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  return workspace?.settings?.codexCompactionDefault === "portable";
}

export function CodexProviderSwitchRow({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const context = useAppContext();
  const portable = useCodexChatsPortable(workspaceId);
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
          nextPortable ? "New Codex chats are portable" : "New Codex chats stay on Codex",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingRow
      label="Keep Codex chats portable"
      description="Summarizes long chats in a form another provider's model can continue. Off keeps new chats on Codex, with better memory of long conversations."
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
