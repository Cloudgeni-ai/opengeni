import { workspaceDefaultMachine } from "@opengeni/react/app/lib/workspace-default-machine";
import { Link } from "@tanstack/react-router";
/**
 * New automation, Edit automation and Duplicate: one full page with a back
 * link and a sticky footer. What (a composer-style field with chips) -> When
 * (the cadence sentence and its next runs, and the events that start a run)
 * -> an optional Name -> one closed Settings section. Knowledge source syncs
 * keep a small editor of their own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LaptopIcon, LockIcon, MessageSquareIcon, ServerIcon, UsersIcon } from "lucide-react";
import { toast } from "sonner";
import { MACHINES_COMPOSER_POLL_MS } from "@opengeni/react/machines";
import { t } from "@opengeni/react/app/lib/console-text";
import {
  AutomationWhenField,
  automationTemplateOfSaved,
  automationTemplatesFor,
  emptyEventTriggersDraft,
  eventTriggersDraftFrom,
  hasEventTriggerIssues,
  useEventSourceStandIns,
  validateEventTriggers,
  withTemplateSources,
  type AutomationTemplate,
  type EventTriggersIssues,
} from "@opengeni/react/automations";

import { ConnectionAccountPicker } from "@opengeni/react/app/components/capabilities/connection-account-picker";
import { selectedConnectionAccounts } from "@opengeni/react/app/components/capabilities/session-connection-accounts";
import { useConnectionAccounts } from "@opengeni/react/app/components/capabilities/use-connection-accounts";
import { AgentLearningDraftEditor } from "@opengeni/react/app/components/knowledge/agent-learning-settings";
import { Button } from "@opengeni/react/ui/button";
import { Disclosure } from "@opengeni/react/ui/disclosure";
import { useVaults } from "@opengeni/react";
import {
  ScheduleSecretsField,
  scheduleSecretsSummary,
} from "@/components/secrets/schedule-secrets-field";
import {
  secretsCapabilityOff,
  secretsOffIn,
} from "@opengeni/react/app/components/secrets/vault-model";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { CheckboxField, Field, FieldStack, TextInput, useField } from "@opengeni/react/ui/field";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { HelpLink } from "@opengeni/react/ui/inline-help";
import { Notice } from "@opengeni/react/ui/notice";
import { SegmentedControl, type SegmentedControlProps } from "@opengeni/react/ui/segmented-control";
import { SelectMenu, type SelectOption } from "@opengeni/react/ui/select-menu";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  apiErrorAdvice,
  apiErrorDetails,
  apiErrorFacts,
  isApiError,
  isPermissionDenied,
  userErrorText,
} from "@opengeni/react/ui/api-error";
import { isMachineComputeSelectable } from "@opengeni/react/app/lib/machine-selectability";
import { isPersonalWorkspace } from "@opengeni/react/app/lib/managed-self-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import {
  formStateFromScheduledTask,
  recurringSessionTaskFormState,
  scheduledLearningDestinationKey,
} from "@/lib/scheduled-tasks";
import { sessionDisplayTitle } from "@opengeni/react/app/lib/session-rename";
import { useWorkspaceMachines } from "@opengeni/react/app/lib/use-workspace-machines";
import { useWorkspaceModelCatalog } from "@opengeni/react/app/lib/use-workspace-model-catalog";
import { cn } from "@opengeni/react/app/lib/utils";
import type { ScheduledTask, Session } from "@opengeni/react/app/types";

import { useCanCreateScheduleWithAgent, useCreateWithOpenGeni } from "./create-with-opengeni";

import { ComposerField } from "./schedule-composer";
import { ScheduleAgentCapabilities } from "./schedule-agent-capabilities";
import {
  NAME_MAX_LENGTH,
  SCHEDULE_FREQUENCIES,
  cadenceIssue,
  cadenceOfSchedule,
  cadenceRepeats,
  createRequestFromDraft,
  defaultCadence,
  deriveScheduleName,
  draftForEventSource,
  draftFromTemplate,
  hasEventTriggers,
  isKnowledgeSync,
  mergeSchedulePinnedAccounts,
  nextRunOf,
  newScheduleDraft,
  ownsSchedule,
  runTimeLabel,
  scheduleName,
  scheduleConnectionAccountIntent,
  templateById,
  updateRequestFromDraft,
  viewerTimeZone,
  type DraftDefaults,
  type ScheduleDraft,
} from "./schedule-model";
import { useScheduleAccess, useScheduleNavigation } from "./schedule-parts";
import { KnowledgeSyncFormPage } from "./knowledge-sync-form-page";
import {
  useEventSourceLogo,
  useEventSources,
  useEventTriggersEnabled,
  useReadyEventSources,
} from "./use-event-sources";
import { SAVED_TEMPLATE_ID } from "./use-automation-templates";

export type ScheduleFormMode =
  | {
      kind: "create";
      template?: string;
      from?: string;
      sourceSessionId?: string;
      /** Start with a trigger on this event source. */
      eventSourceId?: string;
    }
  | { kind: "edit"; scheduleId: string };

type Source =
  | { status: "none" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; task: ScheduledTask };

/** A template saved in the workspace that `?template=` names. */
type SavedTemplate =
  | { status: "none" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; template: AutomationTemplate | undefined };

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
  const eventTriggers = useEventTriggersEnabled();
  const savedTemplateId =
    mode.kind === "create" && mode.template && SAVED_TEMPLATE_ID.test(mode.template)
      ? mode.template
      : undefined;
  const [saved, setSaved] = useState<SavedTemplate>(() =>
    savedTemplateId ? { status: "loading" } : { status: "none" },
  );

  useEffect(() => {
    if (!savedTemplateId) {
      setSaved({ status: "none" });
      return;
    }
    let live = true;
    setSaved({ status: "loading" });
    client.listAutomationTemplates(workspaceId).then(
      (list) => {
        if (!live) return;
        const found = list.find((entry) => entry.id === savedTemplateId);
        // One that is gone opens a blank form, like an unknown built-in id.
        setSaved({ status: "ready", template: found && automationTemplateOfSaved(found) });
      },
      (error: unknown) => {
        if (live) {
          setSaved({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, client, savedTemplateId, workspaceId]);

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
      ? { label: "Automation", onClick: () => go.detail(mode.scheduleId) }
      : { label: "Automations", onClick: go.list };

  if (saved.status === "loading" || saved.status === "error") {
    return (
      <FormPage
        title="New automation"
        submitLabel="Create automation"
        back={back}
        onCancel={back.onClick}
        loading={saved.status === "loading"}
        loadingFields={4}
        submitDisabled
      >
        {saved.status === "error" ? (
          <ErrorMessage
            title="Couldn't load the template"
            {...apiErrorDetails(saved.error)}
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
            {apiErrorAdvice(saved.error)}
          </ErrorMessage>
        ) : null}
      </FormPage>
    );
  }
  if (source.status === "loading" || source.status === "error") {
    return (
      <FormPage
        title={mode.kind === "edit" ? "Edit automation" : "New automation"}
        submitLabel={mode.kind === "edit" ? "Save changes" : "Create automation"}
        back={back}
        onCancel={back.onClick}
        loading={source.status === "loading"}
        loadingFields={4}
        submitDisabled
      >
        {source.status === "error" ? (
          isPermissionDenied(source.error) ? (
            <Notice title="You can't open this automation.">
              Ask a workspace admin for access.
            </Notice>
          ) : (
            <ErrorMessage
              title="Couldn't load the automation"
              {...apiErrorDetails(source.error)}
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
              {apiErrorFacts(source.error).status === 404
                ? "It may have been deleted. Go back to Automations to see the rest."
                : apiErrorAdvice(source.error)}
            </ErrorMessage>
          )
        ) : null}
      </FormPage>
    );
  }

  const task = source.status === "ready" ? source.task : null;
  const chosen =
    mode.kind !== "create"
      ? undefined
      : saved.status === "ready"
        ? saved.template
        : templateById(mode.template, eventTriggers);
  // A template on events opens blank where events don't run.
  const template = chosen
    ? automationTemplatesFor([chosen], { eventTriggers, workspaceEvents: true })[0]
    : undefined;
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
      key={`${mode.kind}-${task?.id ?? "new"}-${mode.kind === "create" ? (mode.template ?? mode.sourceSessionId ?? mode.eventSourceId ?? "") : ""}`}
      workspaceId={workspaceId}
      mode={mode}
      task={task}
      template={template}
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

type IfStillRunning = "steer" | "queue" | "skip";

const IF_STILL_RUNNING_HINT: Record<IfStillRunning, string> = {
  steer:
    "The new run reaches the agent at its next step, so it handles both together. Anything else working in the chat, like your own message, still finishes first.",
  queue: "The new run waits, then starts when the previous one finishes.",
  skip: "The new run is skipped. The next one runs as normal.",
};

const IF_STILL_RUNNING_SUMMARY: Record<IfStillRunning, string> = {
  steer: "Steer if still running",
  queue: "Queue if still running",
  skip: "Skip if still running",
};

interface FormErrors {
  prompt?: string;
  name?: string;
  target?: string;
  machine?: string;
  /** The schedule and the events disagree, such as run once on a repeating schedule. */
  when?: string;
  /** The event-runs-per-hour setting. */
  maxRunsPerHour?: string;
}

function AgentScheduleForm({
  workspaceId,
  mode,
  task,
  template,
  back,
}: {
  workspaceId: string;
  mode: ScheduleFormMode;
  /** The schedule being edited, or duplicated from. */
  task: ScheduledTask | null;
  /** The template a new automation starts from. */
  template: AutomationTemplate | undefined;
  back: { label: string; onClick: () => void };
}) {
  const context = useAppContext();
  const { client } = context;
  const access = useScheduleAccess(workspaceId);
  const go = useScheduleNavigation(workspaceId);
  const editing = mode.kind === "edit";
  const eventTriggers = useEventTriggersEnabled();
  const eventSources = useEventSources(workspaceId, eventTriggers);
  const readySources = useReadyEventSources(workspaceId, eventTriggers);
  // Sources that need no setting up (an MCP server that offers events, the
  // viewer's Gmail, this workspace's own events) are offered before the
  // viewer has added them.
  const standIns = useEventSourceStandIns({
    client,
    workspaceId,
    sources: eventSources.sources,
    readySources,
    workspaceEvents: eventTriggers,
  });
  const formSources = standIns.sources;
  const sourceLogo = useEventSourceLogo();
  const canAsk = useCanCreateScheduleWithAgent(workspaceId);
  const ask = useCreateWithOpenGeni(workspaceId);
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const fleet = useWorkspaceMachines({
    pollIntervalMs: MACHINES_COMPOSER_POLL_MS,
  });
  const canAttachOpenGeniTool = context.clientConfig.mcpServers.some(
    (server) => server.id === "opengeni",
  );
  const defaultSandboxBackend = context.clientConfig.defaultSandboxBackend ?? "modal";
  const machineOnly = defaultSandboxBackend === "selfhosted";
  // Without a managed sandbox backend a run off a connected machine has no computer.
  const noManagedSandbox = defaultSandboxBackend === "none";
  // Shared machines run any schedule. Your own machines (only you see them) run
  // only schedules set to Only me, so picking one makes the schedule Only me.
  const sharedMachines = useMemo(
    () =>
      fleet.machines.filter(
        (machine) =>
          machine.kind === "selfhosted" && !machine.isSessionGroup && machine.scope !== "user",
      ),
    [fleet.machines],
  );
  const personalMachines = useMemo(
    () =>
      fleet.machines.filter(
        (machine) =>
          machine.kind === "selfhosted" && !machine.isSessionGroup && machine.scope === "user",
      ),
    [fleet.machines],
  );
  const defaultMachineSandboxId =
    sharedMachines.find((machine) => isMachineComputeSelectable(machine.state))?.sandboxId ?? "";
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
      workspaceDefaultToolIds: context.workspaceDefaultToolIds,
    };
    const formDefaults = {
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      modelFollowsDefault: true,
      defaultSandboxBackend: context.clientConfig.defaultSandboxBackend,
      defaultMachineSandboxId,
      workspaceDefaultToolIds: context.workspaceDefaultToolIds,
    };
    if (task) {
      const fromTask: ScheduleDraft = {
        ...formStateFromScheduledTask(task, formDefaults),
        cadence: cadenceOfSchedule(task.schedule),
        events: eventTriggersDraftFrom(task.events),
        rigId: task.rigId,
        visibility: task.visibility,
        ...(task.vaultPolicy?.mode === "selected" ? { vaultPolicy: task.vaultPolicy } : {}),
      };
      if (editing) return fromTask;
      // Duplicate: a new automation you own. Someone else's connected accounts
      // don't come with it, and the Knowledge source stays with the original.
      // One that only events start stays that way.
      const own = ownsSchedule(task, access.viewerSubjectId);
      return {
        ...fromTask,
        name: `${task.name} (copy)`.slice(0, NAME_MAX_LENGTH),
        knowledgeSource: undefined,
        pinnedAccounts: own ? fromTask.pinnedAccounts : [],
        cadence: fromTask.cadence ?? (hasEventTriggers(task) ? null : defaultCadence()),
      };
    }
    if (mode.kind === "create" && mode.sourceSessionId) {
      return {
        ...recurringSessionTaskFormState(mode.sourceSessionId, canAttachOpenGeniTool, formDefaults),
        cadence: { timeZone: viewerTimeZone(), rule: { frequency: "hourly" } },
        events: emptyEventTriggersDraft(),
        rigId: null,
        visibility: "workspace",
      };
    }
    if (mode.kind === "create" && mode.eventSourceId && eventTriggers) {
      return draftForEventSource(mode.eventSourceId, defaults);
    }
    if (template) return draftFromTemplate(template, defaults);
    return newScheduleDraft(defaults);
  });
  const [draft, setDraft] = useState<ScheduleDraft>(() => {
    const workspaceDefaultToolIds =
      initial.workspaceDefaultToolIds ??
      context.workspaceDefaultToolIds.filter((id) => id !== "opengeni");
    return {
      ...initial,
      // A new schedule that follows the defaults starts from them, like a new chat.
      mcpServerIds:
        initial.mcpServerIds ??
        (initial.followsWorkspaceDefaults
          ? workspaceDefaultToolIds
          : [...context.selectedCapabilityToolIds].filter((id) => id !== "opengeni")),
      workspaceDefaultToolIds,
    };
  });
  const savedReusableSessionId =
    editing && task?.runMode === "reusable_session" ? task.reusableSessionId : null;
  const materializedSessionId =
    draft.runMode === "reusable_session" ? savedReusableSessionId : null;
  const inheritsChatSettings =
    draft.runMode === "existing_session" || Boolean(materializedSessionId);
  const [errors, setErrors] = useState<FormErrors>({});
  const [eventIssues, setEventIssues] = useState<EventTriggersIssues | undefined>(undefined);
  // The runs-per-hour box keeps what was typed, even while it isn't a number yet.
  const [runsPerHourText, setRunsPerHourText] = useState(() =>
    String(initial.events.maxRunsPerHour),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [accessChange, setAccessChange] = useState<{
    environment: boolean;
  } | null>(null);
  const [adoptSessionSettings, setAdoptSessionSettings] = useState(false);
  const [editedAccountServerIds, setEditedAccountServerIds] = useState<string[]>([]);
  const accessReview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (accessChange) {
      accessReview.current?.focus();
      accessReview.current?.scrollIntoView({ block: "nearest" });
    }
  }, [accessChange]);
  // Accounts matter to saving only while a person is pinning some.
  const pinningAccounts = draft.runMode !== "existing_session" && editedAccountServerIds.length > 0;
  const now = useMemo(() => new Date(), []);

  const update = (patch: Partial<ScheduleDraft>) => {
    if (patch.targetSessionId !== undefined || patch.runMode !== undefined) {
      setAccessChange(null);
      setAdoptSessionSettings(false);
    }
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
      ...(patch.cadence !== undefined || patch.events !== undefined ? { when: undefined } : {}),
      ...(patch.events !== undefined ? { maxRunsPerHour: undefined } : {}),
    }));
    if (patch.events !== undefined) setEventIssues(undefined);
  };

  // A GitHub event names a repository, but a run can only open the
  // repositories its message carries.
  const needsRepositories =
    eventTriggers &&
    !inheritsChatSettings &&
    !draft.resources.some((resource) => resource.kind === "repository") &&
    draft.events.triggers.some(
      (trigger) => formSources?.find((source) => source.id === trigger.sourceId)?.kind === "github",
    );
  // A template's trigger names a kind of source: it takes the viewer's own
  // once their sources load.
  useEffect(() => {
    setDraft((current) => {
      const events = withTemplateSources(current.events, formSources);
      return events === current.events ? current : { ...current, events };
    });
  }, [formSources]);

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
    if (inheritsChatSettings || draft.executionTarget !== "machine" || draft.machineSandboxId) {
      return;
    }
    const firstSelectable = sharedMachines.find((machine) =>
      isMachineComputeSelectable(machine.state),
    );
    if (firstSelectable) {
      setDraft((current) => ({
        ...current,
        machineSandboxId: firstSelectable.sandboxId,
      }));
    }
  }, [draft.executionTarget, draft.machineSandboxId, inheritsChatSettings, sharedMachines]);

  /* ----- destination chats */
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<unknown>(null);
  const [sessionsRetry, setSessionsRetry] = useState(0);
  const needsSessions = inheritsChatSettings && access.canTargetSessions;
  const sourceSessionId = mode.kind === "create" ? mode.sourceSessionId : undefined;
  const targetSessionId = materializedSessionId ?? draft.targetSessionId;
  useEffect(() => {
    if (!needsSessions) return;
    let live = true;
    setSessionsLoading(true);
    setSessionsError(null);
    void Promise.allSettled([
      materializedSessionId
        ? Promise.resolve([] as Session[])
        : client.listSessions(workspaceId, { limit: 100 }),
      targetSessionId
        ? client.getSession(workspaceId, targetSessionId, { fresh: true })
        : Promise.resolve(null),
    ]).then(([listResult, exactResult]) => {
      if (!live) return;
      const list = listResult.status === "fulfilled" ? listResult.value : [];
      const exact = exactResult.status === "fulfilled" ? exactResult.value : null;
      // Fetch the chosen chat independently: it may be older than the recent list.
      setSessions(
        [
          ...(exact ? [exact] : []),
          ...list.filter(
            (session) =>
              session.id !== exact?.id &&
              (exactResult.status === "fulfilled" || session.id !== targetSessionId),
          ),
        ].filter((session) => session.status !== "cancelled"),
      );
      setSessionsError(
        exactResult.status === "rejected"
          ? exactResult.reason
          : listResult.status === "rejected"
            ? listResult.reason
            : null,
      );
      setSessionsLoading(false);
    });
    return () => {
      live = false;
    };
  }, [client, materializedSessionId, needsSessions, targetSessionId, workspaceId, sessionsRetry]);

  /* ----- who can see it */
  const [canCreatePrivate, setCanCreatePrivate] = useState<boolean | null>(null);
  // A new schedule starts with the organization's default audience until the
  // person picks one.
  const audienceChosenRef = useRef(false);
  const creating = mode.kind === "create";
  useEffect(() => {
    if (personal) return;
    let live = true;
    void client
      .getSessionTenancyCreateCapabilities(workspaceId)
      .then((capabilities) => {
        if (!live) return;
        setCanCreatePrivate(capabilities.canCreatePrivate === true);
        if (
          creating &&
          capabilities.canCreatePrivate === true &&
          capabilities.defaultVisibility === "private" &&
          !audienceChosenRef.current
        )
          setDraft((current) =>
            current.visibility === "private" ? current : { ...current, visibility: "private" },
          );
      })
      .catch(() => {
        if (live) setCanCreatePrivate(false);
      });
    return () => {
      live = false;
    };
  }, [client, creating, personal, workspaceId]);
  const audienceTarget =
    draft.runMode === "existing_session"
      ? sessions.find((session) => session.id === draft.targetSessionId)
      : undefined;
  // A schedule that posts into an Only me chat, or saves to personal
  // knowledge, is always Only me; the server enforces the same rule.
  const personalMachineChosen =
    !inheritsChatSettings &&
    draft.executionTarget === "machine" &&
    personalMachines.some((machine) => machine.sandboxId === draft.machineSandboxId);
  const privateReason =
    audienceTarget?.tenancy?.visibility === "private"
      ? "It posts into an Only me chat."
      : draft.knowledgeSource?.destination.kind === "personal"
        ? "It saves to your personal knowledge."
        : personalMachineChosen
          ? "It runs on your own machine."
          : null;
  useEffect(() => {
    if (privateReason)
      setDraft((current) =>
        current.visibility === "private" ? current : { ...current, visibility: "private" },
      );
  }, [privateReason]);
  // A new automation that listens to something only its owner sees (their
  // meetings, mailbox or MCP connection) starts out Only me; they can still
  // share it.
  const listensPrivately = draft.events.triggers.some(
    (trigger) =>
      formSources?.find((source) => source.id === trigger.sourceId)?.visibility === "private",
  );
  useEffect(() => {
    if (!creating || !listensPrivately || canCreatePrivate !== true || audienceChosenRef.current)
      return;
    setDraft((current) =>
      current.visibility === "private" ? current : { ...current, visibility: "private" },
    );
  }, [canCreatePrivate, creating, listensPrivately]);
  const showAudience =
    !personal &&
    (canCreatePrivate === true || draft.visibility === "private" || privateReason !== null);

  /* ----- connected accounts for the chosen tools
   * Connectors follow the owner's current accounts at every run. Only a
   * schedule that starts its own session can pin accounts, and only for the
   * connectors a person changes here. An existing-chat schedule uses that
   * chat's connectors, so it shows no account picker. */
  const pinnable = draft.runMode !== "existing_session";
  const accountTargetSession = inheritsChatSettings
    ? sessions.find((session) => session.id === targetSessionId)
    : undefined;
  const [pinsCleared, setPinsCleared] = useState(false);
  const savedPins = pinsCleared ? [] : (initial.pinnedAccounts ?? []);
  const selectedIds = !pinnable
    ? []
    : inheritsChatSettings
      ? (accountTargetSession?.effectiveToolPolicy?.configuredIds ??
        accountTargetSession?.tools.map((tool) => tool.id) ??
        [])
      : (draft.mcpServerIds ?? []);
  const accountIntent = scheduleConnectionAccountIntent({
    saved: savedPins,
    editedServerIds: pinnable ? editedAccountServerIds : [],
    destinationChanged:
      draft.runMode !== initial.runMode || draft.targetSessionId !== initial.targetSessionId,
    toolsChanged: JSON.stringify(draft.mcpServerIds) !== JSON.stringify(initial.mcpServerIds),
    pinsCleared,
  });
  // Re-checking pins against a chat's connectors needs that chat loaded.
  const pinsNeedChat =
    pinnable &&
    accountIntent.changed &&
    (savedPins.length > 0 || editedAccountServerIds.length > 0) &&
    inheritsChatSettings &&
    !accountTargetSession;
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
    accountIntent.choices,
  );
  // The shared hook keeps choices between tool changes. Carry only manual edits
  // across destinations; untouched groups follow this schedule's current baseline.
  const accountChoices = {
    ...accountIntent.choices,
    ...Object.fromEntries(
      editedAccountServerIds.flatMap((id) => {
        const choice = connectionAccounts.accountChoices[id];
        return choice === undefined ? [] : [[id, choice]];
      }),
    ),
  };
  // Only the groups a person changed become pins; the rest stay live.
  const accountSelection = selectedConnectionAccounts(
    connectionAccounts.accountGroups.filter((group) =>
      accountIntent.changedServerIds.includes(group.serverId),
    ),
    accountChoices,
  );
  const requiresAccountChoice = accountSelection.unresolved.length > 0;
  const accountChoiceMessage = requiresAccountChoice
    ? `Pick an account for ${accountSelection.unresolved.map((group) => group.name).join(", ")}, or use your current accounts.`
    : null;
  const pinnedGroupNames = connectionAccounts.accountGroups
    .filter(
      (group) =>
        accountIntent.changedServerIds.includes(group.serverId) ||
        savedPins.some((pin) => pin.serverId === group.serverId),
    )
    .map((group) => group.name);
  const usePinnedAccountsDefaults = () => {
    setPinsCleared(true);
    setEditedAccountServerIds([]);
  };

  /* ----- agent learning (edit loads the stored overrides) */
  const learningScope = scheduledLearningScope(draft, sessions, personal);
  const baselineDestinationKey = scheduledLearningDestinationKey(initial);
  const taskId = editing && task ? task.id : undefined;
  const [learningLoading, setLearningLoading] = useState(Boolean(taskId));
  const [learningError, setLearningError] = useState<unknown>(null);
  const [learningRetry, setLearningRetry] = useState(0);
  useEffect(() => {
    if (!taskId) return;
    let current = true;
    setLearningLoading(true);
    setLearningError(null);
    void client
      .getAgentLearningSettings(workspaceId, "context", {
        kind: "scheduled_task",
        id: taskId,
      })
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
      .catch((reason: unknown) => {
        if (current) setLearningError(reason);
      })
      .finally(() => {
        if (current) setLearningLoading(false);
      });
    return () => {
      current = false;
    };
  }, [baselineDestinationKey, client, learningRetry, taskId, workspaceId]);

  /* ----- where it runs */
  // Your own machines are offered whenever the schedule can be Only me.
  const offerPersonalMachines =
    personalMachines.length > 0 &&
    (personal || canCreatePrivate === true || draft.visibility === "private");
  const scheduledMachines = offerPersonalMachines
    ? [...sharedMachines, ...personalMachines]
    : sharedMachines;
  const selectableMachines = scheduledMachines.filter((machine) =>
    isMachineComputeSelectable(machine.state),
  );
  const cantRunHere =
    machineOnly &&
    !inheritsChatSettings &&
    draft.executionTarget !== "workspace_default" &&
    !fleet.loading &&
    selectableMachines.length === 0;
  // Editing a schedule whose compute is unchanged stays possible (a rename, a
  // new cadence); only a new or changed target has to be one that can run.
  const computeChanged =
    !editing ||
    draft.runMode !== initial.runMode ||
    draft.executionTarget !== initial.executionTarget ||
    draft.machineSandboxId !== initial.machineSandboxId;
  const workspaceTarget = workspaceDefaultMachine(
    context.workspaces.find((item) => item.id === workspaceId)?.settings,
  );
  const workspaceMachine =
    workspaceTarget?.kind === "machine"
      ? scheduledMachines.find((item) => item.sandboxId === workspaceTarget.targetSandboxId)
      : null;
  const defaultMachineLabel =
    workspaceTarget?.kind === "machine"
      ? (workspaceMachine?.name ?? "Machine unavailable")
      : machineOnly
        ? "Choose a workspace default in Settings"
        : noManagedSandbox
          ? "No computer"
          : "Managed sandbox";
  const selectedComputeUnavailable =
    !inheritsChatSettings &&
    !fleet.loading &&
    (draft.executionTarget === "workspace_default"
      ? workspaceTarget?.kind === "machine"
        ? !workspaceMachine || !isMachineComputeSelectable(workspaceMachine.state)
        : machineOnly
      : draft.executionTarget === "machine" &&
        !scheduledMachines.some(
          (item) =>
            item.sandboxId === draft.machineSandboxId && isMachineComputeSelectable(item.state),
        ));
  const whereValue =
    draft.executionTarget === "workspace_default"
      ? "workspace_default"
      : draft.executionTarget === "managed"
        ? "managed"
        : draft.machineSandboxId || null;
  const whereOptions: SelectOption[] = [
    {
      value: "workspace_default",
      label: "Workspace default",
      description: defaultMachineLabel,
    },
    {
      value: "managed",
      label: noManagedSandbox ? "No computer" : "Managed sandbox",
      description: noManagedSandbox
        ? "Each run is a chat without a computer."
        : "A fresh cloud sandbox for each run.",
      leading: noManagedSandbox ? (
        <MessageSquareIcon className="size-4 text-fg-subtle" />
      ) : (
        <ServerIcon className="size-4 text-fg-subtle" />
      ),
      disabled: machineOnly,
      disabledReason: "This Opengeni server doesn't run managed sandboxes.",
    },
    ...scheduledMachines.map((machine) => ({
      value: machine.sandboxId,
      label: machine.name,
      meta: `${machine.scope === "user" ? "Your machine" : "Connected machine"}${
        machine.state === "online" ? "" : ` · ${machine.state}`
      }`,
      description:
        machine.scope === "user"
          ? "Runs on your own computer. Only you can see this automation and its chats."
          : "Runs on this computer, in its code folder.",
      leading: <LaptopIcon className="size-4 text-fg-subtle" />,
      disabled: !isMachineComputeSelectable(machine.state),
      disabledReason: "It's offline. Start Opengeni on it to pick it.",
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
    draft.executionTarget === "workspace_default"
      ? `Workspace default · ${defaultMachineLabel}`
      : draft.executionTarget === "managed"
        ? noManagedSandbox
          ? "No computer"
          : "Managed sandbox"
        : (scheduledMachines.find((machine) => machine.sandboxId === draft.machineSandboxId)
            ?.name ?? "Connected machine");

  /* ----- summaries */
  const eachRun = draft.runMode as EachRun;
  const ifStillRunning: IfStillRunning =
    draft.overlapPolicy === "skip" ? "skip" : draft.overlapPolicy === "steer" ? "steer" : "queue";
  const learningCustom = Boolean(draft.agentLearning && Object.keys(draft.agentLearning).length);
  // Secrets: shown while this schedule's agent can use secrets.
  const canListSecrets =
    hasWorkspacePermission(context.accessContext, workspaceId, "secrets:list") ||
    hasWorkspacePermission(context.accessContext, workspaceId, "variable-sets:list");
  const scheduleSecretsOn =
    !inheritsChatSettings &&
    canListSecrets &&
    !(
      secretsOffIn(draft.agentCapabilities) ??
      secretsCapabilityOff(context.workspaces.find((item) => item.id === workspaceId)?.settings)
    );
  const secretVaults = useVaults({
    client: context.client,
    workspaceId,
    enabled: scheduleSecretsOn,
  });
  const secretsSummary = scheduleSecretsOn ? scheduleSecretsSummary(draft.vaultPolicy) : null;
  const advancedSummary = [
    ...(eachRun === "new_session_per_run" ? [] : [IF_STILL_RUNNING_SUMMARY[ifStillRunning]]),
    ...(inheritsChatSettings ? [] : [whereLabel]),
    ...(secretsSummary ? [`Secrets: ${secretsSummary}`] : []),
    ...(draft.events.triggers.length > 0 && Number.isFinite(draft.events.maxRunsPerHour)
      ? [`Up to ${draft.events.maxRunsPerHour} event runs an hour`]
      : []),
    ...(eachRun === "existing_session"
      ? []
      : [learningCustom ? "Custom agent learning" : "Workspace learning defaults"]),
  ].join(" · ");

  const derivedName = deriveScheduleName(draft.prompt);

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    if (!draft.prompt.trim()) next.prompt = "Describe what the agent should do on each run.";
    if (draft.name.trim().length > NAME_MAX_LENGTH) {
      next.name = `Keep the name under ${NAME_MAX_LENGTH} characters.`;
    }
    if (draft.runMode === "existing_session" && !draft.targetSessionId) {
      next.target = "Pick the chat each run posts into.";
    }
    if (!inheritsChatSettings && draft.executionTarget === "machine" && !draft.machineSandboxId) {
      next.machine = "Pick a connected machine.";
    }
    if (
      !inheritsChatSettings &&
      draft.executionTarget === "managed" &&
      machineOnly &&
      computeChanged
    ) {
      next.machine = "This Opengeni server needs a connected machine for automations.";
    }
    if (draft.events.once && draft.events.triggers.length > 0 && cadenceRepeats(draft.cadence)) {
      next.when =
        "A run-once automation can't also repeat on a schedule. Remove the schedule or make it one time.";
    }
    return next;
  };

  const onSubmit = async () => {
    const next = validate();
    const cadenceProblem = cadenceIssue(draft.cadence, new Date());
    const triggerIssues =
      draft.events.triggers.length > 0
        ? validateEventTriggers(t, draft.events, formSources ?? [])
        : undefined;
    if (triggerIssues?.maxRunsPerHour) next.maxRunsPerHour = triggerIssues.maxRunsPerHour;
    setErrors(next);
    setEventIssues(triggerIssues);
    if (next.target || next.machine || next.maxRunsPerHour) setAdvancedOpen(true);
    if (
      Object.values(next).some(Boolean) ||
      cadenceProblem ||
      (triggerIssues && hasEventTriggerIssues(triggerIssues))
    )
      return false;
    const submitted: ScheduleDraft = {
      ...draft,
      // A trigger on this workspace's events adds the viewer's source for them.
      events: await withFriendlyError(
        "Couldn't add the event source.",
        standIns.realEvents(draft.events),
      ),
      // Pins only for connectors a person changed; everything else stays live.
      pinnedAccounts: !pinnable
        ? []
        : editing && !accountIntent.changed
          ? initial.pinnedAccounts
          : mergeSchedulePinnedAccounts(
              savedPins,
              accountSelection.selections,
              accountIntent.changedServerIds,
              {
                selectedServerIds: selectedIds,
                resources: draft.resources,
                ...(accountTargetSession ? { chat: accountTargetSession } : {}),
              },
            ),
    };
    const submitNow = new Date();
    if (editing && task) {
      const learningChanged =
        submitted.agentLearningVersion !== undefined &&
        (submitted.agentLearningDirty ||
          submitted.agentLearningDestinationKey !== scheduledLearningDestinationKey(submitted));
      await withFriendlyError(
        "Couldn't save your changes.",
        client
          .updateScheduledTask(workspaceId, task.id, {
            ...updateRequestFromDraft(task, initial, submitted, {
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
            ...(adoptSessionSettings ? { adoptSessionSettings: true as const } : {}),
          })
          .catch((error: unknown) => {
            const details = (error as { details?: Record<string, unknown> }).details;
            if (details?.code === "scheduled_target_access_change") {
              setAccessChange({
                environment: Boolean(details?.removedRigId),
              });
            }
            throw error;
          }),
      );
      toast.success("Changes saved", { description: scheduleName(submitted) });
      go.detail(task.id, { replace: true });
      return true;
    }
    const created = await withFriendlyError(
      "Couldn't create the automation.",
      client.createScheduledTask(
        workspaceId,
        createRequestFromDraft(submitted, {
          now: submitNow,
          learningScope: scheduledLearningScope(submitted, sessions, personal),
        }),
      ),
    );
    const first = nextRunOf(created, new Date());
    toast.success("Automation created", {
      description: first
        ? `First run ${runTimeLabel(first, new Date())}.`
        : hasEventTriggers(created)
          ? "It runs when a matching event arrives."
          : undefined,
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
                      description: userErrorText(error),
                    }),
                  ),
            }
          : undefined,
    });
    go.detail(created.id, { replace: true });
    return true;
  };

  // A fresh New automation offers the chat route; a duplicate or a "Make
  // recurring" launch already has its instructions.
  const offerAgent = mode.kind === "create" && !mode.from && !sourceSessionId && canAsk;

  const noAccess = editing
    ? Boolean(task && !(ownsSchedule(task, access.viewerSubjectId) && access.canManage))
    : !access.canManage;
  const submitBlocked =
    noAccess ||
    ((cantRunHere || selectedComputeUnavailable) && computeChanged) ||
    (draft.runMode !== "existing_session" && learningLoading) ||
    (draft.runMode === "existing_session" &&
      (!sessions.some((session) => session.id === draft.targetSessionId) ||
        (accessChange && !adoptSessionSettings))) ||
    pinsNeedChat ||
    (pinningAccounts &&
      (connectionAccounts.loading || Boolean(connectionAccounts.error) || requiresAccountChoice));
  const blockedReason = noAccess
    ? editing && task && !ownsSchedule(task, access.viewerSubjectId)
      ? "Only the automation's owner can change it. Duplicate it to make your own."
      : "You need permission to manage automations in this workspace."
    : selectedComputeUnavailable && computeChanged
      ? "Machine unavailable. Choose another machine or update the workspace default."
      : cantRunHere && computeChanged
        ? "Connect a machine first. This Opengeni server can't run automations without one."
        : pinningAccounts && requiresAccountChoice
          ? (accountChoiceMessage ?? "Pick an account for each tool.")
          : (draft.runMode !== "existing_session" && learningLoading) ||
              (pinningAccounts && connectionAccounts.loading)
            ? "Loading this automation's settings…"
            : pinningAccounts && connectionAccounts.error
              ? connectionAccounts.accessDenied
                ? "You can't see this workspace's connected accounts. Ask a workspace admin."
                : "Connected accounts couldn't load. Try again."
              : draft.runMode === "existing_session" &&
                  !sessions.some((session) => session.id === draft.targetSessionId)
                ? "Choose an available chat."
                : pinsNeedChat
                  ? "Chat settings couldn't load. Reload before changing accounts."
                  : accessChange && !adoptSessionSettings
                    ? "Review the destination chat’s attachments before saving."
                    : undefined;

  const selectedSession = sessions.find((session) => session.id === draft.targetSessionId);
  const sessionOptions: SelectOption[] = [
    ...(draft.targetSessionId && !selectedSession
      ? [
          {
            value: draft.targetSessionId,
            label: sessionsLoading
              ? "Loading chat…"
              : sessionsError
                ? "Chat couldn’t load"
                : "The chosen chat is unavailable",
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
    <>
      <FormPage
        title={editing ? "Edit automation" : "New automation"}
        description={
          editing ? (
            task?.name
          ) : offerAgent ? (
            <>
              Rather describe it? <HelpLink onClick={ask.open}>Create with Opengeni</HelpLink>
            </>
          ) : undefined
        }
        submitLabel={editing ? "Save changes" : "Create automation"}
        pendingLabel={editing ? "Saving…" : "Creating…"}
        submitAnalyticsAction={editing ? null : "create_schedule"}
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
                  ? "This automation can't run here yet"
                  : "Automations need a connected machine here"
              }
              actionLayout="responsive"
              action={
                <Button asChild size="sm" className="pointer-coarse:h-11">
                  <Link to="/workspaces/$workspaceId/machines" params={{ workspaceId }}>
                    Connect a machine
                  </Link>
                </Button>
              }
            >
              This Opengeni server doesn't run managed sandboxes, and no machine that can run is
              connected to this workspace yet.
            </Notice>
          ) : null}
          <Field label="Chat">
            <SelectMenu
              value={eachRun}
              onValueChange={(runMode) => update({ runMode: runMode as EachRun })}
              options={[
                {
                  value: "existing_session",
                  label: "Use an existing chat",
                  description: "Continue a conversation with its current settings.",
                  disabled: !access.canTargetSessions,
                  disabledReason: "You need permission to open chats in this workspace.",
                },
                {
                  value: "reusable_session",
                  label: savedReusableSessionId
                    ? "Use this automation's chat"
                    : "Create a chat for this automation",
                  description: "Keep the results together in one conversation.",
                },
                {
                  value: "new_session_per_run",
                  label: "Create a chat each run",
                  description: "Start each run with a fresh conversation.",
                },
              ]}
              className="max-w-full"
            />
            {materializedSessionId ? (
              <p className="m-0 text-xs leading-4.5 text-fg-muted">
                {access.canTargetSessions ? (
                  <Link
                    className="underline underline-offset-2"
                    to="/workspaces/$workspaceId/sessions/$sessionId"
                    params={{ workspaceId, sessionId: materializedSessionId }}
                  >
                    Open this automation's chat
                  </Link>
                ) : (
                  "Open this automation's chat"
                )}{" "}
                to change its model, tools or machine.
              </p>
            ) : null}
          </Field>
          {eachRun === "existing_session" ? (
            <Field label="Send to" error={errors.target}>
              <SelectMenu
                variant={sessionOptions.length > 8 ? "combobox" : "menu"}
                options={sessionOptions}
                value={draft.targetSessionId || null}
                onValueChange={(sessionId) => update({ targetSessionId: sessionId })}
                placeholder={
                  sessionsLoading
                    ? "Loading chats…"
                    : sessions.length
                      ? "Choose a chat"
                      : "No chats available"
                }
                searchPlaceholder="Search recent chats"
                loading={sessionsLoading && sessions.length === 0}
                disabled={!access.canTargetSessions}
                disabledReason="You need permission to open chats in this workspace."
                invalid={Boolean(errors.target)}
                className="max-w-full"
              />
              {sessionsError && isPermissionDenied(sessionsError) ? (
                <p className="m-0 text-sm text-fg-muted">
                  You need permission to open chats in this workspace. Ask a workspace admin.
                </p>
              ) : sessionsError ? (
                <ErrorMessage
                  variant="inline"
                  title="Chats couldn't load"
                  {...apiErrorDetails(sessionsError)}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSessionsRetry((value) => value + 1)}
                    >
                      Try again
                    </Button>
                  }
                />
              ) : null}
              {accessChange ? (
                <div
                  ref={accessReview}
                  tabIndex={-1}
                  role="group"
                  aria-label="Review destination attachments"
                  className="outline-none"
                >
                  <CheckboxField
                    label="Use this chat's attachments"
                    description={
                      <>
                        The previous environment will no longer apply.{" "}
                        <Link
                          className="underline underline-offset-2"
                          to="/workspaces/$workspaceId/sessions/$sessionId"
                          target="_blank"
                          rel="noreferrer"
                          params={{
                            workspaceId,
                            sessionId: draft.targetSessionId,
                          }}
                        >
                          Open the destination chat
                        </Link>{" "}
                        to review its attachments.
                      </>
                    }
                    checked={adoptSessionSettings}
                    onCheckedChange={setAdoptSessionSettings}
                  />
                </div>
              ) : null}
            </Field>
          ) : null}
          {showAudience ? (
            <Field
              label="Who can see it"
              hint={
                draft.visibility === "private"
                  ? `${privateReason ? `${privateReason.slice(0, -1)}, so only` : "Only"} you can see this automation and its chats. Admins can see that it exists, what it costs, and pause it.`
                  : "Everyone in this workspace can see this automation and its chats."
              }
            >
              <FieldSegmented<"workspace" | "private">
                value={draft.visibility}
                onValueChange={(visibility) => {
                  audienceChosenRef.current = true;
                  update({ visibility });
                }}
                options={[
                  {
                    value: "workspace",
                    label: "Workspace",
                    icon: <UsersIcon aria-hidden="true" />,
                    disabled: privateReason !== null,
                    ...(privateReason ? { disabledReason: privateReason } : {}),
                  },
                  {
                    value: "private",
                    label: "Only me",
                    icon: <LockIcon aria-hidden="true" />,
                    disabled: canCreatePrivate === false && draft.visibility !== "private",
                    disabledReason: "Only me is turned off for this organization.",
                  },
                ]}
              />
            </Field>
          ) : null}
          <Field
            label="Message"
            error={errors.prompt}
            hint={
              needsRepositories
                ? "Sent to the agent on each run, with the events that started it. A run can only open the repositories added here, so add the ones it works on."
                : draft.events.triggers.length > 0
                  ? "Sent to the agent on each run, with the events that started it."
                  : "Sent to the agent each time it runs."
            }
          >
            <ComposerField
              workspaceId={workspaceId}
              draft={draft}
              update={update}
              modelRows={modelCatalog.rows}
              defaultModelSelection={modelCatalog.defaultSelection}
              modelsLoading={modelCatalog.loading}
              modelsError={modelCatalog.error}
              existingChat={draft.runMode === "existing_session"}
              inheritsChatSettings={inheritsChatSettings}
            />
          </Field>
          {inheritsChatSettings ? (
            <Disclosure
              title="Uses this chat’s settings"
              summary="Model, tools, accounts and machine"
            >
              <p className="text-sm text-fg-muted">
                Each run uses the chat’s current model, tools, accounts and machine. Changes apply
                to the chat and its automated runs.
              </p>
              {targetSessionId ? (
                <Link
                  className="og-link text-sm"
                  to="/workspaces/$workspaceId/sessions/$sessionId"
                  params={{ workspaceId, sessionId: targetSessionId }}
                >
                  Open chat settings
                </Link>
              ) : (
                <p className="text-sm text-fg-muted">Choose a chat to view its settings.</p>
              )}
            </Disclosure>
          ) : null}
          <AutomationWhenField
            cadence={draft.cadence}
            onCadenceChange={(cadence) => update({ cadence })}
            events={draft.events}
            onEventsChange={(events) => update({ events })}
            eventTriggers={eventTriggers}
            sources={formSources}
            loadEventTypes={standIns.loadEventTypes}
            eventIssues={eventIssues}
            error={errors.when}
            sourceLogo={sourceLogo}
            onAddSource={(choice) => go.newSource(choice)}
            frequencies={SCHEDULE_FREQUENCIES}
            now={now}
          />
          <Field label="Name" optional error={errors.name} hint="Shown in the automations list.">
            <TextInput
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder={derivedName || "Named after the instructions"}
              suppressAutofill
            />
          </Field>
          <Disclosure
            variant="row"
            title="Settings"
            summary={advancedSummary}
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
          >
            <FieldStack>
              {connectionAccounts.accountGroups.length > 0 || connectionAccounts.error ? (
                <div className="flex min-w-0 flex-col gap-2">
                  <ConnectionAccountPicker
                    groups={connectionAccounts.accountGroups}
                    choices={accountChoices}
                    onChoose={(serverId, ids) => {
                      setEditedAccountServerIds((current) =>
                        current.includes(serverId) ? current : [...current, serverId],
                      );
                      connectionAccounts.selectAccount(serverId, ids);
                    }}
                  />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="min-w-0 text-xs text-fg-muted">
                      {pinnedGroupNames.length > 0
                        ? `Pinned for ${pinnedGroupNames.join(", ")}. Other connectors use your current accounts each run.`
                        : "Each run uses your current accounts. Changing one here pins it."}
                    </p>
                    {pinnedGroupNames.length > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={usePinnedAccountsDefaults}
                      >
                        Use current accounts
                      </Button>
                    ) : null}
                  </div>
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
              {!inheritsChatSettings ? (
                <ScheduleAgentCapabilities
                  bare
                  workspaceId={workspaceId}
                  value={draft.agentCapabilities}
                  onChange={(agentCapabilities) =>
                    setDraft((previous) => {
                      if (agentCapabilities !== undefined)
                        return { ...previous, agentCapabilities };
                      const { agentCapabilities: _dropped, ...rest } = previous;
                      return rest;
                    })
                  }
                />
              ) : null}

              {eachRun !== "new_session_per_run" ? (
                <Field
                  label="If the previous run is still working"
                  hint={IF_STILL_RUNNING_HINT[ifStillRunning]}
                >
                  <FieldSegmented<IfStillRunning>
                    value={ifStillRunning}
                    onValueChange={(value) =>
                      update({
                        overlapPolicy: value === "queue" ? "allow_concurrent" : value,
                      })
                    }
                    options={[
                      { value: "steer", label: "Steer" },
                      { value: "queue", label: "Queue" },
                      { value: "skip", label: "Skip" },
                    ]}
                  />
                </Field>
              ) : null}
              {draft.events.triggers.length > 0 ? (
                <Field
                  label="Event runs per hour"
                  error={errors.maxRunsPerHour}
                  hint="At most this many runs start from events in an hour. Events past that wait and arrive together in the next run, and you're told once."
                >
                  <TextInput
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={runsPerHourText}
                    onChange={(event) => {
                      const text = event.target.value;
                      setRunsPerHourText(text);
                      update({
                        events: {
                          ...draft.events,
                          maxRunsPerHour: /^\d+$/u.test(text.trim())
                            ? Number(text.trim())
                            : Number.NaN,
                        },
                      });
                    }}
                    className="w-24"
                    suppressAutofill
                  />
                </Field>
              ) : null}
              {!inheritsChatSettings ? (
                <Field
                  label="Where it runs"
                  error={errors.machine}
                  hint={
                    selectedComputeUnavailable
                      ? "Machine unavailable. Choose a replacement or reconnect it."
                      : draft.executionTarget === "workspace_default"
                        ? `Currently: ${defaultMachineLabel}. Follows changes to the workspace default.`
                        : undefined
                  }
                >
                  <SelectMenu
                    options={whereOptions}
                    value={whereValue}
                    onValueChange={(value) =>
                      value === "workspace_default"
                        ? update({ executionTarget: "workspace_default" })
                        : value === "managed"
                          ? update({
                              executionTarget: "managed",
                              sandboxBackend:
                                context.clientConfig.defaultSandboxBackend === "selfhosted"
                                  ? ""
                                  : (context.clientConfig.defaultSandboxBackend ?? ""),
                            })
                          : update({
                              executionTarget: "machine",
                              machineSandboxId: value,
                            })
                    }
                    placeholder={fleet.loading ? "Loading machines…" : "Pick where it runs"}
                    loading={fleet.loading && scheduledMachines.length === 0 && machineOnly}
                    invalid={Boolean(errors.machine)}
                    className="max-w-[360px]"
                  />
                </Field>
              ) : null}
              {!inheritsChatSettings &&
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
              {fleet.error && !inheritsChatSettings ? (
                <p className="-mt-3 text-xs leading-4.5 text-danger">
                  Connected machines couldn't load. Refresh the page and try again.
                </p>
              ) : null}
              {scheduleSecretsOn ? (
                <ScheduleSecretsField
                  value={draft.vaultPolicy}
                  onChange={(vaultPolicy) =>
                    setDraft((previous) => {
                      const { vaultPolicy: _previous, ...rest } = previous;
                      return vaultPolicy ? { ...rest, vaultPolicy } : rest;
                    })
                  }
                  vaults={secretVaults.vaults}
                  loading={secretVaults.loading}
                  error={secretVaults.error}
                  ownerIsViewer={!editing || !task || ownsSchedule(task, access.viewerSubjectId)}
                />
              ) : null}
              {eachRun === "existing_session" ? null : learningLoading ? (
                <p role="status" className="m-0 text-sm text-fg-muted">
                  Loading this automation's agent learning settings…
                </p>
              ) : learningError && isPermissionDenied(learningError) ? (
                <p className="m-0 text-sm text-fg-muted">
                  You can't see this automation's agent learning settings. You can still save other
                  changes.
                </p>
              ) : learningError ? (
                <ErrorMessage
                  variant="inline"
                  title="Agent learning settings couldn't load. You can still save other changes."
                  {...apiErrorDetails(learningError)}
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
      {ask.dialog}
    </>
  );
}

/**
 * Server errors read as what happened and what to do inside the form, never
 * "Opengeni API 422: …". A short validation sentence from the server is kept.
 */
async function withFriendlyError<T>(lead: string, request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    // FormPage separates API advice from its technical details. Keep the
    // structured error intact so request IDs never enter the main message.
    if (isApiError(error)) throw error;
    throw new Error(`${lead} ${userErrorText(error)}`, { cause: error });
  }
}
