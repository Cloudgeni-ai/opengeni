/**
 * "Add trigger" on an agent's page: when the agent starts (an event or a
 * schedule) and, optionally, what each run says, in one small dialog. A
 * suggested trigger arrives filled in and asks only for what it lacks: the
 * source it listens on and, for GitHub, a repository. It saves an ordinary
 * automation shared like the agent; "Open full form" keeps every setting.
 */
import { useEffect, useMemo, useState } from "react";
import { GitBranchIcon } from "lucide-react";
import type {
  Agent,
  AgentTemplateTrigger,
  EventSource,
  ReadyEventSource,
  ScheduledTask,
} from "@opengeni/sdk";

import { AutomationWhenField } from "../../../components/automations/automation-when-field";
import {
  automationTemplateSourceChoice,
  eventSourceFitsTemplate,
} from "../../../components/automations/automation-template-model";
import { EventTriggersField } from "../../../components/automations/event-trigger-editor";
import {
  eventSourceAddLabel,
  eventSourceChoiceName,
  type EventSourceChoice,
} from "../../../components/automations/event-source-model";
import { useEventSourceStandIns } from "../../../components/automations/event-source-stand-ins";
import { eventSourceLogoResolver } from "../../../components/automations/event-source-tile";
import { eventTypesLabel } from "../../../components/automations/event-trigger-model";
import type { AutomationDraft } from "../../../components/automations/automation-model";
import { Field, FieldStack, TextArea } from "../../../ui/field";
import { FormDialog } from "../../../ui/form-dialog";
import { SegmentedControl } from "../../../ui/segmented-control";
import { SelectMenu, type SelectOption } from "../../../ui/select-menu";
import { useAppContext } from "../../app-context";
import { t } from "../../lib/console-text";
import { gitHubRepositoryResource } from "../../lib/session-tools";
import {
  agentTriggerCreateRequest,
  agentTriggerDraft,
  agentTriggerDraftOfKind,
  agentTriggerIssues,
  agentTriggerMessage,
  agentTriggerMissingSource,
  agentTriggerSaveError,
  agentTriggerWithSources,
  type AgentTriggerKind,
} from "./agent-trigger-model";

const NO_REPOSITORY = "__none__";

export interface AgentTriggerDialogProps {
  agent: Agent;
  workspaceId: string;
  /** A suggested trigger to start from; undefined starts blank. */
  suggestion?: AgentTemplateTrigger | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The automation it saved. */
  onCreated: (task: ScheduledTask) => void;
  /** The full New automation form, for settings this dialog doesn't show. */
  onOpenFullForm: () => void;
  /** The "Add a source" page, at the kind a suggestion needs. */
  onAddSource: (choice?: EventSourceChoice) => void;
}

export function AgentTriggerDialog(props: AgentTriggerDialogProps) {
  // Each opening starts again from the suggestion, and nothing is read while closed.
  if (!props.open) return null;
  return <FormDialogBody key={props.suggestion?.name ?? ""} {...props} />;
}

/** Where events don't run: no sources, the same array every render. */
const NO_SOURCES: EventSource[] = [];

function FormDialogBody({
  agent,
  workspaceId,
  suggestion,
  open,
  onOpenChange,
  onCreated,
  onOpenFullForm,
  onAddSource,
}: AgentTriggerDialogProps) {
  const context = useAppContext();
  const { client } = context;
  const eventTriggers = context.clientConfig?.eventTriggers?.enabled === true;
  const sources = useTriggerSources(workspaceId, eventTriggers);
  const standIns = useEventSourceStandIns({
    client,
    workspaceId,
    sources: eventTriggers ? sources.sources : NO_SOURCES,
    readySources: sources.ready,
    workspaceEvents: eventTriggers,
  });
  const formSources = standIns.sources;
  const sourceLogo = useMemo(
    () =>
      eventSourceLogoResolver(context.workspaceCapabilityCatalog ?? [], (path) =>
        client.catalogAssetUrl(path),
      ),
    [client, context.workspaceCapabilityCatalog],
  );
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    agentTriggerDraft(suggestion, { eventTriggers }),
  );
  // A suggestion's triggers take the person's own source once sources load.
  const [filledFrom, setFilledFrom] = useState<EventSource[] | undefined>(undefined);
  if (formSources !== filledFrom) {
    setFilledFrom(formSources);
    const events = agentTriggerWithSources(draft.events, formSources);
    if (events !== draft.events) setDraft({ ...draft, events });
  }
  const kind: AgentTriggerKind = draft.events.triggers.length > 0 ? "event" : "schedule";
  const [showEvents, setShowEvents] = useState(!suggestion);
  const [issues, setIssues] = useState<ReturnType<typeof agentTriggerIssues>>({});
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<AutomationDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setIssues({});
    setError(null);
  };

  // A GitHub event's run can open only the repositories it is given.
  const listensOnGitHub = draft.events.triggers.some(
    (trigger) =>
      formSources?.find((source) => source.id === trigger.sourceId)?.kind === "github" ||
      (!trigger.sourceId && trigger.templateSource?.kind === "github"),
  );
  const repositories = context.githubRepos ?? [];
  const [repositoryId, setRepositoryId] = useState<string>(NO_REPOSITORY);
  const repository = repositories.find((repo) => String(repo.id) === repositoryId);
  const repositoryOptions: SelectOption[] = [
    { value: NO_REPOSITORY, label: "None" },
    ...repositories.map((repo) => ({
      value: String(repo.id),
      label: repo.fullName,
      leading: <GitBranchIcon className="size-3.5 text-fg-subtle" />,
    })),
  ];

  // With no source of the kind it needs, adding one is the one thing to do.
  const missing = kind === "event" ? agentTriggerMissingSource(draft, formSources) : undefined;
  const noSources = kind === "event" && formSources !== undefined && formSources.length === 0;
  const addSourceChoice = missing ? automationTemplateSourceChoice(missing) : undefined;
  const addingSource = Boolean(missing) || noSources;
  const visibility = agent.visibility === "private" ? "private" : "workspace";

  const submit = async (): Promise<boolean> => {
    if (addingSource) {
      onOpenChange(false);
      onAddSource(addSourceChoice);
      return false;
    }
    const now = new Date();
    const found = agentTriggerIssues(t, draft, formSources ?? [], now);
    if (Object.values(found).some(Boolean)) {
      setIssues(found);
      if (found.events && kind === "event") setShowEvents(true);
      return false;
    }
    try {
      const ready = { ...draft, events: await standIns.realEvents(draft.events) };
      const created = await client.createScheduledTask(
        workspaceId,
        agentTriggerCreateRequest(t, {
          agent,
          suggestion,
          draft: ready,
          resources:
            repository && listensOnGitHub ? [gitHubRepositoryResource(repository, "")] : [],
          sources: formSources ?? [],
          now,
        }),
      );
      onCreated(created);
      return true;
    } catch (caught) {
      setError(agentTriggerSaveError(caught, visibility));
      return false;
    }
  };

  const eventsEditor = (
    <EventTriggersField
      value={draft.events}
      onChange={(events) => update({ events })}
      sources={formSources}
      loadEventTypes={standIns.loadEventTypes}
      issues={issues.events}
      sourceLogo={sourceLogo}
      onAddSource={(choice) => {
        onOpenChange(false);
        onAddSource(choice);
      }}
      allowOnce={false}
    />
  );
  const whenError = issues.when ?? issues.cadence;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={suggestion ? suggestion.name : "Add trigger"}
      description={
        visibility === "private"
          ? `Each run starts a chat with ${agent.name}. Only you see it.`
          : `Each run starts a chat with ${agent.name}, shared with the workspace.`
      }
      submitLabel={
        addingSource
          ? addSourceChoice
            ? eventSourceAddLabel(t, addSourceChoice)
            : "Add a source"
          : "Add trigger"
      }
      pendingLabel="Adding…"
      onSubmit={submit}
      error={error ?? undefined}
      footerStart={
        <button
          type="button"
          className="og-link text-xs"
          data-agent-trigger-full-form=""
          onClick={() => {
            onOpenChange(false);
            onOpenFullForm();
          }}
        >
          Open full form
        </button>
      }
    >
      <FieldStack>
        {suggestion ? null : eventTriggers ? (
          <Field label="Starts" group>
            <SegmentedControl
              options={[
                { value: "event", label: "On an event" },
                { value: "schedule", label: "On a schedule" },
              ]}
              value={kind}
              onValueChange={(next) => update(agentTriggerDraftOfKind(next, draft, formSources))}
              fullWidth
            />
          </Field>
        ) : null}
        {kind === "schedule" ? (
          <AutomationWhenField
            cadence={draft.cadence}
            onCadenceChange={(cadence) => update({ cadence })}
            events={draft.events}
            onEventsChange={(events) => update({ events })}
            eventTriggers={false}
            sources={formSources}
            loadEventTypes={standIns.loadEventTypes}
            error={whenError}
          />
        ) : showEvents ? (
          <div className="flex min-w-0 flex-col gap-2">
            {eventsEditor}
            {whenError ? (
              <p role="alert" className="m-0 text-xs text-danger">
                {whenError}
              </p>
            ) : null}
          </div>
        ) : (
          <SuggestedSources
            draft={draft}
            sources={formSources}
            missingLabel={
              addSourceChoice
                ? `It listens to ${eventSourceChoiceName(t, addSourceChoice)}, which isn't connected here yet.`
                : undefined
            }
            onChange={(events) => update({ events })}
            onEdit={() => setShowEvents(true)}
            sourceIssue={issues.events ? "Choose a source." : undefined}
          />
        )}
        {listensOnGitHub && repositories.length > 0 && !addingSource ? (
          <Field label="Repository" optional hint="Each run can open it.">
            <SelectMenu
              variant={repositoryOptions.length > 8 ? "combobox" : "menu"}
              options={repositoryOptions}
              value={repositoryId}
              onValueChange={setRepositoryId}
              searchPlaceholder="Search repositories"
              className="max-w-full"
            />
          </Field>
        ) : null}
        {addingSource ? null : (
          <Field label="Message" optional hint="What each run asks the agent to do.">
            <TextArea
              rows={3}
              value={draft.instructions}
              onChange={(event) => update({ instructions: event.target.value })}
              placeholder={agentTriggerMessage({ instructions: "", events: draft.events })}
            />
          </Field>
        )}
      </FieldStack>
    </FormDialog>
  );
}

/** A suggestion's triggers, each asking only which source it listens on. */
function SuggestedSources({
  draft,
  sources,
  missingLabel,
  onChange,
  onEdit,
  sourceIssue,
}: {
  draft: AutomationDraft;
  sources: EventSource[] | undefined;
  missingLabel: string | undefined;
  onChange: (events: AutomationDraft["events"]) => void;
  onEdit: () => void;
  sourceIssue: string | undefined;
}) {
  if (missingLabel) {
    return (
      <p data-agent-trigger-missing-source="" className="m-0 text-sm leading-5 text-fg-muted">
        {missingLabel}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {draft.events.triggers.map((trigger, index) => {
        const wanted = trigger.templateSource;
        const fitting = (sources ?? []).filter(
          (source) =>
            source.id === trigger.sourceId || !wanted || eventSourceFitsTemplate(wanted, source),
        );
        return (
          <Field
            key={trigger.key}
            label={draft.events.triggers.length > 1 ? `Source ${index + 1}` : "Source"}
            hint={eventTypesLabel(t, trigger.eventTypes)}
            error={!trigger.sourceId ? sourceIssue : undefined}
          >
            <SelectMenu
              options={fitting.map((source) => ({ value: source.id, label: source.name }))}
              value={trigger.sourceId || null}
              onValueChange={(sourceId) =>
                onChange({
                  ...draft.events,
                  triggers: draft.events.triggers.map((entry) =>
                    entry.key === trigger.key ? { ...entry, sourceId } : entry,
                  ),
                })
              }
              placeholder="Choose a source"
              loading={sources === undefined}
              className="max-w-full"
            />
          </Field>
        );
      })}
      <div>
        <button type="button" className="og-link text-sm" onClick={onEdit}>
          Change events
        </button>
      </div>
    </div>
  );
}

/** The person's event sources and the ones they can use without adding, read while open. */
function useTriggerSources(
  workspaceId: string,
  enabled: boolean,
): { sources: EventSource[] | undefined; ready: ReadyEventSource[] | undefined } {
  const { client } = useAppContext();
  const [sources, setSources] = useState<EventSource[] | undefined>(undefined);
  const [ready, setReady] = useState<ReadyEventSource[] | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.listEventSources(workspaceId).then(
      (list) => live && setSources(list),
      () => live && setSources((current) => current ?? []),
    );
    client.listReadyEventSources(workspaceId).then(
      (list) => live && setReady(list),
      () => live && setReady((current) => current ?? []),
    );
    return () => {
      live = false;
    };
  }, [client, enabled, workspaceId]);
  return { sources, ready };
}
