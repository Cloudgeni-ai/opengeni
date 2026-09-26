import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import {
  SettingRow,
  SettingRowGroup,
  SettingRowLink,
  SettingRowSkeleton,
  useSettingRowField,
  type SettingRowVariant,
} from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { connectedCapabilities, currentWorkspace, sessionDefaults } from "../fixtures";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import { usePick } from "../picks";
import { alternativeLetter, type AlternativeId } from "./registry";

/* ----------------------------------------------------------------------------
   Shared content: the four "New session defaults" on the General page.
   -------------------------------------------------------------------------- */

type FastCodeSearch = typeof sessionDefaults.fastCodeSearch;
type TranscriptionProvider = typeof sessionDefaults.transcriptionProvider;

const VARIANT_BY_ID: Record<AlternativeId, SettingRowVariant> = {
  a: "control-right",
  b: "control-left",
  c: "stacked",
};

const FAST_CODE_SEARCH_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const satisfies ReadonlyArray<{ value: FastCodeSearch; label: string }>;

/** Automatic shows what it resolves to today, like every model choice shows who pays. */
const PROVIDER_OPTIONS: SelectOption<TranscriptionProvider>[] =
  sessionDefaults.transcriptionProviders.map((provider) => ({
    value: provider.id as TranscriptionProvider,
    label: provider.label,
    meta: provider.id === "automatic" ? "Codex plan" : undefined,
    description: provider.description,
  }));

const connectedAppNames = connectedCapabilities.map((capability) => capability.name);

const COPY = {
  voice: {
    label: "Voice input",
    description: "Speak instead of typing. Your recording is transcribed into the message box.",
  },
  provider: {
    label: "Transcription provider",
    description: "The service that turns your recording into text.",
  },
  video: {
    label: "Video generation",
    description: "Let agents create short video clips in chats.",
    reason: "Video models are paid through AI Gateway. A workspace admin can connect it in Models.",
    action: "Connect AI Gateway",
  },
  codeSearch: {
    label: "Fast code search",
    description:
      "Indexes repositories so agents search large codebases faster. Default follows this server's setting.",
  },
  apps: {
    label: "Use connected apps automatically",
    description: `New sessions can use ${connectedAppNames.slice(0, -1).join(", ")} and ${
      connectedAppNames.at(-1) ?? ""
    } without adding them first.`,
  },
};

/** The row's select, in the style picked for Select (native for A, the menu otherwise). */
function TranscriptionSelect({
  value,
  onChange,
}: {
  value: TranscriptionProvider;
  onChange: (value: TranscriptionProvider) => void;
}) {
  const field = useSettingRowField();
  const native = usePick("select") === "a";
  return (
    <SelectMenu
      variant={native ? "native" : "menu"}
      size="sm"
      align="end"
      options={PROVIDER_OPTIONS}
      value={value}
      onValueChange={onChange}
      showSelectedDescription={false}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
    />
  );
}

function VoiceInputRow({
  variant,
  initialOn = sessionDefaults.voiceInput,
}: {
  variant: SettingRowVariant;
  initialOn?: boolean;
}) {
  const [on, setOn] = useState(initialOn);
  const [provider, setProvider] = useState(sessionDefaults.transcriptionProvider);
  return (
    <SettingRow
      variant={variant}
      label={COPY.voice.label}
      description={COPY.voice.description}
      control={<Switch checked={on} onCheckedChange={setOn} />}
    >
      {on ? (
        <SettingRow
          variant={variant}
          label={COPY.provider.label}
          description={COPY.provider.description}
          controlWidth="select"
          control={<TranscriptionSelect value={provider} onChange={setProvider} />}
        />
      ) : null}
    </SettingRow>
  );
}

function VideoGenerationRow({ variant }: { variant: SettingRowVariant }) {
  return (
    <SettingRow
      variant={variant}
      label={COPY.video.label}
      description={COPY.video.description}
      hint={
        <SettingRowLink onClick={() => toast("This opens Models, where AI Gateway is connected.")}>
          {COPY.video.action}
        </SettingRowLink>
      }
      control={<Switch checked={false} disabled disabledReason={COPY.video.reason} />}
    />
  );
}

function FastCodeSearchRow({ variant }: { variant: SettingRowVariant }) {
  const [value, setValue] = useState<FastCodeSearch>(sessionDefaults.fastCodeSearch);
  return (
    <SettingRow
      variant={variant}
      label={COPY.codeSearch.label}
      description={COPY.codeSearch.description}
      controlWidth="auto"
      control={
        <SegmentedControl
          size="sm"
          options={FAST_CODE_SEARCH_OPTIONS}
          value={value}
          onValueChange={setValue}
        />
      }
    />
  );
}

function ConnectedAppsRow({ variant, error }: { variant: SettingRowVariant; error?: string }) {
  const [on, setOn] = useState(sessionDefaults.useConnectedAppsAutomatically);
  return (
    <SettingRow
      variant={variant}
      label={COPY.apps.label}
      description={COPY.apps.description}
      error={error}
      control={<Switch checked={on} onCheckedChange={setOn} />}
    />
  );
}

function SessionDefaults({ variant }: { variant: SettingRowVariant }) {
  return (
    <section aria-label="New session defaults" className="min-w-0">
      <h3 className="text-sm font-semibold text-fg">New session defaults</h3>
      <p className="mt-1 text-xs leading-4.5 text-fg-muted">
        Applied when someone starts a new session in {currentWorkspace.name}.
      </p>
      <SettingRowGroup className="mt-3">
        <VoiceInputRow variant={variant} />
        <VideoGenerationRow variant={variant} />
        <FastCodeSearchRow variant={variant} />
        <ConnectedAppsRow variant={variant} />
      </SettingRowGroup>
    </section>
  );
}

/* ----------------------------------------------------------------------------
   States that need a little behaviour.
   -------------------------------------------------------------------------- */

/** Toggle, save for a moment with the spinner in the thumb, then confirm with a toast. */
function SaveAndToastRow({ variant }: { variant: SettingRowVariant }) {
  const [on, setOn] = useState(true);
  const [pending, setPending] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const change = (next: boolean) => {
    setOn(next);
    setPending(true);
    timer.current = window.setTimeout(() => {
      setPending(false);
      toast.success(`Voice input is ${next ? "on" : "off"} for new sessions`);
    }, 900);
  };
  return (
    <SettingRow
      variant={variant}
      label={COPY.voice.label}
      description={COPY.voice.description}
      control={<Switch checked={on} pending={pending} onCheckedChange={change} />}
    />
  );
}

/* ----------------------------------------------------------------------------
   Section
   -------------------------------------------------------------------------- */

export default function SettingRowSection() {
  const pick = usePick("setting-row");
  const variant = VARIANT_BY_ID[pick];
  return (
    <KitSection sectionKey="setting-row">
      <Fork layout="stack">
        {(["a", "b", "c"] as const).map((id) => (
          <Alternative key={id} id={id}>
            <SessionDefaults variant={VARIANT_BY_ID[id]} />
          </Alternative>
        ))}
      </Fork>

      <StatesGrid
        columns={2}
        description={`Shown in version ${alternativeLetter(pick)}, your pick or the recommended one. Every state works the same in all three.`}
      >
        <StateCell label="Default" align="stretch">
          <ConnectedAppsRow variant={variant} />
        </StateCell>
        <StateCell
          label="Disabled with reason"
          align="stretch"
          note="Hover, focus or tap the switch for the reason. The link fixes it."
        >
          <VideoGenerationRow variant={variant} />
        </StateCell>
        <StateCell
          label="Saving"
          align="stretch"
          note="The spinner sits in the thumb. The switch keeps focus and ignores clicks."
        >
          <SettingRow
            variant={variant}
            label={COPY.voice.label}
            description={COPY.voice.description}
            control={<Switch checked pending />}
          />
        </StateCell>
        <StateCell
          label="Saved toast"
          align="stretch"
          note="Flip the switch to save and see the toast."
        >
          <SaveAndToastRow variant={variant} />
        </StateCell>
        <StateCell
          label="Sub-row open"
          align="stretch"
          note="Shown only while the parent is on. Turn Voice input off to hide it."
        >
          <VoiceInputRow variant={variant} initialOn />
        </StateCell>
        <StateCell label="Error" align="stretch" note="What happened, and what to do next.">
          <ConnectedAppsRow
            variant={variant}
            error="Couldn't save your change, so it was undone. Try again."
          />
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <SettingRowGroup>
            <SettingRowSkeleton variant={variant} />
            <SettingRowSkeleton variant={variant} controlWidth="auto" />
            <SettingRowSkeleton variant={variant} controlWidth="select" description={false} />
          </SettingRowGroup>
        </StateCell>
        <StateCell label="Long text" align="stretch" note="Labels wrap. They never truncate.">
          <SettingRowGroup>
            <SettingRow
              variant={variant}
              label="Let Codex chats switch to another provider when the Codex plan runs out mid-session"
              description="When on, a chat that hits its Codex usage limit continues on OpenGeni credits or AI Gateway instead of waiting for the limit to reset. Compaction works better when this is off."
              control={<Switch />}
            />
            <FastCodeSearchRow variant={variant} />
          </SettingRowGroup>
        </StateCell>
        <StateCell
          label="Mobile 390"
          span="full"
          align="stretch"
          width="mobile"
          note="Below 640px, selects and segmented controls move under the text and fill the row. Switches stay on the right."
        >
          <SessionDefaults variant={variant} />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "One setting per row, with exactly one control",
          "Switches, segmented controls and selects in one right-hand column, so every control lines up",
          "A sub-row for a follow-up choice that only matters while the parent is on (Transcription provider under Voice input)",
          "An unavailable setting: disable the control, give the reason, and link to the fix (Connect AI Gateway)",
        ]}
        avoid={[
          "Two controls in one row: move the second into a sub-row",
          "Resources you manage, like accounts or keys: use a list row that opens a detail sheet",
          "Forms with a Save button: use form fields and checkboxes instead of switches",
          "Nesting deeper than one sub-row",
        ]}
      />
    </KitSection>
  );
}
