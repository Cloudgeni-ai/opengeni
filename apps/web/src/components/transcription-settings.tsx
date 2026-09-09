import { Loader2Icon, MicIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { type AppContextValue, useAppContext } from "@/context";
import {
  type VoiceInputProviderId,
  type WorkspaceVoiceInputSettings,
  resolveWorkspaceVoiceInputEnabled,
} from "@opengeni/sdk";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";

export const voiceInputProviderLabels: Record<VoiceInputProviderId, string> = {
  "supergrok-subscription": "SuperGrok subscription",
  "codex-subscription": "Codex subscription",
  openai: "OpenAI API · API billing",
  "azure-openai": "Azure OpenAI · Azure billing",
};

/** Dense preference row used by workspace settings (no outer card). */
export function VoiceInputPreferenceRow({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  return (
    <VoiceInputPreferences
      workspaceId={workspaceId}
      canManage={canManage}
      context={useAppContext()}
    />
  );
}

export function VoiceInputPreferences({
  workspaceId,
  canManage,
  context,
}: {
  workspaceId: string;
  canManage: boolean;
  context: Pick<
    AppContextValue,
    | "workspaces"
    | "clientConfig"
    | "captureWorkspaceInvocation"
    | "ownsWorkspaceInvocation"
    | "updateWorkspaceSettings"
  >;
}) {
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const capability = context.clientConfig.voiceInput;
  const [saving, setSaving] = useState(false);
  const enabled = resolveWorkspaceVoiceInputEnabled(workspace?.settings) ?? true;
  const available = capability?.available === true;

  const preferences = workspace?.settings.voiceInput as WorkspaceVoiceInputSettings | undefined;
  const providers = capability?.providers ?? [];
  const selected = preferences?.preferredProvider ?? "";
  const fallbackEnabled = preferences?.fallbackEnabled ?? true;

  async function save(patch: Partial<WorkspaceVoiceInputSettings>, message: string) {
    if (!canManage || saving || !available) return;
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        voiceInput: { ...preferences, enabled, ...patch },
      });
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        toast.success(message);
      }
    } catch {
      if (context.ownsWorkspaceInvocation(workspaceId, acceptedTransition))
        toast.error("Couldn’t update voice input settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
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
        control={
          providers.length > 0 ? (
            <Select
              aria-label="Default transcription provider"
              value={selected}
              disabled={!canManage || saving || !available}
              onChange={(event) =>
                void save(
                  {
                    preferredProvider: (event.currentTarget.value ||
                      null) as VoiceInputProviderId | null,
                  },
                  "Default transcription provider updated",
                )
              }
              className="h-7 w-52 py-0 text-xs"
            >
              <option value="">Automatic · {voiceInputProviderLabels[providers[0]!]}</option>
              {selected && !providers.includes(selected) ? (
                <option value={selected} disabled>
                  {voiceInputProviderLabels[selected]} · unavailable
                </option>
              ) : null}
              {providers.map((provider) => (
                <option key={provider} value={provider}>
                  {voiceInputProviderLabels[provider]}
                </option>
              ))}
            </Select>
          ) : null
        }
        onToggle={() =>
          void save(
            { enabled: !enabled },
            !enabled ? "Voice input enabled" : "Voice input disabled",
          )
        }
      />
      {providers.length > 1 ? (
        <PreferenceToggleRow
          label="Automatic transcription fallback"
          description="Try another configured provider if unavailable or access is rejected. Its billing applies."
          wrapDescription
          checked={fallbackEnabled}
          disabled={!canManage || saving || !enabled}
          onToggle={() =>
            void save({ fallbackEnabled: !fallbackEnabled }, "Transcription fallback updated")
          }
        />
      ) : null}
    </>
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
  control?: ReactNode;
  wrapDescription?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-1 py-1.5">
      {props.icon ? <span className="shrink-0">{props.icon}</span> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{props.label}</div>
        <p
          className={cn(
            "text-2xs text-fg-subtle",
            props.wrapDescription ? "leading-4" : "truncate",
          )}
          title={props.description}
        >
          {props.description}
        </p>
      </div>
      {props.control}
      {props.saving ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-fg-subtle" />
      ) : null}
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
