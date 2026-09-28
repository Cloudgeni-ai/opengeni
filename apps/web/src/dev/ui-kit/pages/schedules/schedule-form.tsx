/**
 * The schedule form: What (a composer-style field with chips) -> When (the
 * cadence sentence and next runs) -> an optional Name -> a closed Advanced
 * section. One component for create and edit, always a full page
 * (/schedules/new, /schedules/:id/edit) with a back link and a sticky footer.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import {
  ContainerIcon,
  GitBranchIcon,
  LaptopIcon,
  PlusIcon,
  ServerIcon,
  VariableIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CadencePicker,
  validateCadence,
  type CadenceFrequency,
} from "@/components/ui/cadence-picker";
import { Disclosure } from "@/components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldStack,
  TextInput,
  useField,
  useFieldControlProps,
} from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { InlineHelp } from "@/components/ui/inline-help";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl, type SegmentedControlProps } from "@/components/ui/segmented-control";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { SettingRow } from "@/components/ui/setting-row";
import { cn } from "@/lib/utils";

import {
  KIT_NOW,
  KIT_TIME_ZONE,
  learningModes,
  sandboxEnvironments,
  timeZones,
  variableSets,
} from "../../fixtures";
import {
  MACHINE_NAME,
  MODEL_CHOICES,
  NONE,
  REPOSITORY_OPTIONS,
  TOOL_OPTIONS,
  advancedSummary,
  deriveName,
  toolById,
  type EachRun,
  type IfStillRunning,
  type LearningChoice,
  type LearningDraft,
  type ScheduleDraft,
  type SchedulesQuestions,
  type WhereItRuns,
} from "./model";
import { ToolLogo } from "./tool-mark";
import type { SchedulePicks } from "./use-picks";

/* ----------------------------------------------------------------------------
   Composer chips. The chips are real SelectMenus styled as pills; the "+"
   menu adds tools.
   -------------------------------------------------------------------------- */

/**
 * 28px pills (32px on touch screens), with a 44px touch target drawn by a
 * transparent pseudo-element so the row stays compact.
 */
const TOUCH_TARGET =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:content-['']";
const CHIP = cn(
  "h-7 w-auto max-w-full shrink-0 gap-1 rounded-full pr-2 pl-2.5 text-xs pointer-coarse:h-8 [&>svg]:size-3.5",
  TOUCH_TARGET,
);
const CHIP_EMPTY = "border-dashed text-fg-muted hover:text-fg";

const MODEL_OPTIONS: SelectOption[] = MODEL_CHOICES.map((model) => ({
  value: model.id,
  // "Default · GPT-6 Sol · Codex plan" keeps the payer visible on a phone.
  label: model.id === "default" ? "Default" : model.label,
  meta: model.payer,
  description: model.description,
  disabled: !model.available,
  disabledReason: model.unavailableReason,
}));

const REPOSITORY_SELECT: SelectOption[] = [
  ...REPOSITORY_OPTIONS.map((repository) => ({
    value: repository,
    label: repository,
    leading: <GitBranchIcon className="size-3.5 text-fg-subtle" />,
  })),
  { value: NONE, label: "No repository", group: " " },
];

const VARIABLE_SET_SELECT: SelectOption[] = [
  ...variableSets.map((set) => ({
    value: set.id,
    label: set.name,
    meta: set.variablesLabel,
    description: set.description,
    leading: <VariableIcon className="size-3.5 text-fg-subtle" />,
  })),
  { value: NONE, label: "No variable set", group: " " },
];

const ENVIRONMENT_SELECT: SelectOption[] = [
  ...sandboxEnvironments.map((environment) => ({
    value: environment.id,
    label: environment.name,
    meta: environment.isDefault ? "Default" : undefined,
    description: environment.description,
    leading: <ContainerIcon className="size-3.5 text-fg-subtle" />,
  })),
  { value: NONE, label: "No environment", group: " " },
];

function ChipSelect({
  label,
  placeholder,
  options,
  value,
  onChange,
  variant,
  searchPlaceholder,
  align,
  showMeta = false,
  className,
}: {
  label: string;
  placeholder: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  variant: SchedulePicks["chipSelect"];
  searchPlaceholder?: string;
  align?: "start" | "end";
  /** The model chip keeps its payer; context chips show just the name. */
  showMeta?: boolean;
  className?: string;
}) {
  const id = useId();
  const empty = value === NONE;
  return (
    <SelectMenu
      id={id}
      aria-label={label}
      aria-describedby=""
      invalid={false}
      variant={variant}
      options={options}
      value={empty ? null : value}
      onValueChange={onChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      align={align}
      showMetaInTrigger={showMeta}
      className={cn(CHIP, empty && CHIP_EMPTY, className)}
      menuClassName="w-80"
    />
  );
}

function AddToolsMenu({
  tools,
  onToggle,
}: {
  tools: string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add tools"
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface text-fg-muted transition-colors duration-[120ms] hover:border-border-strong hover:text-fg data-[state=open]:border-border-strong data-[state=open]:text-fg pointer-coarse:size-8",
            TOUCH_TARGET,
            "pointer-coarse:after:-inset-x-1.5",
          )}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 rounded-[16px] p-1.5">
        <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-subtle">
          Tools this schedule can use
        </DropdownMenuLabel>
        {TOOL_OPTIONS.map((tool) => (
          <DropdownMenuCheckboxItem
            key={tool.id}
            checked={tools.includes(tool.id)}
            disabled={Boolean(tool.unavailableReason)}
            onCheckedChange={(checked) => onToggle(tool.id, checked === true)}
            onSelect={(event) => event.preventDefault()}
            className="min-h-9 rounded-[8px] pointer-coarse:min-h-11"
          >
            <ToolLogo toolId={tool.id} size="sm" />
            <span className="min-w-0">
              <span className="block truncate">{tool.name}</span>
              {tool.unavailableReason ? (
                <span className="block text-xs leading-4.5 text-fg-muted">
                  {tool.unavailableReason}
                </span>
              ) : null}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolChip({ toolId, onRemove }: { toolId: string; onRemove: () => void }) {
  const name = toolById(toolId)?.name ?? toolId;
  return (
    <span className="inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface pr-0.5 pl-1 text-xs text-fg pointer-coarse:h-8">
      <ToolLogo toolId={toolId} size="sm" className="size-5" />
      <span className="truncate">{name}</span>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg",
          TOUCH_TARGET,
          "pointer-coarse:after:-inset-2.5",
        )}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * The composer-style instructions field, shaped like the chat composer: what
 * the runs work with on top (repository, variable set, environment, tools),
 * the instructions, then "+" for tools and the model with its payer. The
 * textarea takes the enclosing Field's label, hint and error.
 */
function ComposerField({
  draft,
  update,
  picks,
  questions,
}: {
  draft: ScheduleDraft;
  update: (patch: Partial<ScheduleDraft>) => void;
  picks: SchedulePicks;
  questions: SchedulesQuestions;
}) {
  const fieldProps = useFieldControlProps();
  const invalid = Boolean(fieldProps["aria-invalid"]);
  const toggleTool = (id: string, on: boolean) =>
    update({ tools: on ? [...draft.tools, id] : draft.tools.filter((tool) => tool !== id) });
  const context = questions.q24Attachments || draft.tools.length > 0;
  return (
    <div
      className={cn(
        "min-w-0 rounded-[14px] border bg-surface transition-[border-color,box-shadow] duration-[120ms]",
        invalid
          ? "border-danger has-[textarea:focus]:ring-3 has-[textarea:focus]:ring-danger/15"
          : "border-border hover:border-border-strong has-[textarea:focus]:border-brand has-[textarea:focus]:ring-3 has-[textarea:focus]:ring-brand/15",
      )}
    >
      {context ? (
        <div
          role="group"
          aria-label="What the runs work with"
          className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2.5 pointer-coarse:gap-y-2"
        >
          {questions.q24Attachments ? (
            <>
              <ChipSelect
                label="Repository"
                placeholder="Repository"
                options={REPOSITORY_SELECT}
                value={draft.repository}
                onChange={(repository) => update({ repository })}
                variant={picks.chipSelect}
                searchPlaceholder="Search repositories"
              />
              <ChipSelect
                label="Variable set"
                placeholder="Variable set"
                options={VARIABLE_SET_SELECT}
                value={draft.variableSetId}
                onChange={(variableSetId) => update({ variableSetId })}
                variant={picks.chipSelect}
                searchPlaceholder="Search variable sets"
              />
              <ChipSelect
                label="Environment"
                placeholder="Environment"
                options={ENVIRONMENT_SELECT}
                value={draft.environmentId}
                onChange={(environmentId) => update({ environmentId })}
                variant={picks.chipSelect}
                searchPlaceholder="Search environments"
              />
            </>
          ) : null}
          {draft.tools.map((toolId) => (
            <ToolChip key={toolId} toolId={toolId} onRemove={() => toggleTool(toolId, false)} />
          ))}
        </div>
      ) : null}
      <textarea
        {...fieldProps}
        value={draft.instructions}
        onChange={(event) => update({ instructions: event.target.value })}
        rows={4}
        placeholder="e.g. Summarize yesterday's AWS spend and flag anything unusual"
        // The frame shows focus (border and glow); the global outline would draw a second ring.
        style={{ outline: "none" }}
        className={cn(
          "field-sizing-content block max-h-72 min-h-24 w-full min-w-0 resize-none bg-transparent px-4 pt-3 pb-2 text-sm leading-5 text-fg placeholder:text-fg-subtle pointer-coarse:text-base",
          !context && "rounded-t-[14px]",
        )}
      />
      <div className="flex min-w-0 items-center gap-2 px-3 pb-3">
        <AddToolsMenu tools={draft.tools} onToggle={toggleTool} />
        <ChipSelect
          label="Model"
          placeholder="Model"
          options={MODEL_OPTIONS}
          value={draft.modelId}
          onChange={(modelId) => update({ modelId })}
          variant={picks.chipSelect}
          searchPlaceholder="Search models"
          className="ml-auto shrink"
          align="end"
          showMeta
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Advanced.
   -------------------------------------------------------------------------- */

/** A segmented control named by the enclosing Field's label. */
function FieldSegmented<Value extends string>(
  props: Omit<SegmentedControlProps<Value>, "aria-labelledby">,
) {
  const field = useField();
  return (
    <SegmentedControl<Value>
      {...props}
      className={cn("self-start", props.className)}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
    />
  );
}

const EACH_RUN_HINT: Record<EachRun, string> = {
  new_chat: "Every run starts a fresh chat, named after the schedule.",
  ongoing_chat: "Every run posts into the same chat, so the agent sees what it found last time.",
};

const IF_STILL_RUNNING_HINT: Record<IfStillRunning, string> = {
  queue: "The new run waits, then starts when the previous one finishes.",
  skip: "The new run is skipped. The next one on the schedule runs as normal.",
};

function learningOptions(defaultMode: string): SelectOption<LearningChoice>[] {
  return [
    {
      value: "default",
      label: "Default",
      meta: defaultMode,
      description: "Follows the workspace's Knowledge settings.",
    },
    ...learningModes.map((mode) => ({ value: mode.id, label: mode.label })),
  ];
}

const LEARNING_ROWS: Array<{ key: keyof LearningDraft; label: string; workspace: string }> = [
  { key: "knowledge", label: "Knowledge", workspace: "Automatic" },
  { key: "instructions", label: "Workspace instructions", workspace: "Review first" },
  { key: "skills", label: "Skills", workspace: "Review first" },
];

function AdvancedFields({
  draft,
  update,
  picks,
  questions,
  canRunSchedules,
}: {
  draft: ScheduleDraft;
  update: (patch: Partial<ScheduleDraft>) => void;
  picks: SchedulePicks;
  questions: SchedulesQuestions;
  canRunSchedules: boolean;
}) {
  const learningLabelId = useId();
  const learningHintId = useId();
  const whereOptions: SelectOption<WhereItRuns>[] = [
    {
      value: "managed",
      label: "Managed sandbox",
      description: "A fresh cloud sandbox for each run.",
      leading: <ServerIcon className="size-4 text-fg-subtle" />,
      disabled: !canRunSchedules,
      disabledReason: "Not available on this OpenGeni server.",
    },
    {
      value: "machine",
      label: MACHINE_NAME,
      meta: "Connected machine",
      description: "Runs on your own computer, in its code folder.",
      leading: <LaptopIcon className="size-4 text-fg-subtle" />,
      disabled: !canRunSchedules,
      disabledReason: "No machine is connected to this workspace yet.",
    },
  ];
  const showIfStillRunning = draft.eachRun === "ongoing_chat" || !questions.q27OngoingOnly;
  return (
    <FieldStack>
      <Field label="Each run" hint={EACH_RUN_HINT[draft.eachRun]}>
        <FieldSegmented<EachRun>
          variant={picks.segmented}
          value={draft.eachRun}
          onValueChange={(eachRun) => update({ eachRun })}
          options={[
            { value: "new_chat", label: "New chat" },
            { value: "ongoing_chat", label: "One ongoing chat" },
          ]}
        />
      </Field>
      {showIfStillRunning ? (
        <Field
          label="If the previous run is still working"
          hint={IF_STILL_RUNNING_HINT[draft.ifStillRunning]}
        >
          <FieldSegmented<IfStillRunning>
            variant={picks.segmented}
            value={draft.ifStillRunning}
            onValueChange={(ifStillRunning) => update({ ifStillRunning })}
            options={[
              { value: "queue", label: "Queue this run" },
              { value: "skip", label: "Skip this run" },
            ]}
          />
        </Field>
      ) : null}
      <Field label="Where it runs">
        <SelectMenu<WhereItRuns>
          variant={picks.select}
          options={whereOptions}
          value={draft.whereItRuns}
          onValueChange={(whereItRuns) => update({ whereItRuns })}
          className="max-w-[360px]"
        />
      </Field>
      {draft.whereItRuns === "machine" ? (
        <InlineHelp icon className="-mt-4">
          Repositories, variable sets and environments aren't added on a connected machine. It uses
          its own checkout and settings.
        </InlineHelp>
      ) : null}
      <div role="group" aria-labelledby={learningLabelId} aria-describedby={learningHintId}>
        <p id={learningLabelId} className="text-sm font-medium text-fg">
          Agent learning
        </p>
        <p id={learningHintId} className="mt-1 text-xs leading-4.5 text-fg-muted">
          What the agent may save from these runs. Workspace default follows Knowledge settings.
        </p>
        <div className="mt-1 divide-y divide-border">
          {LEARNING_ROWS.map((row) => (
            <SettingRow
              key={row.key}
              variant={picks.settingRow}
              label={row.label}
              controlWidth="select"
              control={
                <SelectMenu<LearningChoice>
                  size="sm"
                  variant={picks.select}
                  aria-label={row.label}
                  options={learningOptions(row.workspace)}
                  value={draft.learning[row.key]}
                  onValueChange={(choice) =>
                    update({ learning: { ...draft.learning, [row.key]: choice } })
                  }
                />
              }
            />
          ))}
        </div>
      </div>
    </FieldStack>
  );
}

/* ----------------------------------------------------------------------------
   The form.
   -------------------------------------------------------------------------- */

interface FormErrors {
  instructions?: string;
  name?: string;
}

function validate(draft: ScheduleDraft): FormErrors {
  const errors: FormErrors = {};
  if (!draft.instructions.trim()) {
    errors.instructions = "Describe what the agent should do on each run.";
  }
  if (draft.name.trim().length > 80) errors.name = "Keep the name under 80 characters.";
  return errors;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ScheduleFormProps {
  mode: "create" | "edit";
  initial: ScheduleDraft;
  /** Shown under the title when editing. */
  editingName?: string;
  /** The back link: "Schedules", or the schedule's name when editing from its page. */
  backLabel: string;
  questions: SchedulesQuestions;
  picks: SchedulePicks;
  canRunSchedules: boolean;
  saveFails: boolean;
  onCancel: () => void;
  /** Called with the saved draft; close the form in `onDone`. */
  onSave: (draft: ScheduleDraft) => void;
  onDone: () => void;
  /** Saving started or finished. */
  onPendingChange?: (pending: boolean) => void;
  className?: string;
}

export function ScheduleForm({
  mode,
  initial,
  editingName,
  backLabel,
  questions,
  picks,
  canRunSchedules,
  saveFails,
  onCancel,
  onSave,
  onDone,
  onPendingChange,
  className,
}: ScheduleFormProps) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const update = (patch: Partial<ScheduleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    if (patch.instructions !== undefined && errors.instructions) {
      setErrors((current) => ({ ...current, instructions: undefined }));
    }
    if (patch.name !== undefined && errors.name) {
      setErrors((current) => ({ ...current, name: undefined }));
    }
  };
  const whenLabelId = useId();
  const frequencies = useMemo<CadenceFrequency[] | undefined>(
    () =>
      questions.q23WeekdayDefault
        ? undefined
        : ["hourly", "daily", "weekdays", "weekly", "interval", "once"],
    [questions.q23WeekdayDefault],
  );
  const derivedName = deriveName(draft.instructions);
  const create = mode === "create";

  const onSubmit = async () => {
    const next = validate(draft);
    const cadenceIssue = validateCadence(draft.cadence.rule, {
      timeZone: draft.cadence.timeZone,
      now: KIT_NOW,
    });
    setErrors(next);
    if (Object.keys(next).some((key) => next[key as keyof FormErrors]) || cadenceIssue) {
      return false;
    }
    await wait(700);
    if (saveFails) {
      throw new Error(
        create
          ? "Couldn't create the schedule. Check your connection and try again."
          : "Couldn't save your changes. Check your connection and try again.",
      );
    }
    onSave(draft);
    return true;
  };

  const fields: ReactNode = (
    <FieldStack>
      {canRunSchedules ? null : (
        <Notice
          tone="waiting"
          title="Schedules need a connected machine here"
          actionLayout="responsive"
          action={
            <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11">
              Connect a machine
            </Button>
          }
        >
          This OpenGeni server doesn't run managed sandboxes, and no machine is connected to Design
          preview yet.
        </Notice>
      )}
      <Field
        label="What should the agent do?"
        error={errors.instructions}
        hint="Write it like a message to the agent. Every run starts from these instructions."
      >
        <ComposerField draft={draft} update={update} picks={picks} questions={questions} />
      </Field>
      <div className="min-w-0">
        <p id={whenLabelId} className="mb-2 text-sm font-medium text-fg">
          When
        </p>
        <CadencePicker
          aria-labelledby={whenLabelId}
          variant={picks.cadence}
          value={draft.cadence}
          onChange={(cadence) => update({ cadence })}
          timeZones={timeZones}
          frequencies={frequencies}
          now={KIT_NOW}
          viewerTimeZone={KIT_TIME_ZONE}
        />
      </div>
      <Field
        label="Name"
        optional
        error={errors.name}
        hint="Shown in the list and as the title of each run's chat."
      >
        <TextInput
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder={derivedName || "Named after the instructions"}
          suppressAutofill
        />
      </Field>
      {questions.q22RemoveDescription ? null : (
        <Field label="Description" optional hint="A short summary shown in the schedule list.">
          <TextInput
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="What this schedule is for"
            suppressAutofill
          />
        </Field>
      )}
      <Disclosure
        variant={picks.disclosure}
        title="Advanced"
        summary={advancedSummary(draft, questions.q27OngoingOnly)}
      >
        <AdvancedFields
          draft={draft}
          update={update}
          picks={picks}
          questions={questions}
          canRunSchedules={canRunSchedules}
        />
      </Disclosure>
    </FieldStack>
  );

  return (
    <FormPage
      title={create ? "New schedule" : "Edit schedule"}
      description={create ? undefined : editingName}
      submitLabel={create ? "Create schedule" : "Save changes"}
      pendingLabel={create ? "Creating…" : "Saving…"}
      onSubmit={onSubmit}
      onSubmitted={onDone}
      onCancel={onCancel}
      onPendingChange={onPendingChange}
      back={{ label: backLabel, onClick: onCancel }}
      submitDisabled={!canRunSchedules}
      disabledReason="Connect a machine first. Schedules can't run in Design preview yet."
      footerStart="Runs with your connected accounts."
      className={className}
    >
      {fields}
    </FormPage>
  );
}
