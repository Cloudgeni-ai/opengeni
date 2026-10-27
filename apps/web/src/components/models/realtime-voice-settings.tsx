import type {
  RealtimeTurnEagerness,
  RealtimeVoiceSettings,
  WorkspaceRealtimeModelCatalogItem,
} from "@opengeni/sdk";
import { RotateCcwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import type { OrganizationModelDefaultsState } from "./use-organization-model-defaults";
import { possessive } from "./possessive";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { Field, FieldStack } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { Input } from "@opengeni/react/ui/input";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { SelectMenu, type SelectOption } from "@opengeni/react/ui/select-menu";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import {
  invalidateModelSettingsQueries,
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
} from "@opengeni/react/app/lib/shared-query";
import { errorMessage } from "@opengeni/contracts/values";

/* ----------------------------------------------------------------------------
   Voice settings for each realtime voice model: the voice, the conversation
   language and how eagerly the model takes its turn. Each model offers only
   what its provider supports (from the realtime model catalog), and an unset
   setting keeps the provider default.

   The organization sets defaults on its Models page; a workspace uses them
   for a model until it saves its own for that model. Voice sessions use these
   unless the app embedding Opengeni sets its own.

   The default voice model is the model a new voice conversation starts with
   until the person picks another one in the voice menu. A workspace's choice
   wins over its organization's; with neither, voice starts automatically with
   Codex Live when the person has it, else the first model they can use.
   -------------------------------------------------------------------------- */

const DEFAULT = "__default";
const PERSON_LANGUAGE = "__person";
const CUSTOM_VOICE = "__custom";
const AUTOMATIC = "__automatic";
const AUTOMATIC_DESCRIPTION =
  "Codex Live for people who have it connected, otherwise the first voice model they can use.";

const EAGERNESS_LABELS: Record<RealtimeTurnEagerness, { label: string; description: string }> = {
  low: {
    label: "Patient",
    description: "Waits longer before answering, for slower speakers.",
  },
  medium: { label: "Balanced", description: "Answers after a natural pause." },
  high: {
    label: "Quick",
    description: "Answers as soon as you finish speaking.",
  },
};

type VoiceModel = WorkspaceRealtimeModelCatalogItem;

function offersVoiceSettings(model: VoiceModel): boolean {
  return Boolean(
    model.voices?.length ||
    model.customVoice ||
    model.languages?.length ||
    model.turnEagerness?.length,
  );
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function voiceName(model: VoiceModel, voice: string): string {
  const listed = model.voices?.find((option) => option.id === voice)?.label;
  if (listed) return listed;
  // The provider's default voice is a name; any other unlisted voice is an id.
  return voice === model.voiceDefaults?.voice
    ? voice.charAt(0).toUpperCase() + voice.slice(1)
    : voice;
}

/** One model's settings as a scope sees them: its own, else what it inherits. */
type VoiceValues = {
  own: RealtimeVoiceSettings | null;
  inherited: RealtimeVoiceSettings | null;
};

function summary(model: VoiceModel, values: VoiceValues, inheritedFrom: string | null): string {
  const saved = values.own ?? values.inherited ?? {};
  const parts: string[] = [];
  if (model.voices?.length || model.customVoice) {
    const defaultVoice = model.voiceDefaults?.voice;
    parts.push(
      saved.voice
        ? `Voice: ${voiceName(model, saved.voice)}`
        : defaultVoice
          ? `Voice: ${voiceName(model, defaultVoice)} (default)`
          : "Default voice",
    );
  }
  if (model.languages?.length) {
    parts.push(saved.language ? languageName(saved.language) : "Each person's language");
  }
  const eagerness = saved.turnEagerness ?? model.voiceDefaults?.turnEagerness;
  if (model.turnEagerness?.length && eagerness) {
    parts.push(`${EAGERNESS_LABELS[eagerness].label} turn-taking`);
  }
  if (!values.own && values.inherited && inheritedFrom) parts.push(inheritedFrom);
  return parts.join(" · ");
}

function useVoiceCatalog(workspaceId: string): VoiceModel[] {
  const { client } = useAppContext();
  const query = useSharedQuery(
    client,
    ["model-settings", "realtime-voice-catalog", workspaceId],
    () => client.getWorkspaceRealtimeModelCatalog(workspaceId),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  return query.data?.models ?? [];
}

function voiceSettingsModels(catalog: VoiceModel[]): VoiceModel[] {
  return catalog.filter((model) => model.available && offersVoiceSettings(model));
}

/**
 * The voice model new voice conversations start with. Lists the models the
 * viewer can use, and keeps a saved choice visible even when it isn't usable
 * right now (for example after its key was removed).
 */
function DefaultVoiceModelRow({
  catalog,
  saved,
  automatic,
  description,
  canManage,
  onSave,
}: {
  catalog: VoiceModel[];
  /** The scope's own choice; null follows `automatic`. */
  saved: VoiceModel | null;
  /** The option that clears the scope's own choice, and what saving it says. */
  automatic: { label: string; description: string; saved: string };
  description: string;
  canManage: boolean;
  onSave: (model: VoiceModel | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const choices = catalog.filter((model) => model.available || model.id === saved?.id);
  if (!choices.some((model) => model.available)) return null;
  const options: SelectOption[] = [
    {
      value: AUTOMATIC,
      label: automatic.label,
      description: automatic.description,
    },
    ...choices.map((model) => ({
      value: model.id,
      label: model.label,
      description: model.available
        ? model.provider
        : (model.unavailableReason ?? "Not available right now"),
    })),
  ];
  return (
    <SettingRow
      label="Default voice model"
      description={description}
      controlWidth="select"
      control={
        <SelectMenu
          size="sm"
          align="end"
          aria-label="Default voice model"
          options={options}
          value={saved?.id ?? AUTOMATIC}
          showMetaInTrigger={false}
          disabled={!canManage || saving}
          disabledReason={canManage ? undefined : "Only admins can change this."}
          className="w-full"
          onValueChange={(value) => {
            if (value === (saved?.id ?? AUTOMATIC)) return;
            const model = value === AUTOMATIC ? null : catalog.find((item) => item.id === value);
            if (model === undefined) return;
            setSaving(true);
            void onSave(model)
              .then(
                () =>
                  toast.success(
                    model ? `New voice conversations start with ${model.label}` : automatic.saved,
                  ),
                (error: unknown) => toast.error(errorMessage(error)),
              )
              .finally(() => setSaving(false));
          }}
        />
      }
    />
  );
}

/** One workspace's voice settings, over its organization's defaults. */
export function RealtimeVoiceSettingsRows({
  workspaceId,
  canManage,
  organizationName,
}: {
  workspaceId: string;
  canManage: boolean;
  /** Names where inherited settings come from; null outside an organization. */
  organizationName?: string | null | undefined;
}) {
  const { client } = useAppContext();
  const catalog = useVoiceCatalog(workspaceId);
  const fromOrganization = organizationName
    ? `${possessive(organizationName)} default`
    : "Organization default";
  const organizationChoice = catalog.find((model) => model.organizationDefault) ?? null;
  return (
    <VoiceSettingsRows
      models={voiceSettingsModels(catalog)}
      leadingRow={
        <DefaultVoiceModelRow
          catalog={catalog}
          saved={catalog.find((model) => model.workspaceDefault) ?? null}
          automatic={
            organizationName
              ? {
                  label: `${fromOrganization}: ${organizationChoice?.label ?? "Automatic"}`,
                  description: organizationChoice
                    ? `Follows ${organizationName}.`
                    : `Follows ${organizationName}. ${AUTOMATIC_DESCRIPTION}`,
                  saved: `Voice conversations follow ${fromOrganization} again`,
                }
              : {
                  label: "Automatic",
                  description: AUTOMATIC_DESCRIPTION,
                  saved: "Voice conversations choose their model automatically again",
                }
          }
          description="The model a new voice conversation in this workspace starts with. People can still pick another one when they talk."
          canManage={canManage}
          onSave={async (model) => {
            try {
              await client.updateWorkspaceSettings(workspaceId, {
                realtimeDefaultModel: model?.id ?? null,
              });
            } catch (error) {
              throw new Error("Could not save the default voice model. Try again.", {
                cause: error,
              });
            }
            await invalidateModelSettingsQueries(client, false);
          }}
        />
      }
      values={(model) => ({
        own: model.workspaceVoiceSettings ?? null,
        inherited: model.organizationVoiceSettings ?? null,
      })}
      inheritedFrom={fromOrganization}
      canManage={canManage}
      resetLabel={(values) =>
        values.inherited ? "Use the organization's default" : "Reset to defaults"
      }
      dialogDescription="Applies to voice sessions started in this workspace after you save."
      onSave={async (model, settings) => {
        try {
          await client.updateWorkspaceSettings(workspaceId, {
            realtimeVoice: {
              [model.id]: settings && Object.keys(settings).length > 0 ? settings : null,
            },
          });
        } catch (error) {
          throw new Error("Could not save the voice settings. Try again.", {
            cause: error,
          });
        }
        await invalidateModelSettingsQueries(client, false);
      }}
    />
  );
}

/**
 * The organization's default voice settings, which every workspace uses for
 * a model until it saves its own. The models listed are the ones the anchor
 * workspace can use.
 */
export function OrganizationRealtimeVoiceSettingsRows({
  anchorWorkspaceId,
  defaults,
}: {
  anchorWorkspaceId: string;
  defaults: OrganizationModelDefaultsState;
}) {
  const { client } = useAppContext();
  const catalog = useVoiceCatalog(anchorWorkspaceId);
  const saved = defaults.defaults?.realtimeVoice ?? {};
  const savedDefault = defaults.defaults?.realtimeDefaultModel ?? null;
  return (
    <VoiceSettingsRows
      models={voiceSettingsModels(catalog)}
      leadingRow={
        <DefaultVoiceModelRow
          catalog={catalog}
          saved={catalog.find((model) => model.id === savedDefault) ?? null}
          automatic={{
            label: "Automatic",
            description: AUTOMATIC_DESCRIPTION,
            saved: "Voice conversations choose their model automatically again",
          }}
          description="The model a new voice conversation starts with in every workspace that hasn't chosen its own. People can still pick another one when they talk."
          canManage
          onSave={async (model) => {
            try {
              await defaults.update({
                realtimeDefaultModel: model?.id ?? null,
              });
            } catch (error) {
              throw new Error("Could not save the default voice model. Try again.", {
                cause: error,
              });
            }
            await invalidateModelSettingsQueries(client, false);
          }}
        />
      }
      values={(model) => ({ own: saved[model.id] ?? null, inherited: null })}
      inheritedFrom={null}
      canManage
      resetLabel={() => "Reset to defaults"}
      dialogDescription="Applies to voice sessions in every workspace that hasn't chosen its own settings for this model."
      onSave={async (model, settings) => {
        try {
          await defaults.update({
            realtimeVoice: {
              [model.id]: settings && Object.keys(settings).length > 0 ? settings : null,
            },
          });
        } catch (error) {
          throw new Error("Could not save the voice settings. Try again.", {
            cause: error,
          });
        }
        await invalidateModelSettingsQueries(client, false);
      }}
    />
  );
}

function VoiceSettingsRows({
  models,
  leadingRow,
  values,
  inheritedFrom,
  canManage,
  resetLabel,
  dialogDescription,
  onSave,
}: {
  models: VoiceModel[];
  /** A row shown before the per-model rows, such as the default voice model. */
  leadingRow?: ReactNode;
  values: (model: VoiceModel) => VoiceValues;
  inheritedFrom: string | null;
  canManage: boolean;
  resetLabel: (values: VoiceValues) => string;
  dialogDescription: string;
  onSave: (model: VoiceModel, settings: RealtimeVoiceSettings | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState<VoiceModel | null>(null);

  if (models.length === 0 && !leadingRow) return null;
  return (
    <>
      <SettingRowGroup>
        {leadingRow}
        {models.map((model) => {
          const modelValues = values(model);
          return (
            <SettingRow
              key={model.id}
              label={model.label}
              description={summary(model, modelValues, inheritedFrom)}
              control={
                canManage ? (
                  <div className="flex items-center gap-2">
                    <RowButton onClick={() => setEditing(model)}>Edit</RowButton>
                    {modelValues.own ? (
                      <MoreMenu label={`More actions for ${model.label}`} quiet>
                        <DropdownMenuItem
                          onSelect={() => {
                            void onSave(model, null).then(
                              () =>
                                toast.success(
                                  modelValues.inherited
                                    ? `${model.label} uses the organization's default again`
                                    : `${model.label} is back to its defaults`,
                                ),
                              (error: unknown) => toast.error(errorMessage(error)),
                            );
                          }}
                        >
                          <RotateCcwIcon />
                          {resetLabel(modelValues)}
                        </DropdownMenuItem>
                      </MoreMenu>
                    ) : null}
                  </div>
                ) : undefined
              }
            />
          );
        })}
      </SettingRowGroup>
      {editing ? (
        <VoiceSettingsDialog
          key={editing.id}
          model={editing}
          saved={(() => {
            const editingValues = values(editing);
            return editingValues.own ?? editingValues.inherited ?? {};
          })()}
          description={dialogDescription}
          onClose={() => setEditing(null)}
          onSave={(settings) => onSave(editing, settings)}
        />
      ) : null}
    </>
  );
}

function VoiceSettingsDialog({
  model,
  saved,
  description,
  onClose,
  onSave,
}: {
  model: VoiceModel;
  /** The settings the dialog starts from. */
  saved: RealtimeVoiceSettings;
  description: string;
  onClose: () => void;
  onSave: (settings: RealtimeVoiceSettings) => Promise<void>;
}) {
  const defaults = model.voiceDefaults ?? {};
  const listedVoice = (id: string | undefined) =>
    id !== undefined && (model.voices ?? []).some((option) => option.id === id);
  // A saved voice that isn't a listed one is a custom voice id.
  const [voice, setVoice] = useState(
    saved.voice === undefined
      ? DEFAULT
      : listedVoice(saved.voice)
        ? saved.voice
        : model.customVoice
          ? CUSTOM_VOICE
          : DEFAULT,
  );
  const [customVoiceId, setCustomVoiceId] = useState(
    saved.voice !== undefined && !listedVoice(saved.voice) ? saved.voice : "",
  );
  const [language, setLanguage] = useState(saved.language ?? PERSON_LANGUAGE);
  const [eagerness, setEagerness] = useState<string>(saved.turnEagerness ?? DEFAULT);

  const voiceOptions: SelectOption[] = [
    {
      value: DEFAULT,
      label: defaults.voice ? `${voiceName(model, defaults.voice)} (default)` : "Default",
    },
    ...(model.voices ?? [])
      .filter((option) => option.id !== defaults.voice)
      .map((option) => ({ value: option.id, label: option.label })),
    ...(model.customVoice
      ? [
          {
            value: CUSTOM_VOICE,
            label: "Another voice by ID",
            description: "Any voice your provider account can use.",
          },
        ]
      : []),
  ];
  const languageOptions: SelectOption[] = [
    {
      value: PERSON_LANGUAGE,
      label: "Each person's language",
      description: "Follows the app or browser language of whoever is talking.",
    },
    ...(model.languages ?? [])
      .map((code) => ({
        value: code,
        label: languageName(code),
        keywords: [code],
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const defaultEagerness = defaults.turnEagerness;
  const eagernessOptions: SelectOption[] = [
    {
      value: DEFAULT,
      label: defaultEagerness ? `${EAGERNESS_LABELS[defaultEagerness].label} (default)` : "Default",
      ...(defaultEagerness ? { description: EAGERNESS_LABELS[defaultEagerness].description } : {}),
    },
    ...(model.turnEagerness ?? [])
      .filter((value) => value !== defaultEagerness)
      .map((value) => ({
        value,
        label: EAGERNESS_LABELS[value].label,
        description: EAGERNESS_LABELS[value].description,
      })),
  ];

  async function submit() {
    const chosenVoice = voice === CUSTOM_VOICE ? customVoiceId.trim() : voice;
    const settings: RealtimeVoiceSettings = {
      ...(chosenVoice && chosenVoice !== DEFAULT && chosenVoice !== defaults.voice
        ? { voice: chosenVoice }
        : {}),
      ...(language !== PERSON_LANGUAGE ? { language } : {}),
      ...(eagerness !== DEFAULT ? { turnEagerness: eagerness as RealtimeTurnEagerness } : {}),
    };
    await onSave(settings);
    toast.success(`Voice settings saved for ${model.label}`);
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      title={`${model.label} voice`}
      description={description}
      submitLabel="Save"
      pendingLabel="Saving…"
      onSubmit={submit}
      onSubmitted={onClose}
    >
      <FieldStack>
        {voiceOptions.length > 1 ? (
          <Field label="Voice">
            <SelectMenu size="md" options={voiceOptions} value={voice} onValueChange={setVoice} />
          </Field>
        ) : null}
        {voice === CUSTOM_VOICE ? (
          <Field
            label="Voice ID"
            hint="For ElevenLabs, the voice must be in the account's My Voices. Add a voice from the voice library there first, then copy its ID."
          >
            <Input
              value={customVoiceId}
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={128}
              onChange={(event) => setCustomVoiceId(event.target.value)}
            />
          </Field>
        ) : null}
        {model.languages?.length ? (
          <Field label="Language" hint="The voice listens and replies in this language.">
            <SelectMenu
              variant="combobox"
              size="md"
              searchPlaceholder="Search languages"
              options={languageOptions}
              value={language}
              onValueChange={setLanguage}
            />
          </Field>
        ) : null}
        {model.turnEagerness?.length ? (
          <Field label="Turn-taking">
            <SelectMenu
              size="md"
              options={eagernessOptions}
              value={eagerness}
              onValueChange={setEagerness}
            />
          </Field>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}
