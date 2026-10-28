import { useState } from "react";
import { toast } from "sonner";

import { SettingRow } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import { useAppContext } from "@opengeni/react/app/app-context";

/** The setting in plain words: what people get, not the mechanism. */
export const CODEX_MODEL_SWITCH_LABEL = "Let Codex chats switch to other models";
export const CODEX_MODEL_SWITCH_DESCRIPTION =
  "Long chats keep a summary any model can read instead of ChatGPT's own memory. Applies to new chats.";
export function codexModelSwitchToast(enabled: boolean): string {
  return enabled ? "New Codex chats can switch models" : "New Codex chats stay on Codex";
}

/**
 * Whether NEW Codex chats here can switch to other models
 * (`codexCompactionDefault`).
 * On (`portable`): long chats are compacted into a plain-text summary any
 * provider can read, so the chat can move to another provider's model.
 * Off (`remote_v2`, the default): ChatGPT's own compaction, which keeps long
 * chats more accurate but only admits Codex models for the chat's lifetime;
 * another model then continues the chat in a new chat.
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
        toast.success(codexModelSwitchToast(nextPortable));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingRow
      label={CODEX_MODEL_SWITCH_LABEL}
      description={CODEX_MODEL_SWITCH_DESCRIPTION}
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
