import { Loader2Icon, MicIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@/context";
import { resolveWorkspaceVoiceInputEnabled } from "@opengeni/sdk";
import { cn } from "@/lib/utils";

/** @deprecated Name retained while callers migrate to VoiceInputSettingsSection. */
export function TranscriptionSettingsSection({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const capability = context.clientConfig.voiceInput;
  const [saving, setSaving] = useState(false);
  const enabled = resolveWorkspaceVoiceInputEnabled(workspace?.settings) ?? true;

  async function toggle() {
    if (!canManage || saving || !capability?.available) return;
    setSaving(true);
    try {
      await context.updateWorkspaceSettings(workspaceId, { voiceInput: { enabled: !enabled } });
      toast.success(!enabled ? "Voice input enabled" : "Voice input disabled");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <MicIcon className="size-3.5 text-brand" />
            Voice input
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            {capability?.available
              ? "Record a short message and add its transcription to the composer draft."
              : "Not configured by this deployment operator."}
          </p>
        </div>
        {capability?.available ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Voice input"
            disabled={!canManage || saving}
            onClick={() => void toggle()}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              enabled ? "border-brand bg-brand" : "border-border bg-surface-2",
            )}
          >
            {saving ? <Loader2Icon className="mx-auto size-3 animate-spin text-white" /> : null}
            <span
              className={cn(
                "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
                enabled ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        ) : null}
      </div>
      {capability?.available && !canManage ? (
        <p className="text-xs text-fg-subtle">Only workspace admins can change this.</p>
      ) : null}
    </section>
  );
}
