import {
  resolveWorkspaceTranscriptionPolicy,
  type TranscriptionCredentialMode,
  type WorkspaceTranscriptionPolicy,
  type WorkspaceTranscriptionTarget,
} from "@opengeni/sdk";
import { CheckIcon, Loader2Icon, MicIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";

type TargetDraft = {
  provider: string;
  model: string;
  credentialMode: TranscriptionCredentialMode;
  credentialConnectionId: string;
  region: string;
};

type PolicyDraft = {
  enabled: boolean;
  primary: TargetDraft;
  language: string;
  autoDetectLanguage: boolean;
  diarizationEnabled: boolean;
  maxSpeakers: string;
  retentionMode: WorkspaceTranscriptionPolicy["retention"]["mode"];
  retentionDays: string;
  allowProviderLogging: boolean;
  allowProviderTraining: boolean;
  fallbackEnabled: boolean;
  fallback: TargetDraft;
  maxPerHour: string;
  maxPerMonth: string;
};

const emptyTarget = (): TargetDraft => ({
  provider: "",
  model: "",
  credentialMode: "managed",
  credentialConnectionId: "",
  region: "",
});

export function TranscriptionSettingsSection({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const policy = useMemo(
    () => resolveWorkspaceTranscriptionPolicy(workspace?.settings),
    [workspace?.settings],
  );
  const [draft, setDraft] = useState(() => draftFromPolicy(policy));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(draftFromPolicy(policy));
  }, [workspaceId, policy]);

  function patchPrimary(patch: Partial<TargetDraft>) {
    setDraft((current) => ({ ...current, primary: { ...current.primary, ...patch } }));
  }

  function patchFallback(patch: Partial<TargetDraft>) {
    setDraft((current) => ({ ...current, fallback: { ...current.fallback, ...patch } }));
  }

  async function save() {
    let next: WorkspaceTranscriptionPolicy;
    try {
      next = policyFromDraft(draft);
    } catch (error) {
      toast.error("Transcription settings need attention", {
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        transcription: next,
      });
      if (updated) {
        toast.success(next.enabled ? "Transcription policy accepted" : "Transcription disabled");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <MicIcon className="size-3.5 text-brand" />
            Voice transcription
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Controls the separate speech-to-text capability used by the composer. No turn model or
            coding-model subscription is authorized by this policy.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          aria-label="Voice transcription"
          disabled={saving || !canManage}
          onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            draft.enabled ? "border-brand bg-brand" : "border-border bg-surface-2",
          )}
        >
          <span
            className={cn(
              "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
              draft.enabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {draft.enabled ? (
        <div className="grid gap-4 border-t border-border pt-4">
          <TargetFields
            legend="Primary accepted target"
            target={draft.primary}
            disabled={!canManage || saving}
            onChange={patchPrimary}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Language"
              hint="Required BCP 47 tag unless automatic detection is explicitly accepted."
            >
              <Input
                value={draft.language}
                disabled={!canManage || saving || draft.autoDetectLanguage}
                placeholder="en-US"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, language: event.target.value }))
                }
              />
            </Field>
            <Field label="Retention">
              <Select
                value={draft.retentionMode}
                disabled={!canManage || saving}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    retentionMode: event.target.value as PolicyDraft["retentionMode"],
                  }))
                }
              >
                <option value="none">No provider retention accepted</option>
                <option value="provider-policy">Provider policy accepted</option>
              </Select>
            </Field>
            {draft.retentionMode === "provider-policy" ? (
              <Field label="Maximum retention days" hint="Blank when the provider does not commit.">
                <Input
                  type="number"
                  min="0"
                  max="3650"
                  value={draft.retentionDays}
                  disabled={!canManage || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      retentionDays: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}
          </div>

          <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium">Recognition features</legend>
            <Checkbox
              checked={draft.autoDetectLanguage}
              disabled={!canManage || saving}
              label="Allow automatic spoken-language detection"
              onChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  autoDetectLanguage: checked,
                  ...(checked ? { language: "" } : {}),
                }))
              }
            />
            <Checkbox
              checked={draft.diarizationEnabled}
              disabled={!canManage || saving}
              label="Allow speaker diarization"
              onChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  diarizationEnabled: checked,
                  ...(!checked ? { maxSpeakers: "" } : {}),
                }))
              }
            />
            {draft.diarizationEnabled ? (
              <Field
                label="Maximum speakers"
                hint="Optional accepted limit from 2 to 100 speakers."
              >
                <Input
                  type="number"
                  min="2"
                  max="100"
                  step="1"
                  value={draft.maxSpeakers}
                  disabled={!canManage || saving}
                  placeholder="Provider default"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, maxSpeakers: event.target.value }))
                  }
                />
              </Field>
            ) : null}
          </fieldset>

          <fieldset className="grid gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-medium">Privacy acceptance</legend>
            <Checkbox
              checked={draft.allowProviderLogging}
              disabled={!canManage || saving}
              label="Allow provider request logging"
              onChange={(checked) =>
                setDraft((current) => ({ ...current, allowProviderLogging: checked }))
              }
            />
            <Checkbox
              checked={draft.allowProviderTraining}
              disabled={!canManage || saving}
              label="Allow provider training on workspace audio/transcripts"
              onChange={(checked) =>
                setDraft((current) => ({ ...current, allowProviderTraining: checked }))
              }
            />
          </fieldset>

          <fieldset className="grid gap-3 rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-medium">Fallback</legend>
            <Checkbox
              checked={draft.fallbackEnabled}
              disabled={!canManage || saving}
              label="Accept one explicit fallback target"
              onChange={(checked) =>
                setDraft((current) => ({ ...current, fallbackEnabled: checked }))
              }
            />
            {draft.fallbackEnabled ? (
              <TargetFields
                legend="Fallback accepted target"
                target={draft.fallback}
                disabled={!canManage || saving}
                onChange={patchFallback}
                nested
              />
            ) : null}
            <p className="text-2xs text-fg-subtle">
              Runtime fallback remains blocked unless the host explicitly selects this exact target;
              there is no silent provider switch.
            </p>
          </fieldset>

          <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium">Cost ceilings (USD)</legend>
            <Field label="Maximum per audio hour">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={draft.maxPerHour}
                disabled={!canManage || saving}
                placeholder="No ceiling"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxPerHour: event.target.value }))
                }
              />
            </Field>
            <Field label="Maximum per month">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={draft.maxPerMonth}
                disabled={!canManage || saving}
                placeholder="No ceiling"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxPerMonth: event.target.value }))
                }
              />
            </Field>
          </fieldset>
        </div>
      ) : (
        <p className="text-xs text-fg-subtle">
          Disabled by default. The composer cannot start any speech adapter until an admin saves an
          exact accepted target.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs text-fg-subtle">
          BYOK fields store only a workspace connection UUID; secret values stay in the connection
          broker. Azure Speech is accepted only as BYOK.
        </p>
        {canManage ? (
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            Save policy
          </Button>
        ) : (
          <p className="text-xs text-fg-subtle">Only workspace admins can change this.</p>
        )}
      </div>
    </section>
  );
}

function TargetFields({
  legend,
  target,
  disabled,
  onChange,
  nested = false,
}: {
  legend: string;
  target: TargetDraft;
  disabled: boolean;
  onChange: (patch: Partial<TargetDraft>) => void;
  nested?: boolean;
}) {
  return (
    <fieldset
      className={cn("grid gap-3 sm:grid-cols-2", !nested && "rounded-md border border-border p-3")}
    >
      <legend className="px-1 text-xs font-medium">{legend}</legend>
      <Field label="Provider ID">
        <Input
          value={target.provider}
          disabled={disabled}
          placeholder="speech-provider"
          onChange={(event) => onChange({ provider: event.target.value })}
        />
      </Field>
      <Field label="Model ID" hint="Blank accepts the provider default as an explicit null model.">
        <Input
          value={target.model}
          disabled={disabled}
          placeholder="provider default"
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </Field>
      <Field label="Credential mode">
        <Select
          value={target.credentialMode}
          disabled={disabled}
          onChange={(event) => {
            const credentialMode = event.target.value as TranscriptionCredentialMode;
            onChange({
              credentialMode,
              ...(credentialMode === "managed" ? { credentialConnectionId: "" } : {}),
            });
          }}
        >
          <option value="managed">Managed adapter</option>
          <option value="byok">Workspace BYOK connection</option>
        </Select>
      </Field>
      {target.credentialMode === "byok" ? (
        <Field label="BYOK connection UUID" hint="Reference only; never paste an API key here.">
          <Input
            value={target.credentialConnectionId}
            disabled={disabled}
            placeholder="00000000-0000-4000-8000-000000000000"
            onChange={(event) => onChange({ credentialConnectionId: event.target.value })}
          />
        </Field>
      ) : null}
      <Field label="Region" hint="Blank accepts an unpinned provider region.">
        <Input
          value={target.region}
          disabled={disabled}
          placeholder="provider default"
          onChange={(event) => onChange({ region: event.target.value })}
        />
      </Field>
    </fieldset>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Label className="grid content-start gap-1.5 text-xs">
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal text-2xs text-fg-subtle">{hint}</span> : null}
    </Label>
  );
}

function Checkbox({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-fg-muted">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        className="mt-0.5 size-3.5 accent-brand"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function draftFromPolicy(policy: WorkspaceTranscriptionPolicy): PolicyDraft {
  const fallback = policy.fallback.targets[0] ?? null;
  return {
    enabled: policy.enabled,
    primary: targetDraft(policy.primary),
    language: policy.language ?? "",
    autoDetectLanguage: policy.autoDetectLanguage,
    diarizationEnabled: policy.diarization.enabled,
    maxSpeakers: policy.diarization.maxSpeakers?.toString() ?? "",
    retentionMode: policy.retention.mode,
    retentionDays: policy.retention.maxDays?.toString() ?? "",
    allowProviderLogging: policy.privacy.allowProviderLogging,
    allowProviderTraining: policy.privacy.allowProviderTraining,
    fallbackEnabled: policy.fallback.mode === "explicit",
    fallback: targetDraft(fallback),
    maxPerHour: policy.cost.maxPerHour?.toString() ?? "",
    maxPerMonth: policy.cost.maxPerMonth?.toString() ?? "",
  };
}

function targetDraft(target: WorkspaceTranscriptionTarget | null): TargetDraft {
  return target
    ? {
        provider: target.provider,
        model: target.model ?? "",
        credentialMode: target.credentialMode,
        credentialConnectionId: target.credentialConnectionId ?? "",
        region: target.region ?? "",
      }
    : emptyTarget();
}

function policyFromDraft(draft: PolicyDraft): WorkspaceTranscriptionPolicy {
  if (!draft.enabled) {
    return {
      enabled: false,
      acceptanceId: null,
      primary: null,
      language: null,
      autoDetectLanguage: false,
      diarization: { enabled: false, maxSpeakers: null },
      retention: { mode: "none", maxDays: null },
      privacy: { allowProviderLogging: false, allowProviderTraining: false },
      fallback: { mode: "disabled", targets: [] },
      cost: { currency: "USD", maxPerHour: null, maxPerMonth: null },
    };
  }
  const primary = targetFromDraft(draft.primary, "Primary");
  const fallback = draft.fallbackEnabled ? [targetFromDraft(draft.fallback, "Fallback")] : [];
  const language = emptyToNull(draft.language);
  if (!draft.autoDetectLanguage && language === null) {
    throw new Error("Language is required unless automatic detection is accepted.");
  }
  return {
    enabled: true,
    acceptanceId: crypto.randomUUID(),
    primary,
    language: draft.autoDetectLanguage ? null : language,
    autoDetectLanguage: draft.autoDetectLanguage,
    diarization: {
      enabled: draft.diarizationEnabled,
      maxSpeakers: draft.diarizationEnabled
        ? boundedInteger(draft.maxSpeakers, "Maximum speakers", 2, 100, true)
        : null,
    },
    retention: {
      mode: draft.retentionMode,
      maxDays:
        draft.retentionMode === "provider-policy"
          ? boundedNumber(draft.retentionDays, "Maximum retention days", 3650, true)
          : null,
    },
    privacy: {
      allowProviderLogging: draft.allowProviderLogging,
      allowProviderTraining: draft.allowProviderTraining,
    },
    fallback: {
      mode: draft.fallbackEnabled ? "explicit" : "disabled",
      targets: fallback,
    },
    cost: {
      currency: "USD",
      maxPerHour: boundedNumber(draft.maxPerHour, "Maximum per audio hour", 10_000, true),
      maxPerMonth: boundedNumber(draft.maxPerMonth, "Maximum per month", 1_000_000, true),
    },
  };
}

function targetFromDraft(draft: TargetDraft, label: string): WorkspaceTranscriptionTarget {
  const provider = draft.provider.trim();
  if (!provider) throw new Error(`${label} provider ID is required.`);
  if (provider === "azure-speech" && draft.credentialMode !== "byok") {
    throw new Error("Azure Speech is accepted only through a workspace BYOK connection.");
  }
  const connectionId = emptyToNull(draft.credentialConnectionId);
  if (draft.credentialMode === "byok" && !connectionId) {
    throw new Error(`${label} BYOK target requires a connection UUID.`);
  }
  if (connectionId && !isUuid(connectionId)) {
    throw new Error(`${label} connection reference must be a UUID, never a credential value.`);
  }
  return {
    provider,
    model: emptyToNull(draft.model),
    credentialMode: draft.credentialMode,
    credentialConnectionId: draft.credentialMode === "byok" ? connectionId : null,
    region: emptyToNull(draft.region),
  };
}

function emptyToNull(value: string): string | null {
  return value.trim() || null;
}

function boundedNumber(
  value: string,
  label: string,
  maximum: number,
  nullable: true,
): number | null {
  if (!value.trim() && nullable) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} must be between 0 and ${maximum}.`);
  }
  return parsed;
}

function boundedInteger(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
  nullable: true,
): number | null {
  if (!value.trim() && nullable) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
