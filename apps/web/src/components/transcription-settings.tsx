import { Loader2Icon, MicIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAppContext } from "@/context";
import { resolveWorkspaceVoiceInputEnabled } from "@opengeni/sdk";
import { cn } from "@/lib/utils";

/** Dense preference row used by workspace settings (no outer card). */
export function VoiceInputPreferenceRow({
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
  const available = capability?.available === true;

  async function toggle() {
    if (!canManage || saving || !available) return;
    setSaving(true);
    try {
      await context.updateWorkspaceSettings(workspaceId, { voiceInput: { enabled: !enabled } });
      toast.success(!enabled ? "Voice input enabled" : "Voice input disabled");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PreferenceToggleRow
      icon={<MicIcon className="size-3.5 text-brand" />}
      label="Voice input"
      description={
        available
          ? "Record a short message and add its transcription to the composer draft."
          : "Not configured by this deployment operator."
      }
      checked={enabled}
      disabled={!canManage || saving || !available}
      saving={saving}
      onToggle={() => void toggle()}
    />
  );
}

/** Shared dense toggle row for workspace preference lists. */
export function PreferenceToggleRow(props: {
  icon?: ReactNode;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  saving?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-1 py-1.5">
      {props.icon ? <span className="shrink-0">{props.icon}</span> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{props.label}</div>
        <p className="truncate text-2xs text-fg-subtle" title={props.description}>
          {props.description}
        </p>
      </div>
      {props.saving ? <Loader2Icon className="size-3.5 shrink-0 animate-spin text-fg-subtle" /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={props.onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          props.checked ? "border-brand bg-brand" : "border-border bg-surface-2",
        )}
      >
        <span
          className={cn(
            "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
            props.checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

/** @deprecated Name retained while callers migrate to VoiceInputPreferenceRow. */
export function TranscriptionSettingsSection({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface px-3 py-1">
      <VoiceInputPreferenceRow workspaceId={workspaceId} canManage={canManage} />
    </section>
  );
}
