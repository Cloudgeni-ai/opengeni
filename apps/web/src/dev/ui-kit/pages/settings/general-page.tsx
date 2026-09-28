import { useState, type ReactNode } from "react";
import { ChevronDownIcon, PauseIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { CopyField } from "@/components/ui/copy-field";
import { DestructiveConfirm, type ConfirmDependency } from "@/components/ui/destructive-confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, FieldStack, TextInput, useField } from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { HelpLink } from "@/components/ui/inline-help";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { SecretInput } from "@/components/ui/secret-field";
import {
  SettingRow,
  SettingRowLink,
  SettingRowSkeleton,
  type SettingRowControlWidth,
} from "@/components/ui/setting-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { TimeField } from "@/components/ui/cadence-picker";
import { cn } from "@/lib/utils";

import {
  KIT_NOW,
  currentWorkspace,
  organization,
  sessionDefaults,
  workspaces,
} from "../../fixtures";
import { useKitNavigate, useKitView } from "../../view";
import { RowSelect } from "./controls";
import { ADMIN_ONLY_REASON, wait } from "./data";
import { useSettingsPicks } from "./picks";
import { SettingsFrame } from "./settings-frame";
import {
  AdminOnly,
  FORM_PAGE_IN_SETTINGS,
  OpenedPage,
  RowValue,
  addMinutes,
  pauseUntilPhrase,
  timeInSentence,
  useFrameBase,
  usePauseActions,
} from "./shared";
import { useSettingsPreview } from "./state";

/* ----------------------------------------------------------------------------
   Shared bits.
   -------------------------------------------------------------------------- */

/** Buttons stay on the right in "control right"; elsewhere they follow the row's layout. */
function useButtonWidth(): SettingRowControlWidth {
  const picks = useSettingsPicks();
  return picks.settingRow === "control-right" ? "compact" : "auto";
}

/** A switch that saves on change: spinner in the thumb, then a toast. */
function useSavedSwitch(initial: boolean, messages: { on: string; off: string }) {
  const [checked, setChecked] = useState(initial);
  const [pending, setPending] = useState(false);
  const onCheckedChange = async (next: boolean) => {
    setChecked(next);
    setPending(true);
    await wait(600);
    setPending(false);
    toast(next ? messages.on : messages.off);
  };
  return { checked, pending, onCheckedChange: (next: boolean) => void onCheckedChange(next) };
}

function SavedSwitch({
  state,
  disabledReason,
}: {
  state: ReturnType<typeof useSavedSwitch>;
  disabledReason?: ReactNode;
}) {
  const picks = useSettingsPicks();
  const { canManage } = useSettingsPreview();
  const reason = canManage ? disabledReason : ADMIN_ONLY_REASON;
  return (
    <Switch
      variant={picks.switchVariant}
      showStateText={picks.switchStateText}
      checked={state.checked}
      pending={state.pending}
      onCheckedChange={state.onCheckedChange}
      disabled={Boolean(reason)}
      disabledReason={reason}
    />
  );
}

/* ----------------------------------------------------------------------------
   Workspace: name, type, ID.
   -------------------------------------------------------------------------- */

const NAME_MAX = 48;

function nameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Name the workspace.";
  if (trimmed.length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer.`;
  const taken = workspaces.find(
    (workspace) =>
      workspace.id !== currentWorkspace.id &&
      workspace.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (taken) return `${organization.name} already has a workspace called ${taken.name}.`;
  return undefined;
}

function RenameFields({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <FieldStack>
      <Field
        label="Name"
        error={error}
        hint="Shown in the workspace switcher, invitations and Slack."
        aside={`${value.trim().length}/${NAME_MAX}`}
      >
        <TextInput
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. Design preview"
          suppressAutofill
        />
      </Field>
    </FieldStack>
  );
}

function useRenameForm(onDone: () => void) {
  const { workspaceName, setWorkspaceName } = useSettingsPreview();
  const [value, setValue] = useState(workspaceName);
  const [error, setError] = useState<string>();
  const reset = () => {
    setValue(workspaceName);
    setError(undefined);
  };
  const submit = async () => {
    const problem = nameError(value);
    if (problem) {
      setError(problem);
      return false;
    }
    const next = value.trim();
    if (next === workspaceName) return true;
    await wait(700);
    const before = workspaceName;
    setWorkspaceName(next);
    toast(`Renamed to ${next}`, {
      action: { label: "Undo", onClick: () => setWorkspaceName(before) },
    });
    return true;
  };
  return {
    fields: (
      <RenameFields
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(undefined);
        }}
        error={error}
      />
    ),
    reset,
    submit,
    onDone,
  };
}

function RenameDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useRenameForm(() => onOpenChange(false));
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) form.reset();
        onOpenChange(next);
      }}
      size="sm"
      title="Rename workspace"
      description="Everyone with access sees the new name."
      submitLabel="Save name"
      pendingLabel="Saving…"
      onSubmit={form.submit}
    >
      {form.fields}
    </FormDialog>
  );
}

/** The ID under its label, like Name and Type: shown in full when it fits. */
function WorkspaceIdValue() {
  return (
    <span className="mt-0.5 flex min-w-0">
      <CopyField value={currentWorkspace.id} label="workspace ID" truncate="middle" />
    </span>
  );
}

function WorkspaceSection() {
  const { workspaceName } = useSettingsPreview();
  const picks = useSettingsPicks();
  const view = useKitView();
  const kitNavigate = useKitNavigate(view);
  const buttonWidth = useButtonWidth();
  const [renaming, setRenaming] = useState(false);
  return (
    <Section title="Workspace">
      <SettingRow
        variant={picks.settingRow}
        label="Name"
        description={<RowValue>{workspaceName}</RowValue>}
        controlWidth={buttonWidth}
        control={
          <AdminOnly>
            <Button type="button" variant="outline" size="sm" onClick={() => setRenaming(true)}>
              <PencilIcon aria-hidden="true" />
              Rename
            </Button>
          </AdminOnly>
        }
      />
      {/* One field: a small centered dialog, not a page. */}
      <RenameDialog open={renaming} onOpenChange={setRenaming} />
      <SettingRow
        variant={picks.settingRow}
        label="Type"
        description={
          <RowValue>
            Shared ·{" "}
            <HelpLink onClick={() => kitNavigate({ section: "page-org-people" })}>
              {organization.name}
            </HelpLink>
          </RowValue>
        }
      />
      <SettingRow
        variant={picks.settingRow}
        label="Workspace ID"
        description={<WorkspaceIdValue />}
      />
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   Agent activity (question 7).
   -------------------------------------------------------------------------- */

const RESUME_DAYS = [
  { value: "0", label: "Today", offset: 0 },
  { value: "1", label: "Tomorrow", offset: 1 },
  { value: "2", label: "Mon 28 Sep", offset: 2 },
  { value: "3", label: "Tue 29 Sep", offset: 3 },
  { value: "4", label: "Wed 30 Sep", offset: 4 },
];

/** Oslo wall clock to UTC for the kit's late-September dates (CEST, UTC+2). */
function osloToIso(dayOffset: number, time: string): string {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  const date = new Date(Date.UTC(2026, 8, 26 + dayOffset, hours - 2, minutes));
  return date.toISOString();
}

type PauseChoice = "30" | "60" | "morning" | "manual" | "custom";

/**
 * "Pause agent work": a short list of until-when choices, then Cancel and
 * Pause. "Pick a time" reveals the day and time. No menu button.
 */
function PauseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { pauseFor } = usePauseActions();
  const [choice, setChoice] = useState<PauseChoice>("30");
  const [day, setDay] = useState("1");
  const [time, setTime] = useState("08:00");
  const [error, setError] = useState<string>();
  const offset = RESUME_DAYS.find((each) => each.value === day)?.offset ?? 0;
  const picked = osloToIso(offset, time);
  const morning = osloToIso(1, "08:00");
  const until: Record<Exclude<PauseChoice, "manual">, string> = {
    "30": addMinutes(30),
    "60": addMinutes(60),
    morning,
    custom: picked,
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setChoice("30");
          setDay("1");
          setTime("08:00");
          setError(undefined);
        }
        onOpenChange(next);
      }}
      size="sm"
      title="Pause agent work"
      description="New sessions and scheduled runs wait until agent work resumes, and running work stops after its current step."
      submitLabel="Pause"
      pendingLabel="Pausing…"
      onSubmit={async () => {
        if (choice === "custom" && new Date(picked).getTime() <= KIT_NOW.getTime() + 60_000) {
          setError("Pick a time after 13:48 today.");
          return false;
        }
        await wait(500);
        if (choice === "manual") pauseFor(null, "Until someone resumes it");
        else pauseFor(until[choice], `Resumes ${timeInSentence(until[choice])}`);
        return true;
      }}
    >
      <div className="grid min-w-0 gap-3">
        <ChoiceCards
          variant="list"
          aria-label="Pause until"
          value={choice}
          onValueChange={(next) => {
            setChoice(next as PauseChoice);
            setError(undefined);
          }}
        >
          <ChoiceCard value="30" title="For 30 minutes" meta="until 14:18" />
          <ChoiceCard value="60" title="For 1 hour" meta="until 14:48" />
          <ChoiceCard value="morning" title="Until tomorrow morning" meta="Sun 27 Sep, 08:00" />
          <ChoiceCard value="manual" title="Until I resume" />
          <ChoiceCard value="custom" title="Pick a time" />
        </ChoiceCards>
        {choice === "custom" ? (
          <div className="min-w-0 pl-6">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <Field label="Resume on">
                <DaySelect
                  value={day}
                  onChange={(next) => {
                    setDay(next);
                    setError(undefined);
                  }}
                />
              </Field>
              <Field label="At">
                <TimeControl
                  value={time}
                  invalid={Boolean(error)}
                  onChange={(next) => {
                    setTime(next);
                    setError(undefined);
                  }}
                />
              </Field>
            </div>
            <p
              role={error ? "alert" : undefined}
              className={cn("mt-1.5 text-xs leading-4.5", error ? "text-danger" : "text-fg-muted")}
            >
              {error ?? `Agent work resumes ${timeInSentence(picked)}, Oslo time.`}
            </p>
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}

function TimeControl({
  value,
  invalid,
  onChange,
}: {
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const field = useField();
  return (
    <TimeField
      id={field?.controlId}
      value={value}
      label="Resume at"
      onChange={onChange}
      className={cn("h-9 pointer-coarse:h-11", invalid && "border-danger")}
    />
  );
}

function DaySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const picks = useSettingsPicks();
  return (
    <SelectMenu
      variant={picks.select === "combobox" ? "menu" : picks.select}
      options={RESUME_DAYS.map(({ value: option, label }) => ({ value: option, label }))}
      value={value}
      onValueChange={onChange}
      className="w-full"
    />
  );
}

/** A plain secondary Pause button; the dialog asks until when. */
function PauseButton({ onClick }: { onClick: () => void }) {
  return (
    <AdminOnly>
      <Button type="button" variant="outline" size="sm" onClick={onClick}>
        <PauseIcon aria-hidden="true" />
        Pause
      </Button>
    </AdminOnly>
  );
}

function StatusLabel({ paused }: { paused: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot tone={paused ? "neutral" : "success"} size="sm" />
      {paused ? "Paused" : "Running"}
    </span>
  );
}

function AgentActivitySection() {
  const { pause, setPause, questions, canManage } = useSettingsPreview();
  const picks = useSettingsPicks();
  const buttonWidth = useButtonWidth();
  const { resume } = usePauseActions();
  const [customOpen, setCustomOpen] = useState(false);

  if (questions.q7 === "no") {
    // Today's control: a one-click pause with a timer behind the chevron, only visible here.
    return (
      <Section title="Agent activity">
        <SettingRow
          variant={picks.settingRow}
          label="Workspace runtime"
          description={
            pause.paused
              ? `Paused ${pauseUntilPhrase(pause)}.`
              : "Agents can start and continue work in this workspace."
          }
          controlWidth={buttonWidth}
          control={
            pause.paused ? (
              <AdminOnly>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPause({ paused: false, until: null })}
                >
                  <PlayIcon aria-hidden="true" />
                  Resume workspace
                </Button>
              </AdminOnly>
            ) : (
              <div className="inline-flex">
                <AdminOnly>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-r-none"
                    onClick={() => setPause({ paused: true, until: null })}
                  >
                    <PauseIcon aria-hidden="true" />
                    Pause workspace
                  </Button>
                </AdminOnly>
                <AdminOnly>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Pause timer"
                    className="rounded-l-none border-l-0 px-2"
                    onClick={() => setCustomOpen(true)}
                  >
                    <ChevronDownIcon aria-hidden="true" />
                  </Button>
                </AdminOnly>
              </div>
            )
          }
        />
        <PauseDialog open={customOpen} onOpenChange={setCustomOpen} />
      </Section>
    );
  }

  return (
    <Section title="Agent activity">
      <SettingRow
        variant={picks.settingRow}
        label={<StatusLabel paused={pause.paused} />}
        description={
          pause.paused
            ? `New sessions and scheduled runs wait ${pauseUntilPhrase(pause)}.`
            : "Agents can start new sessions and scheduled runs."
        }
        controlWidth={buttonWidth}
        control={
          pause.paused ? (
            <div className="flex items-center justify-end gap-2">
              {canManage ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setCustomOpen(true)}>
                  Change
                </Button>
              ) : null}
              <AdminOnly>
                <Button type="button" variant="outline" size="sm" onClick={resume}>
                  <PlayIcon aria-hidden="true" />
                  Resume
                </Button>
              </AdminOnly>
            </div>
          ) : (
            <PauseButton onClick={() => setCustomOpen(true)} />
          )
        }
      />
      <PauseDialog open={customOpen} onOpenChange={setCustomOpen} />
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   New session defaults (question 8).
   -------------------------------------------------------------------------- */

const TRANSCRIPTION_OPTIONS = [
  {
    value: "automatic",
    label: "Automatic",
    description: "Uses the best provider you've connected.",
    meta: "Codex plan",
  },
  {
    value: "codex",
    label: "Codex plan",
    description: "Transcribes with the workspace's ChatGPT Pro account.",
    meta: "ops@acme.dev",
  },
];

const VIDEO_PAYER_OPTIONS = [
  {
    value: "gateway",
    label: "AI Gateway",
    description: "Billed to this workspace's Vercel account.",
    meta: "•••• 9c1e",
  },
  {
    value: "credits",
    label: "OpenGeni credits",
    disabled: true,
    disabledReason: "No credit balance. An owner can buy credits.",
  },
];

/** Connect AI Gateway as a page of its own, in place of General. */
function ConnectGatewayPage({ onClose }: { onClose: () => void }) {
  const { setGatewayConnected, workspaceName } = useSettingsPreview();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  return (
    <OpenedPage>
      <FormPage
        back={{ label: "General", onClick: onClose }}
        className={FORM_PAGE_IN_SETTINGS}
        title="Connect AI Gateway"
        description={`Pay for video generation and other models in ${workspaceName} with your Vercel AI Gateway key.`}
        submitLabel="Connect"
        pendingLabel="Connecting…"
        onCancel={onClose}
        onSubmit={async () => {
          const trimmed = key.trim();
          if (!trimmed) {
            setError("Paste the API key from your Vercel dashboard.");
            return false;
          }
          if (!trimmed.startsWith("vck_") || trimmed.length < 16) {
            setError("That doesn't look like an AI Gateway key. They start with vck_.");
            return false;
          }
          await wait(900);
          setGatewayConnected(true);
          toast("Connected AI Gateway", { description: "Video generation can be turned on now." });
          return true;
        }}
        onSubmitted={onClose}
      >
        <FieldStack>
          <Field
            label="API key"
            error={error}
            hint="Vercel dashboard > AI Gateway > API keys. It's stored encrypted and never shown again."
          >
            <SecretInput
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setError(undefined);
              }}
              placeholder="vck_…"
            />
          </Field>
        </FieldStack>
      </FormPage>
    </OpenedPage>
  );
}

function SessionDefaultsSection({ onConnectGateway }: { onConnectGateway: () => void }) {
  const { questions, gatewayConnected, canManage } = useSettingsPreview();
  const picks = useSettingsPicks();
  const voice = useSavedSwitch(sessionDefaults.voiceInput, {
    on: "Voice input is on for new sessions",
    off: "Voice input is off for new sessions",
  });
  const video = useSavedSwitch(sessionDefaults.videoGeneration, {
    on: "Video generation is on for new sessions",
    off: "Video generation is off for new sessions",
  });
  const apps = useSavedSwitch(sessionDefaults.useConnectedAppsAutomatically, {
    on: "New sessions start with your connected apps",
    off: "New sessions start without connected apps",
  });
  const providers = useSavedSwitch(false, {
    on: "Codex chats can switch providers",
    off: "Codex chats stay on Codex models",
  });
  const [provider, setProvider] = useState<string>(sessionDefaults.transcriptionProvider);
  const [payer, setPayer] = useState("gateway");
  const [codeSearch, setCodeSearch] = useState<string>(sessionDefaults.fastCodeSearch);
  const selectVariant = picks.select === "combobox" ? "menu" : picks.select;
  const oneControl = questions.q8 === "yes";

  const saved = (message: string) => () => toast(message);
  const providerSelect = (className?: string) => (
    <RowSelect
      variant={selectVariant}
      options={TRANSCRIPTION_OPTIONS}
      value={provider}
      onValueChange={(next) => {
        setProvider(next);
        saved("Transcription provider saved")();
      }}
      disabled={!canManage || (!oneControl && !voice.checked)}
      className={className}
    />
  );

  const gatewayHint = gatewayConnected ? null : (
    <AdminOnly>
      <SettingRowLink onClick={onConnectGateway}>Connect AI Gateway</SettingRowLink>
    </AdminOnly>
  );

  const codeSearchControl = (
    <SegmentedControl
      size="sm"
      variant={picks.segmented}
      value={codeSearch}
      onValueChange={(next) => {
        setCodeSearch(next);
        toast("Fast code search saved");
      }}
      options={[
        { value: "default", label: "Default" },
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ].map((option) =>
        canManage ? option : { ...option, disabled: true, disabledReason: ADMIN_ONLY_REASON },
      )}
    />
  );

  return (
    <Section
      title="New session defaults"
      description="Applied when someone starts a new session in this workspace."
    >
      {oneControl ? (
        <SettingRow
          variant={picks.settingRow}
          label="Voice input"
          description="Record a short message and add its transcript to the draft."
          control={<SavedSwitch state={voice} />}
        >
          {voice.checked && TRANSCRIPTION_OPTIONS.length > 1 ? (
            <SettingRow
              variant={picks.settingRow}
              label="Transcription provider"
              description="Who transcribes, and which plan pays for it."
              controlWidth="select"
              control={providerSelect()}
            />
          ) : null}
        </SettingRow>
      ) : (
        <SettingRow
          variant={picks.settingRow}
          label="Voice input"
          description="Record a short message and add its transcript to the draft."
          controlWidth="auto"
          control={
            <div className="flex min-w-0 items-center gap-3">
              {providerSelect("w-52")}
              <SavedSwitch state={voice} />
            </div>
          }
        />
      )}

      {oneControl ? (
        <SettingRow
          variant={picks.settingRow}
          label="Video generation"
          description={
            gatewayConnected
              ? "Let agents make short videos. Paid by the account you choose."
              : "Let agents make short videos. Needs an AI Gateway key to pay for them."
          }
          hint={gatewayHint}
          control={
            <SavedSwitch
              state={video}
              disabledReason={gatewayConnected ? undefined : "Connect AI Gateway to turn this on."}
            />
          }
        >
          {gatewayConnected && video.checked ? (
            <SettingRow
              variant={picks.settingRow}
              label="Paid by"
              description="Every video shows who paid for it."
              controlWidth="select"
              control={
                <RowSelect
                  variant={selectVariant}
                  options={VIDEO_PAYER_OPTIONS}
                  value={payer}
                  onValueChange={(next) => {
                    setPayer(next);
                    toast("Video payment source saved");
                  }}
                  disabled={!canManage}
                />
              }
            />
          ) : null}
        </SettingRow>
      ) : (
        <SettingRow
          variant={picks.settingRow}
          label="Video generation"
          description={
            gatewayConnected
              ? "Let agents make short videos."
              : "Connect a workspace Vercel AI Gateway key first."
          }
          controlWidth="auto"
          control={
            <div className="flex min-w-0 items-center gap-3">
              <RowSelect
                variant={selectVariant}
                options={VIDEO_PAYER_OPTIONS}
                value={gatewayConnected ? payer : null}
                placeholder="Your Gateway"
                onValueChange={setPayer}
                disabled={!gatewayConnected || !canManage}
                className="w-52"
              />
              <SavedSwitch
                state={video}
                disabledReason={
                  gatewayConnected ? undefined : "Connect AI Gateway to turn this on."
                }
              />
            </div>
          }
        />
      )}

      <SettingRow
        variant={picks.settingRow}
        label="Fast code search"
        description="Index repositories so agents find code faster. Default follows Acme Robotics."
        controlWidth="auto"
        control={codeSearchControl}
      />

      <SettingRow
        variant={picks.settingRow}
        label="Use connected apps automatically"
        description="New sessions start with your connected apps. People can still turn them off in a session."
        control={<SavedSwitch state={apps} />}
      />

      {oneControl ? null : (
        <SettingRow
          variant={picks.settingRow}
          label="Allow other providers (Codex only)"
          description="Lets a Codex chat switch to other providers mid-session. Off keeps better context compaction."
          control={<SavedSwitch state={providers} />}
        />
      )}
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   Delete workspace (question 6).
   -------------------------------------------------------------------------- */

const RUNNING_WORK: ConfirmDependency[] = [
  {
    id: "chat-q3",
    kind: "chat",
    kindLabel: "Chat",
    name: "Q3 revenue review",
    detail: "Running for 12 min · Maria Chen",
    href: "#chat-q3-revenue",
  },
  {
    id: "sandbox-residency",
    kind: "environment",
    kindLabel: "Live sandbox",
    name: "Data residency audit",
    detail: "Stops 10 min after the chat goes idle",
    href: "#chat-data-residency",
  },
];

function DeleteWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspaceName, pause, members, keys, setDeleted } = useSettingsPreview();
  const others = members.filter((member) => !member.isYou).map((member) => member.name);
  const liveKeys = keys.filter((key) => key.status === "active").length;
  if (!pause.paused) {
    return (
      <DestructiveConfirm
        open={open}
        onOpenChange={onOpenChange}
        variant="blocked"
        title={`${workspaceName} has work running`}
        description="Pause agent work and let these finish, then delete the workspace."
        dependencies={RUNNING_WORK}
        dependenciesTitle="Still running"
      />
    );
  }
  return (
    <DestructiveConfirm
      open={open}
      onOpenChange={onOpenChange}
      variant="type-to-confirm"
      title={`Delete ${workspaceName}?`}
      consequences={[
        `Deletes every session, schedule, variable set, knowledge entry and file in ${workspaceName}.`,
        `Revokes its ${liveKeys} active API ${liveKeys === 1 ? "key" : "keys"}. Scripts using them stop working.`,
        others.length > 0
          ? `${others.join(" and ")} lose access. Their other workspaces aren't affected.`
          : "Nobody else has access.",
        "This can't be undone.",
      ]}
      confirmText={workspaceName}
      confirmPlaceholder="Workspace name"
      confirmLabel="Delete workspace"
      onConfirm={async () => {
        await wait(1200);
        setDeleted(true);
        toast(`Deleted ${workspaceName}`);
      }}
    />
  );
}

function DeleteWorkspaceSection() {
  const { workspaceName } = useSettingsPreview();
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Delete workspace"
      description={`Deletes ${workspaceName} for everyone, with its sessions, schedules, variable sets, knowledge and files.`}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          className="text-danger hover:text-danger"
        >
          <Trash2Icon aria-hidden="true" />
          Delete
        </Button>
      }
    >
      <DeleteWorkspaceDialog open={open} onOpenChange={setOpen} />
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   Pages.
   -------------------------------------------------------------------------- */

function GeneralSkeleton() {
  const picks = useSettingsPicks();
  return (
    <div role="status" aria-label="Loading settings">
      <SectionStack variant={picks.section}>
        {/* Same rows as the loaded page: name, type and ID; the activity row;
            voice, video, code search and connected apps. */}
        <Section title="Workspace">
          <SettingRowSkeleton variant={picks.settingRow} />
          <SettingRowSkeleton variant={picks.settingRow} />
          <SettingRowSkeleton variant={picks.settingRow} />
        </Section>
        <Section title="Agent activity">
          <SettingRowSkeleton variant={picks.settingRow} />
        </Section>
        <Section title="New session defaults">
          <SettingRowSkeleton variant={picks.settingRow} />
          <SettingRowSkeleton variant={picks.settingRow} />
          <SettingRowSkeleton variant={picks.settingRow} controlWidth="auto" />
          <SettingRowSkeleton variant={picks.settingRow} />
        </Section>
      </SectionStack>
    </div>
  );
}

function DeletedState() {
  const { workspaceName, setDeleted, setWorkspaceName } = useSettingsPreview();
  return (
    <EmptyState
      variant="page"
      icon={<Trash2Icon />}
      title={`${workspaceName} was deleted`}
      description="Everyone who had access has been moved to their Personal workspace."
      action={
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDeleted(false);
            setWorkspaceName(currentWorkspace.name);
          }}
        >
          Start the preview over
        </Button>
      }
    />
  );
}

export function GeneralPage() {
  const base = useFrameBase();
  const { data, questions, deleted, canManage } = useSettingsPreview();
  const picks = useSettingsPicks();
  const [connecting, setConnecting] = useState(false);
  let body: ReactNode;
  if (deleted) body = <DeletedState />;
  else if (data.general === "loading") body = <GeneralSkeleton />;
  else
    body = (
      <SectionStack variant={picks.section}>
        <WorkspaceSection />
        <AgentActivitySection />
        <SessionDefaultsSection onConnectGateway={() => setConnecting(true)} />
        {questions.q6 === "yes" && canManage ? <DeleteWorkspaceSection /> : null}
      </SectionStack>
    );
  return (
    <SettingsFrame
      {...base}
      takeover={
        connecting ? <ConnectGatewayPage onClose={() => setConnecting(false)} /> : undefined
      }
      takeoverKey={connecting ? "connect-gateway" : undefined}
    >
      {body}
    </SettingsFrame>
  );
}

/** Question 6 answered No: a page of its own for one button. */
export function DangerZonePage() {
  const base = useFrameBase();
  const { deleted, canManage, workspaceName } = useSettingsPreview();
  const picks = useSettingsPicks();
  const [open, setOpen] = useState(false);
  return (
    <SettingsFrame {...base}>
      {deleted ? (
        <DeletedState />
      ) : (
        <SectionStack variant={picks.section}>
          <Section title="Danger zone" description="Irreversible workspace actions.">
            <SettingRow
              variant={picks.settingRow}
              label="Delete workspace"
              description={`Removes ${workspaceName}, its sessions, environments and API keys.`}
              controlWidth={picks.settingRow === "control-right" ? "compact" : "auto"}
              control={
                <AdminOnly>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(true)}
                    className="text-danger hover:text-danger"
                  >
                    Delete workspace
                  </Button>
                </AdminOnly>
              }
            />
          </Section>
          {canManage ? <DeleteWorkspaceDialog open={open} onOpenChange={setOpen} /> : null}
        </SectionStack>
      )}
    </SettingsFrame>
  );
}
