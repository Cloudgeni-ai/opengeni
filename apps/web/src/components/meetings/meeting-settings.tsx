// Workspace settings → General → Meetings: who sees new meetings, and which
// model transcribes them. Both live under the workspace's `recordings`
// settings, which a patch replaces as a whole.
import { useState } from "react";
import { toast } from "sonner";

import {
  resolveWorkspaceRecordingSettings,
  type RecordingVisibility,
  type WorkspaceRecordingSettings,
} from "@opengeni/contracts";
import { useAppContext } from "@opengeni/react/app/app-context";
import { useRecordingModels, type RecordingsClientOverride } from "@opengeni/react/recordings";
import { Section } from "@opengeni/react/ui/section";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { NativeSelect, type SelectOption } from "@opengeni/react/ui/select-menu";
import { SettingRow, SettingRowLink } from "@opengeni/react/ui/setting-row";

const DEFAULT = "default";

export function MeetingDefaultsSection({
  workspaceId,
  personal,
  canManage,
  onConnectModels,
}: {
  workspaceId: string;
  /** A Personal workspace has only its person, so visibility has nothing to choose. */
  personal: boolean;
  canManage: boolean;
  /** Opens where model accounts are added, for people who may add them. */
  onConnectModels?: (() => void) | undefined;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  return (
    <MeetingDefaultsView
      workspaceId={workspaceId}
      settings={resolveWorkspaceRecordingSettings(workspace?.settings)}
      personal={personal}
      canManage={canManage}
      onConnectModels={onConnectModels}
      onSave={async (next) => {
        const accepted = context.captureWorkspaceInvocation(workspaceId);
        if (!accepted) return false;
        const updated = await context.updateWorkspaceSettings(workspaceId, { recordings: next });
        return Boolean(updated) && context.ownsWorkspaceInvocation(workspaceId, accepted);
      }}
    />
  );
}

/** The Meetings settings rows over plain values, so previews can render them. */
export function MeetingDefaultsView({
  workspaceId,
  settings: current,
  personal,
  canManage,
  onConnectModels,
  onSave,
  recordings,
}: {
  workspaceId: string;
  settings: WorkspaceRecordingSettings;
  personal: boolean;
  canManage: boolean;
  onConnectModels?: (() => void) | undefined;
  /** Saves the whole `recordings` settings; false when a newer change took over. */
  onSave: (next: WorkspaceRecordingSettings) => Promise<boolean>;
  /** A recordings client to use instead of the app's, for previews. */
  recordings?: RecordingsClientOverride["recordings"];
}) {
  const models = useRecordingModels({ workspaceId, ...(recordings ? { recordings } : {}) });
  const [saving, setSaving] = useState(false);
  const reason = canManage ? undefined : "Only workspace admins can change this.";

  async function save(next: WorkspaceRecordingSettings, success: string) {
    setSaving(true);
    try {
      if (await onSave(next)) toast.success(success);
    } catch {
      toast.error("Couldn't update meeting settings");
    } finally {
      setSaving(false);
    }
  }

  const visibility: RecordingVisibility = current.defaultVisibility ?? "private";
  const chooseVisibility = (next: RecordingVisibility) => {
    if (next === visibility) return;
    const { defaultVisibility: _previous, ...rest } = current;
    void save(
      next === "private" ? rest : { ...rest, defaultVisibility: next },
      next === "workspace"
        ? "New meetings are shared with the workspace"
        : "New meetings are private",
    );
  };

  const fallback = models.defaultModel;
  const fallbackName =
    models.models.find(
      (entry) => entry.providerId === fallback?.providerId && entry.model === fallback?.model,
    )?.name ?? null;
  const chosen = current.transcription
    ? `${current.transcription.providerId}/${current.transcription.model}`
    : DEFAULT;
  const modelOptions: SelectOption[] = [
    {
      value: DEFAULT,
      label: fallbackName ? `Default (${fallbackName})` : "Default",
    },
    ...models.models.map((entry) => ({
      value: `${entry.providerId}/${entry.model}`,
      label: entry.name,
      meta:
        entry.usdPerHour !== null ? `$${entry.usdPerHour.toFixed(2)} per hour` : entry.providerName,
      disabled: !entry.available,
      disabledReason: entry.available ? undefined : `Connect ${entry.providerName} first`,
    })),
  ];
  const chooseModel = (value: string) => {
    if (value === chosen) return;
    const { transcription: _previous, ...rest } = current;
    const entry = models.models.find(
      (candidate) => `${candidate.providerId}/${candidate.model}` === value,
    );
    void save(
      entry
        ? { ...rest, transcription: { providerId: entry.providerId, model: entry.model } }
        : rest,
      entry ? `New meetings use ${entry.name}` : "New meetings use the default model",
    );
  };
  const noneAvailable =
    !models.loading && !models.error && !models.models.some((entry) => entry.available);

  return (
    <Section title="Meetings" description="Applied to meetings recorded from now on.">
      {personal ? null : (
        <SettingRow
          label="Who sees new meetings"
          description={
            visibility === "workspace"
              ? "Everyone in this workspace can open a new meeting. Whoever recorded it can make it private."
              : "Only the person who recorded a meeting can open it, until they share it with the workspace."
          }
          controlWidth="auto"
          control={
            <SegmentedControl
              size="sm"
              value={visibility}
              onValueChange={(next) => chooseVisibility(next as RecordingVisibility)}
              options={[
                { value: "private", label: "Only me" },
                { value: "workspace", label: "Workspace" },
              ].map((option) => ({
                ...option,
                disabled: saving || !canManage,
                ...(reason ? { disabledReason: reason } : {}),
              }))}
            />
          }
        />
      )}
      <SettingRow
        label="Transcription model"
        description="Turns a meeting's audio into a transcript with speakers. A meeting can still be transcribed again with another model."
        controlWidth="select"
        hint={
          noneAvailable ? (
            onConnectModels ? (
              <SettingRowLink onClick={onConnectModels}>
                Connect a transcription provider to transcribe meetings
              </SettingRowLink>
            ) : (
              "An organization admin needs to connect a transcription provider before meetings are transcribed."
            )
          ) : undefined
        }
        control={
          <NativeSelect
            aria-label="Transcription model"
            options={modelOptions}
            value={chosen}
            onValueChange={chooseModel}
            loading={models.loading && models.models.length === 0}
            disabled={saving || !canManage}
            {...(reason ? { disabledReason: reason } : {})}
          />
        }
      />
    </Section>
  );
}
