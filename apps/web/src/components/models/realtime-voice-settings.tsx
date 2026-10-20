import type {
  RealtimeTurnEagerness,
  RealtimeVoiceSettings,
  WorkspaceRealtimeModelCatalogItem,
} from "@opengeni/sdk";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Field, FieldStack } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import {
  invalidateModelSettingsQueries,
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
} from "@/lib/shared-query";

/* ----------------------------------------------------------------------------
   The workspace's voice settings for each realtime voice model: the voice, the
   conversation language and how eagerly the model takes its turn. Each model
   offers only what its provider supports (from the realtime model catalog),
   and an unset setting keeps the provider default. Voice sessions started in
   the workspace use these unless the app embedding Opengeni sets its own.
   -------------------------------------------------------------------------- */

const DEFAULT = "__default";
const PERSON_LANGUAGE = "__person";
const CUSTOM_VOICE = "__custom";

const EAGERNESS_LABELS: Record<RealtimeTurnEagerness, { label: string; description: string }> = {
  low: { label: "Patient", description: "Waits longer before answering, for slower speakers." },
  medium: { label: "Balanced", description: "Answers after a natural pause." },
  high: { label: "Quick", description: "Answers as soon as you finish speaking." },
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

function summary(model: VoiceModel): string {
  const saved = model.workspaceVoiceSettings ?? {};
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
  return parts.join(" · ");
}

export function RealtimeVoiceSettingsRows({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const { client } = useAppContext();
  const query = useSharedQuery(
    client,
    ["model-settings", "realtime-voice-catalog", workspaceId],
    () => client.getWorkspaceRealtimeModelCatalog(workspaceId),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  const [editing, setEditing] = useState<VoiceModel | null>(null);
  const models = (query.data?.models ?? []).filter(
    (model) => model.available && offersVoiceSettings(model),
  );

  async function save(model: VoiceModel, settings: RealtimeVoiceSettings | null) {
    try {
      await client.updateWorkspaceSettings(workspaceId, {
        realtimeVoice: {
          [model.id]: settings && Object.keys(settings).length > 0 ? settings : null,
        },
      });
    } catch (error) {
      throw new Error("Could not save the voice settings. Try again.", { cause: error });
    }
    await invalidateModelSettingsQueries(client, false);
  }

  if (models.length === 0) return null;
  return (
    <>
      <SettingRowGroup>
        {models.map((model) => (
          <SettingRow
            key={model.id}
            label={model.label}
            description={summary(model)}
            control={
              canManage ? (
                <div className="flex items-center gap-2">
                  <RowButton onClick={() => setEditing(model)}>Edit</RowButton>
                  {model.workspaceVoiceSettings ? (
                    <MoreMenu label={`More actions for ${model.label}`} quiet>
                      <DropdownMenuItem
                        onSelect={() => {
                          void save(model, null).then(
                            () => toast.success(`${model.label} is back to its defaults`),
                            (error: unknown) =>
                              toast.error(error instanceof Error ? error.message : String(error)),
                          );
                        }}
                      >
                        <RotateCcwIcon />
                        Reset to defaults
                      </DropdownMenuItem>
                    </MoreMenu>
                  ) : null}
                </div>
              ) : undefined
            }
          />
        ))}
      </SettingRowGroup>
      {editing ? (
        <VoiceSettingsDialog
          key={editing.id}
          model={editing}
          onClose={() => setEditing(null)}
          onSave={(settings) => save(editing, settings)}
        />
      ) : null}
    </>
  );
}

function VoiceSettingsDialog({
  model,
  onClose,
  onSave,
}: {
  model: VoiceModel;
  onClose: () => void;
  onSave: (settings: RealtimeVoiceSettings) => Promise<void>;
}) {
  const saved = model.workspaceVoiceSettings ?? {};
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
      .map((code) => ({ value: code, label: languageName(code), keywords: [code] }))
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
      description="Applies to voice sessions started in this workspace after you save."
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
