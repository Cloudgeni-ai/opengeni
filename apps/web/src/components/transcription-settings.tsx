import { Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { type AppContextValue, useAppContext } from "@/context";
import {
  type VoiceInputProviderId,
  type WorkspaceVoiceInputSettings,
  resolveWorkspaceVoiceInputEnabled,
} from "@opengeni/sdk";
import { cn } from "@/lib/utils";
import { RowSelect } from "@/components/settings/row-select";
import type { SelectOption } from "@/components/ui/select-menu";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";

export const voiceInputProviderLabels: Record<VoiceInputProviderId, string> = {
  "supergrok-subscription": "SuperGrok subscription",
  "codex-subscription": "Codex subscription",
  openai: "OpenAI API · API billing",
  "azure-openai": "Azure OpenAI · Azure billing",
};

/** The Voice input row of Settings > General > New session defaults. */
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
  const selected = preferences?.preferredProvider ?? null;
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
        toast.error("Couldn't update voice input");
    } finally {
      setSaving(false);
    }
  }

  const reason = !available
    ? "This deployment has no transcription provider. Your operator can add one."
    : !canManage
      ? "Only workspace admins can change this."
      : undefined;
  const options: SelectOption<string>[] = [
    {
      value: AUTOMATIC,
      label: "Automatic",
      description: "Uses the first provider that's available.",
      ...(providers[0] ? { meta: voiceInputProviderLabels[providers[0]] } : {}),
    },
    ...(selected && !providers.includes(selected)
      ? [
          {
            value: selected,
            label: voiceInputProviderLabels[selected],
            disabled: true,
            disabledReason: "No longer available on this deployment.",
          },
        ]
      : []),
    ...providers.map((provider) => ({
      value: provider,
      label: voiceInputProviderLabels[provider],
    })),
  ];

  return (
    <SettingRow
      label="Voice input"
      description="Record a short message and add its transcript to the draft."
      control={
        <Switch
          checked={enabled && available}
          pending={saving}
          disabled={Boolean(reason)}
          disabledReason={reason}
          onCheckedChange={(next) =>
            void save(
              { enabled: next },
              next ? "Voice input is on for new sessions" : "Voice input is off for new sessions",
            )
          }
        />
      }
    >
      {enabled && available && providers.length > 1 ? (
        <>
          <SettingRow
            label="Transcription provider"
            description="Who transcribes, and which plan pays for it."
            controlWidth="select"
            control={
              <RowSelect
                options={options}
                value={selected ?? AUTOMATIC}
                disabled={!canManage || saving}
                onValueChange={(next) =>
                  void save(
                    {
                      preferredProvider: next === AUTOMATIC ? null : (next as VoiceInputProviderId),
                    },
                    "Transcription provider saved",
                  )
                }
              />
            }
          />
          <SettingRow
            label="Try another provider if one fails"
            description="Uses the next provider when one is down or refuses. Its billing applies."
            control={
              <Switch
                checked={fallbackEnabled}
                disabled={!canManage || saving}
                disabledReason={canManage ? undefined : "Only workspace admins can change this."}
                onCheckedChange={(next) =>
                  void save({ fallbackEnabled: next }, "Transcription fallback saved")
                }
              />
            }
          />
        </>
      ) : null}
    </SettingRow>
  );
}

const AUTOMATIC = "automatic";

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
          props.checked ? "border-primary-border bg-primary" : "border-transparent bg-switch-track",
        )}
      >
        <span
          className={cn(
            "inline-block size-3.5 rounded-full shadow-sm transition-transform",
            props.checked
              ? "translate-x-4 bg-primary-foreground"
              : "translate-x-0.5 bg-switch-thumb",
          )}
        />
      </button>
    </div>
  );
}
