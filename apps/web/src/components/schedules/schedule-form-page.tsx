/**
 * New schedule, Edit schedule and Duplicate: one full page with a back link
 * and a sticky footer. What (a composer-style field with chips) -> When (the
 * cadence sentence and its next runs) -> an optional Name -> one closed
 * Advanced section. Knowledge source syncs keep a small editor of their own.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { LaptopIcon, ServerIcon } from "lucide-react";
import { toast } from "sonner";
import { MACHINES_COMPOSER_POLL_MS } from "@opengeni/react/machines";

import { ConnectionAccountPicker } from "@/components/capabilities/connection-account-picker";
import { connectionAccountChoices } from "@/components/capabilities/session-connection-accounts";
import { useConnectionAccounts } from "@/components/capabilities/use-connection-accounts";
import { AgentLearningDraftEditor } from "@/components/knowledge/agent-learning-settings";
import { Button } from "@/components/ui/button";
import { CadencePicker } from "@/components/ui/cadence-picker";
import { Disclosure } from "@/components/ui/disclosure";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextInput, useField } from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl, type SegmentedControlProps } from "@/components/ui/segmented-control";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { useAppContext } from "@/context";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { hasWorkspacePermission } from "@/lib/permissions";
import {
  formStateFromScheduledTask,
  recurringSessionTaskFormState,
  scheduledLearningDestinationKey,
} from "@/lib/scheduled-tasks";
import { sessionDisplayTitle } from "@/lib/session-rename";
import { useWorkspaceMachines } from "@/lib/use-workspace-machines";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import { cn } from "@/lib/utils";
import type { ScheduledTask, Session } from "@/types";

import { ComposerField } from "./schedule-composer";
import {
  NAME_MAX_LENGTH,
  SCHEDULE_FREQUENCIES,
  cadenceIssue,
  cadenceOfSchedule,
  createRequestFromDraft,
  defaultCadence,
  deriveScheduleName,
  draftFromTemplate,
  isKnowledgeSync,
  nextRunOf,
  newScheduleDraft,
  ownsSchedule,
  runTimeLabel,
  scheduleErrorText,
  scheduleName,
  templateById,
  updateRequestFromDraft,
  viewerTimeZone,
  type DraftDefaults,
  type ScheduleDraft,
} from "./schedule-model";
import { useScheduleAccess, useScheduleNavigation } from "./schedule-parts";
import { KnowledgeSyncFormPage } from "./knowledge-sync-form-page";

export type ScheduleFormMode =
  | { kind: "create"; template?: string; from?: string; sourceSessionId?: string }
  | { kind: "edit"; scheduleId: string };

type Source =
  | { status: "none" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; task: ScheduledTask };

export function ScheduleFormPage({
  workspaceId,
  mode,
}: {
  workspaceId: string;
  mode: ScheduleFormMode;
}) {
  const { client } = useAppContext();
  const sourceId = mode.kind === "edit" ? mode.scheduleId : mode.from;
  const [source, setSource] = useState<Source>(() =>
    sourceId ? { status: "loading" } : { status: "none" },
  );
  const [attempt, setAttempt] = useState(0);
  const go = useScheduleNavigation(workspaceId);

  useEffect(() => {
    if (!sourceId) {
      setSource({ status: "none" });
      return;
    }
    let live = true;
    setSource({ status: "loading" });
    void client
      .getScheduledTask(workspaceId, sourceId)
      .then((task) => {
        if (live) setSource({ status: "ready", task });
      })
      .catch((error: unknown) => {
        if (live) {
          setSource({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [attempt, client, sourceId, workspaceId]);

  const back =
    mode.kind === "edit"
      ? { label: "Schedule", onClick: () => go.detail(mode.scheduleId) }
      : { label: "Schedules", onClick: go.list };

  if (source.status === "loading" || source.status === "error") {
    return (
      <FormPage
        title={mode.kind === "edit" ? "Edit schedule" : "New schedule"}
        submitLabel={mode.kind === "edit" ? "Save changes" : "Create schedule"}
        back={back}
        onCancel={back.onClick}
        loading={source.status === "loading"}
        loadingFields={4}
        submitDisabled
      >
        {source.status === "error" ? (
          <ErrorMessage
            title="Couldn't load the schedule"
            details={[{ label: "Error", value: source.error.message }]}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </Button>
            }
          >
            It may have been deleted. Go back to Schedules to see the rest.
          </ErrorMessage>
        ) : null}
      </FormPage>
    );
  }

  const task = source.status === "ready" ? source.task : null;
  if (mode.kind === "edit" && task && isKnowledgeSync(task)) {
    return (
      <KnowledgeSyncFormPage
        workspaceId={workspaceId}
        task={task}
        onCancel={back.onClick}
        onSaved={() => go.detail(task.id, { replace: true })}
      />
    );
  }
  return (
    <AgentScheduleForm
      key={`${mode.kind}-${task?.id ?? "new"}-${mode.kind === "create" ? (mode.template ?? mode.sourceSessionId ?? "") : ""}`}
      workspaceId={workspaceId}
      mode={mode}
      task={task}
      back={
        mode.kind === "edit" && task
          ? { label: task.name, onClick: back.onClick }
          : mode.kind === "create" && task
            ? { label: task.name, onClick: () => go.detail(task.id) }
            : back
      }
    />
  );
}

/* ----------------------------------------------------------------------------
   The agent schedule form.
   -------------------------------------------------------------------------- */

function scheduledLearningScope(
  form: ScheduleDraft,
  sessions: Session[],
  personal: boolean,
): "personal" | "workspace" {
  if (
    form.agentLearningBaselineScope &&
    form.agentLearningDestinationKey === scheduledLearningDestinationKey(form)
  )
    return form.agentLearningBaselineScope;
  const target =
    form.runMode === "existing_session"
      ? sessions.find((session) => session.id === form.targetSessionId)
      : null;
  return form.knowledgeSource?.destination.kind === "personal" ||
    personal ||
    target?.tenancy?.visibility === "private" ||
    target?.memoryScope === "user"
    ? "personal"
    : "workspace";
}

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

type EachRun = "new_session_per_run" | "reusable_session" | "existing_session";

const EACH_RUN_HINT: Record<EachRun, string> = {
  new_session_per_run: "Every run starts a fresh chat, named after the schedule.",
  reusable_session:
    "Every run posts into the same chat, so the agent sees what it found last time.",
  existing_session: "Every run posts into the chat you pick, with that chat's tools.",
};

type IfStillRunning = "queue" | "skip";

const IF_STILL_RUNNING_HINT: Record<IfStillRunning, string> = {
  queue: "The new run waits, then starts when the previous one finishes.",
  skip: "The new run is skipped. The next one on the schedule runs as normal.",
};

interface FormErrors {
  prompt?: string;
  name?: string;
  target?: string;
  machine?: string;
}

function AgentScheduleForm({
  workspaceId,
  mode,
  task,
  back,
}: {
  workspaceId: string;
  mode: ScheduleFormMode;
  /** The schedule being edited, or duplicated from. */
  task: ScheduledTask | null;
  back: { label: string; onClick: () => void };
}) {
  const context = useAppContext();
  const { client } = context;
  const access = useScheduleAccess(workspaceId);
  const go = useScheduleNavigation(workspaceId);
  const editing = mode.kind === "edit";
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const fleet = useWorkspaceMachines({ pollIntervalMs: MACHINES_COMPOSER_POLL_MS });
  const canAttachOpenGeniTool = context.clientConfig.mcpServers.some(
    (server) => server.id === "opengeni",
  );
  const defaultSandboxBackend = context.clientConfig.defaultSandboxBackend ?? "modal";
  const machineOnly = defaultSandboxBackend === "selfhosted";
  const scheduledMachines = useMemo(
    () =>
      fleet.machines.filter(
        (machine) =>
          machine.kind === "selfhosted" && !machine.isSessionGroup && machine.scope !== "user",
      ),
    [fleet.machines],
  );
  const defaultMachineSandboxId =
    scheduledMachines.find((machine) => isMachineComputeSelectable(machine.state))?.sandboxId ?? "";
  const personal = isPersonalWorkspace(
    context.workspaces.find((item) => item.id === workspaceId) ?? null,
    context.managedSelfContext,
  );

  // The draft is built once. New schedules follow the workspace's resolved
  // default model until someone picks one, and are then saved without a model
  // so each run resolves the default afresh.
  const [initial] = useState<ScheduleDraft>(() => {
    const defaults: DraftDefaults = {
      includeOpenGeniTool: canAttachOpenGeniTool,
      model: modelCatalog.defaultSelection?.model ?? context.model,
      reasoningEffort: modelCatalog.defaultSelection?.reasoningEffort ?? context.reasoningEffort,
      modelFollowsDefault: true,
      defaultSandboxBackend: context.clientConfig.defaultSandboxBackend,
      defaultMachineSandboxId,
    };
    const formDefaults = {
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      modelFollowsDefault: true,
      defaultSandboxBackend: context.clientConfig.defaultSandboxBackend,
      defaultMachineSandboxId,
    };
    if (task) {
      const fromTask: ScheduleDraft = {
        ...formStateFromScheduledTask(task, formDefaults),
        cadence: cadenceOfSchedule(task.schedule),
        variableSetId: task.variableSetId,
        rigId: task.rigId,
      };
      if (editing) return fromTask;
      // Duplicate: a new schedule you own. Someone else's connected accounts
      // don't come with it, and the Knowledge source stays with the original.
      const own = ownsSchedule(task, access.viewerSubjectId);
      return {
        ...fromTask,
        name: `${task.name} (copy)`.slice(0, NAME_MAX_LENGTH),
        knowledgeSource: undefined,
        connectionAccounts: own ? fromTask.connectionAccounts : [],
        cadence: fromTask.cadence ?? defaultCadence(),
      };
    }
    if (mode.kind === "create" && mode.sourceSessionId) {
      return {
        ...recurringSessionTaskFormState(mode.sourceSessionId, canAttachOpenGeniTool, formDefaults),
        cadence: { timeZone: viewerTimeZone(), rule: { frequency: "hourly" } },
        variableSetId: null,
        rigId: null,
      };
    }
    const template = mode.kind === "create" ? templateById(mode.template) : undefined;
    if (template) return draftFromTemplate(template, defaults);
    return newScheduleDraft(defaults);
  });
  const [draft, setDraft] = useState<ScheduleDraft>(() => ({
    ...initial,
    mcpServerIds:
      initial.mcpServerIds ??
      [...context.selectedCapabilityToolIds].filter((id) => id !== "opengeni"),
  }));
  const [errors, setErrors] = useState<FormErrors>({});
  const [advancedOpen, setAdvancedOpen] = useState(() => initial.runMode === "existing_session");
  const now = useMemo(() => new Date(), []);

  const update = (patch: Partial<ScheduleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => ({
      ...current,
      ...(patch.prompt !== undefined ? { prompt: undefined } : {}),
      ...(patch.name !== undefined ? { name: undefined } : {}),
      ...(patch.targetSessionId !== undefined || patch.runMode !== undefined
        ? { target: undefined }
        : {}),
      ...(patch.machineSandboxId !== undefined || patch.executionTarget !== undefined
        ? { machine: undefined }
        : {}),
    }));
  };

  // Keep following the workspace default as the catalog resolves it.
  const followedDefault = draft.modelFollowsDefault ? modelCatalog.defaultSelection : null;
  useEffect(() => {
    if (!followedDefault) return;
    setDraft((current) =>
      current.modelFollowsDefault &&
      (current.model !== followedDefault.model ||
        current.reasoningEffort !== followedDefault.reasoningEffort)
        ? {
            ...current,
            model: followedDefault.model,
            reasoningEffort: followedDefault.reasoningEffort,
          }
        : current,
    );
  }, [followedDefault]);

  // A machine target picks the first machine that can run as soon as the
  // fleet loads.
  useEffect(() => {
    if (
      draft.runMode === "existing_session" ||
      draft.executionTarget !== "machine" ||
      draft.machineSandboxId
    ) {
      return;
    }
    const firstSelectable = scheduledMachines.find((machine) =>
      isMachineComputeSelectable(machine.state),
    );
    if (firstSelectable) {
      setDraft((current) => ({ ...current, machineSandboxId: firstSelectable.sandboxId }));
    }
  }, [draft.executionTarget, draft.machineSandboxId, draft.runMode, scheduledMachines]);

  /* ----- chats a run can post into */
  const [sessions, setSessions] = useState<Session[]>([]);
  const needsSessions = draft.runMode === "existing_session" && access.canTargetSessions;
  const sourceSessionId = mode.kind === "create" ? mode.sourceSessionId : undefined;
  useEffect(() => {
    if (!needsSessions) return;
    let live = true;
    void Promise.all([
      client.listSessions(workspaceId, { limit: 100 }).catch(() => [] as Session[]),
      sourceSessionId
        ? client.getSession(workspaceId, sourceSessionId, { fresh: true }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([list, exact]) => {
      if (!live) return;
      setSessions(
        [...(exact ? [exact] : []), ...list.filter((session) => session.id !== exact?.id)].filter(
          (session) => session.status !== "cancelled",
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [client, needsSessions, sourceSessionId, workspaceId]);

  /* ----- connected accounts for the chosen tools */
  const selectedIds =
    draft.runMode === "existing_session"
      ? (sessions.find((session) => session.id === draft.targetSessionId)?.effectiveToolPolicy
          ?.configuredIds ??
        sessions
          .find((session) => session.id === draft.targetSessionId)
          ?.tools.map((tool) => tool.id) ??
        [])
      : (draft.mcpServerIds ?? []);
  const connectionAccounts = useConnectionAccounts(
    context.client,
    {
      workspaceId,
      id: editing && task ? task.id : "new-schedule",
      selectedIds,
    },
    context.workspaceCapabilityCatalog,
    context.accessContext === null
      ? null
      : hasWorkspacePermission(context.accessContext, workspaceId, "connections:read"),
    connectionAccountChoices(initial.connectionAccounts ?? []),
  );

  /* ----- agent learning (edit loads the stored overrides) */
  const learningScope = scheduledLearningScope(draft, sessions, personal);
  const baselineDestinationKey = scheduledLearningDestinationKey(initial);
  const taskId = editing && task ? task.id : undefined;
  const [learningLoading, setLearningLoading] = useState(Boolean(taskId));
  const [learningError, setLearningError] = useState<string | null>(null);
  const [learningRetry, setLearningRetry] = useState(0);
  useEffect(() => {
    if (!taskId) return;
    let current = true;
    setLearningLoading(true);
    setLearningError(null);
    void client
      .getAgentLearningSettings(workspaceId, "context", { kind: "scheduled_task", id: taskId })
      .then((record) => {
        if (current)
          setDraft((previous) => ({
            ...previous,
            agentLearning: record.settings,
            agentLearningVersion: record.version,
            agentLearningBaselineScope: record.ownerKey.startsWith("personal:")
              ? "personal"
              : "workspace",
            agentLearningDestinationKey: baselineDestinationKey,
            agentLearningDirty: false,
          }));
      })
      .catch((reason) => {
        if (current) setLearningError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current) setLearningLoading(false);
      });
    return () => {
      current = false;
    };
  }, [baselineDestinationKey, client, learningRetry, taskId, workspaceId]);

  /* ----- where it runs */
  const selectableMachines = scheduledMachines.filter((machine) =>
    isMachineComputeSelectable(machine.state),
  );
  const cantRunHere =
    machineOnly &&
    draft.runMode !== "existing_session" &&
    !fleet.loading &&
    selectableMachines.length === 0;
  // Editing a schedule whose compute is unchanged stays possible (a rename, a
  // new cadence); only a new or changed target has to be one that can run.
  const computeChanged =
    !editing ||
    draft.runMode !== initial.runMode ||
    draft.executionTarget !== initial.executionTarget ||
    draft.machineSandboxId !== initial.machineSandboxId;
  const whereValue =
    draft.executionTarget === "managed" ? "managed" : draft.machineSandboxId || null;
  const whereOptions: SelectOption[] = [
    {
      value: "managed",
      label: "Managed sandbox",
      description: "A fresh cloud sandbox for each run.",
      leading: <ServerIcon className="size-4 text-fg-subtle" />,
      disabled: machineOnly,
      disabledReason: "This OpenGeni server doesn't run managed sandboxes.",
    },
    ...scheduledMachines.map((machine) => ({
      value: machine.sandboxId,
      label: machine.name,
      meta:
        machine.state === "online" ? "Connected machine" : `Connected machine · ${machine.state}`,
      description: "Runs on this computer, in its code folder.",
      leading: <LaptopIcon className="size-4 text-fg-subtle" />,
      disabled: !isMachineComputeSelectable(machine.state),
      disabledReason: "It's offline. Start OpenGeni on it to pick it.",
    })),
    ...(draft.machineSandboxId &&
    !scheduledMachines.some((machine) => machine.sandboxId === draft.machineSandboxId)
      ? [
          {
            value: draft.machineSandboxId,
            label: fleet.loading ? "Loading…" : "The chosen machine is unavailable",
            leading: <LaptopIcon className="size-4 text-fg-subtle" />,
          },
        ]
      : []),
  ];
  const whereLabel =
    draft.executionTarget === "managed"
      ? "Managed sandbox"
      : (scheduledMachines.find((machine) => machine.sandboxId === draft.machineSandboxId)?.name ??
        "Connected machine");

  /* ----- summaries */
  const eachRun = draft.runMode as EachRun;
  const ifStillRunning: IfStillRunning = draft.overlapPolicy === "skip" ? "skip" : "queue";
  const learningCustom = Boolean(draft.agentLearning && Object.keys(draft.agentLearning).length);
  const advancedSummary = [
    eachRun === "new_session_per_run"
      ? "New chat each run"
      : eachRun === "reusable_session"
        ? "One ongoing chat"
        : "An existing chat",
    ...(eachRun === "new_session_per_run"
      ? []
      : [ifStillRunning === "skip" ? "Skip if still running" : "Queue if still running"]),
    ...(eachRun === "existing_session" ? [] : [whereLabel]),
    learningCustom ? "Custom agent learning" : "Workspace learning defaults",
  ].join(" · ");

  const derivedName = deriveScheduleName(draft.prompt);
  const whenLabelId = useId();

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    if (!draft.prompt.trim()) next.prompt = "Describe what the agent should do on each run.";
    if (draft.name.trim().length > NAME_MAX_LENGTH) {
      next.name = `Keep the name under ${NAME_MAX_LENGTH} characters.`;
    }
    if (draft.runMode === "existing_session" && !draft.targetSessionId) {
      next.target = "Pick the chat each run posts into.";
    }
    if (
      draft.runMode !== "existing_session" &&
      draft.executionTarget === "machine" &&
      !draft.machineSandboxId
    ) {
      next.machine = "Pick a connected machine.";
    }
    if (
      draft.runMode !== "existing_session" &&
      draft.executionTarget === "managed" &&
      machineOnly &&
      computeChanged
    ) {
      next.machine = "This OpenGeni server needs a connected machine for schedules.";
    }
    return next;
  };

  const onSubmit = async () => {
    const next = validate();
    const cadenceProblem = cadenceIssue(draft.cadence, new Date());
    setErrors(next);
    if (next.target || next.machine) setAdvancedOpen(true);
    if (Object.values(next).some(Boolean) || cadenceProblem) return false;
    const submitted: ScheduleDraft = {
      ...draft,
      connectionAccounts: connectionAccounts.selections,
    };
    const submitNow = new Date();
    if (editing && task) {
      const learningChanged =
        submitted.agentLearningVersion !== undefined &&
        (submitted.agentLearningDirty ||
          submitted.agentLearningDestinationKey !== scheduledLearningDestinationKey(submitted));
      await withFriendlyError(
        "Couldn't save your changes.",
        client.updateScheduledTask(
          workspaceId,
          task.id,
          updateRequestFromDraft(task, initial, submitted, {
            now: submitNow,
            agentLearning: learningChanged
              ? {
                  scope: scheduledLearningScope(submitted, sessions, personal),
                  baselineScope: submitted.agentLearningBaselineScope,
                  operationId: crypto.randomUUID(),
                  expectedVersion: submitted.agentLearningVersion!,
                  settings: submitted.agentLearning ?? {},
                }
              : undefined,
          }),
        ),
      );
      toast.success("Changes saved", { description: scheduleName(submitted) });
      go.detail(task.id, { replace: true });
      return true;
    }
    const created = await withFriendlyError(
      "Couldn't create the schedule.",
      client.createScheduledTask(
        workspaceId,
        createRequestFromDraft(submitted, {
          now: submitNow,
          learningScope: scheduledLearningScope(submitted, sessions, personal),
        }),
      ),
    );
    const first = nextRunOf(created, new Date());
    toast.success("Schedule created", {
      description: first ? `First run ${runTimeLabel(first, new Date())}.` : undefined,
      action:
        access.canRun && created.status === "active"
          ? {
              label: "Run once now",
              onClick: () =>
                void client
                  .triggerScheduledTask(workspaceId, created.id)
                  .then(() => toast.success(`Started ${created.name}`))
                  .catch((error: unknown) =>
                    toast.error("Couldn't start a run", {
                      description: error instanceof Error ? error.message : String(error),
                    }),
                  ),
            }
          : undefined,
    });
    go.detail(created.id, { replace: true });
    return true;
  };

  const noAccess = editing
    ? Boolean(task && !(ownsSchedule(task, access.viewerSubjectId) && access.canManage))
    : !access.canManage;
  const submitBlocked =
    noAccess ||
    (cantRunHere && computeChanged) ||
    learningLoading ||
    connectionAccounts.loading ||
    Boolean(connectionAccounts.error) ||
    connectionAccounts.requiresAccountChoice;
  const blockedReason = noAccess
    ? editing && task && !ownsSchedule(task, access.viewerSubjectId)
      ? "Only the schedule's owner can change it. Duplicate it to make your own."
      : "You need permission to manage schedules in this workspace."
    : cantRunHere && computeChanged
      ? "Connect a machine first. This OpenGeni server can't run schedules without one."
      : connectionAccounts.requiresAccountChoice
        ? (connectionAccounts.accountChoiceMessage ?? "Pick an account for each tool.")
        : learningLoading || connectionAccounts.loading
          ? "Loading this schedule's settings…"
          : connectionAccounts.error
            ? "Connected accounts couldn't load. Try again."
            : undefined;

  const selectedSession = sessions.find((session) => session.id === draft.targetSessionId);
  const sessionOptions: SelectOption[] = [
    ...(draft.targetSessionId && !selectedSession
      ? [
          {
            value: draft.targetSessionId,
            label: sessions.length ? "The chosen chat is unavailable" : "Loading chats…",
            disabled: true,
          },
        ]
      : []),
    ...sessions.map((session) => ({
      value: session.id,
      label: sessionDisplayTitle(session),
      meta: session.status,
    })),
  ];

  return (
    <FormPage
      title={editing ? "Edit schedule" : "New schedule"}
      description={editing ? task?.name : undefined}
      submitLabel={editing ? "Save changes" : "Create schedule"}
      pendingLabel={editing ? "Saving…" : "Creating…"}
      onSubmit={onSubmit}
      onCancel={back.onClick}
      back={back}
      submitDisabled={submitBlocked}
      disabledReason={blockedReason}
      footerStart="Runs with your connected accounts."
    >
      <FieldStack>
        {cantRunHere ? (
          <Notice
            tone="waiting"
            title={
              editing
                ? "This schedule can't run here yet"
                : "Schedules need a connected machine here"
            }
            actionLayout="responsive"
            action={
              <Button asChild variant="outline" size="sm" className="pointer-coarse:h-11">
                <a href={`/workspaces/${encodeURIComponent(workspaceId)}/machines`}>
                  Connect a machine
                </a>
              </Button>
            }
          >
            This OpenGeni server doesn't run managed sandboxes, and no machine that can run is
            connected to this workspace yet.
          </Notice>
        ) : null}
        {sourceSessionId ? (
          <Notice>
            Each run continues the chat you came from. Check the instructions and when it runs;
            nothing repeats until you create the schedule.
          </Notice>
        ) : null}
        <Field
          label="What should the agent do?"
          error={errors.prompt}
          hint="Write it like a message to the agent. Every run starts from these instructions."
        >
          <ComposerField
            workspaceId={workspaceId}
            draft={draft}
            update={update}
            modelRows={modelCatalog.rows}
            defaultModelSelection={modelCatalog.defaultSelection}
            modelsLoading={modelCatalog.loading}
            modelsError={modelCatalog.error}
            canAttachOpenGeniTool={canAttachOpenGeniTool}
            existingChat={draft.runMode === "existing_session"}
          />
        </Field>
        {connectionAccounts.accountGroups.length > 0 || connectionAccounts.error ? (
          <div className="-mt-3 flex min-w-0 flex-col gap-2">
            <ConnectionAccountPicker
              groups={connectionAccounts.accountGroups}
              choices={connectionAccounts.accountChoices}
              onChoose={connectionAccounts.selectAccount}
            />
            {connectionAccounts.error ? (
              <Notice
                tone="failed"
                action={
                  connectionAccounts.accessDenied ? undefined : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void connectionAccounts.refresh()}
                    >
                      Try again
                    </Button>
                  )
                }
              >
                {connectionAccounts.error}
              </Notice>
            ) : null}
          </div>
        ) : null}
        <div className="min-w-0">
          <p id={whenLabelId} className="mb-2 text-sm leading-5 font-medium text-fg">
            When
          </p>
          {draft.cadence ? (
            <CadencePicker
              aria-labelledby={whenLabelId}
              value={draft.cadence}
              onChange={(cadence) => update({ cadence })}
              frequencies={SCHEDULE_FREQUENCIES}
              now={now}
              viewerTimeZone={viewerTimeZone()}
              timeZones={suggestedZones(draft.cadence.timeZone)}
            />
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <p className="m-0 text-sm leading-5 text-fg-muted">
                Runs only when someone presses Run now.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update({ cadence: defaultCadence() })}
              >
                Add a schedule
              </Button>
            </div>
          )}
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
        <Disclosure
          variant="row"
          title="Advanced"
          summary={advancedSummary}
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
        >
          <FieldStack>
            <Field label="Each run" hint={EACH_RUN_HINT[eachRun]}>
              <FieldSegmented<EachRun>
                value={eachRun}
                onValueChange={(runMode) => update({ runMode })}
                options={[
                  { value: "new_session_per_run", label: "New chat" },
                  { value: "reusable_session", label: "One ongoing chat" },
                  ...(initial.runMode === "existing_session" || eachRun === "existing_session"
                    ? [{ value: "existing_session" as const, label: "An existing chat" }]
                    : []),
                ]}
              />
            </Field>
            {eachRun === "existing_session" ? (
              <Field label="Chat" error={errors.target}>
                <SelectMenu
                  variant={sessionOptions.length > 8 ? "combobox" : "menu"}
                  options={sessionOptions}
                  value={draft.targetSessionId || null}
                  onValueChange={(targetSessionId) => update({ targetSessionId })}
                  placeholder="Pick a chat"
                  searchPlaceholder="Search chats"
                  disabled={!access.canTargetSessions}
                  disabledReason="You need permission to open chats in this workspace."
                  invalid={Boolean(errors.target)}
                  className="max-w-[420px]"
                />
              </Field>
            ) : null}
            {eachRun !== "new_session_per_run" ? (
              <Field
                label="If the previous run is still working"
                hint={IF_STILL_RUNNING_HINT[ifStillRunning]}
              >
                <FieldSegmented<IfStillRunning>
                  value={ifStillRunning}
                  onValueChange={(value) =>
                    update({ overlapPolicy: value === "skip" ? "skip" : "allow_concurrent" })
                  }
                  options={[
                    { value: "queue", label: "Queue this run" },
                    { value: "skip", label: "Skip this run" },
                  ]}
                />
              </Field>
            ) : null}
            {eachRun !== "existing_session" ? (
              <Field label="Where it runs" error={errors.machine}>
                <SelectMenu
                  options={whereOptions}
                  value={whereValue}
                  onValueChange={(value) =>
                    value === "managed"
                      ? update({ executionTarget: "managed" })
                      : update({ executionTarget: "machine", machineSandboxId: value })
                  }
                  placeholder={fleet.loading ? "Loading machines…" : "Pick where it runs"}
                  loading={fleet.loading && scheduledMachines.length === 0 && machineOnly}
                  invalid={Boolean(errors.machine)}
                  className="max-w-[360px]"
                />
              </Field>
            ) : null}
            {eachRun !== "existing_session" &&
            draft.executionTarget === "machine" &&
            draft.machineSandboxId ? (
              <Field
                label="Folder"
                optional
                hint="Absolute, or relative to the machine's workspace root. Empty uses the root."
              >
                <TextInput
                  value={draft.workingDir}
                  onChange={(event) => update({ workingDir: event.target.value })}
                  placeholder="/home/me/repos/project"
                  suppressAutofill
                />
              </Field>
            ) : null}
            {fleet.error && eachRun !== "existing_session" ? (
              <p className="-mt-3 text-xs leading-4.5 text-danger">
                Connected machines couldn't load. Refresh the page and try again.
              </p>
            ) : null}
            {learningLoading ? (
              <p role="status" className="m-0 text-sm text-fg-muted">
                Loading this schedule's agent learning settings…
              </p>
            ) : learningError ? (
              <ErrorMessage
                variant="inline"
                title="Agent learning settings couldn't load. You can still save other changes."
                details={[{ label: "Error", value: learningError }]}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setLearningRetry((value) => value + 1)}
                  >
                    Try again
                  </Button>
                }
              />
            ) : (
              <AgentLearningDraftEditor
                workspaceId={workspaceId}
                scope={learningScope}
                value={draft.agentLearning ?? {}}
                onChange={(value) =>
                  setDraft((previous) => ({
                    ...previous,
                    agentLearning: value,
                    agentLearningDirty: true,
                  }))
                }
              />
            )}
          </FieldStack>
        </Disclosure>
      </FieldStack>
    </FormPage>
  );
}

/** Server errors read as a sentence inside the form, never "OpenGeni API 422: …". */
async function withFriendlyError<T>(lead: string, request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw new Error(`${lead} ${scheduleErrorText(error)}`, { cause: error });
  }
}

/** The viewer's zone and the schedule's zone first; search covers the rest. */
function suggestedZones(current: string) {
  const zones = [...new Set([viewerTimeZone(), current, "UTC"])];
  return zones.map((id) => {
    const city = id === "UTC" ? "UTC" : (id.split("/").pop() ?? id).replaceAll("_", " ");
    return { id, label: id === "UTC" ? "UTC" : `${city} time`, shortLabel: city };
  });
}
