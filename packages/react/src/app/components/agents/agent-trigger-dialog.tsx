/**
 * "Add trigger" on an agent's page (docs/agents.md, When it works): outcomes
 * first (an issue gets a label, a pull request opens, on a schedule, someone
 * mentions it), each saved like a suggested trigger; a schedule can open a
 * repository on each run. "Other events" opens the source picker, which comes from the source
 * catalog (`agentTriggerOptions`): a schedule, the person's sources and every
 * kind they can still add. A kind not added yet shows its setup step right
 * here: Opengeni adds GitHub, Slack or This workspace in place, a webhook is
 * created in place and shows its URL, an app's webhook (Linear, Sentry,
 * Tailscale or another app) is created in place and takes the secret that app shows (one field, kept
 * only on the server and never shown again), GitHub not yet connected makes
 * Connect GitHub the one action, and any other kind (Gmail's mailbox, an MCP
 * server) opens Add a source. A suggested
 * trigger arrives filled in and asks only for what it lacks. The note is
 * optional: each run gets the event and the agent's Instructions do the rest.
 * It saves an ordinary automation shared like the agent; each run starts a
 * new chat with the agent (the server's rule for an agent's automations).
 * "Open full form" opens the automation form at the suggestion, or at the
 * source picked, with the note and chat choice. Its Cancel and Save come
 * back here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  AgentTemplateTrigger,
  AutomationTemplateEventSource,
  EventSource,
  ReadyEventSource,
  ScheduledTask,
} from "@opengeni/sdk";

import { AutomationWhenField } from "../../../components/automations/automation-when-field";
import { automationCadenceWords } from "../../../components/automations/automation-model";
import { ChoiceCard, ChoiceCards } from "../../../ui/choice-cards";
import {
  automationTemplateSourceChoice,
  eventSourceFitsTemplate,
} from "../../../components/automations/automation-template-model";
import { EventTriggersField } from "../../../components/automations/event-trigger-editor";
import {
  createEventSourceRequest,
  eventSourceAddLabel,
  eventSourceChoiceName,
  eventSourceChoices,
  pastedWebhookSetup,
  type EventSourceChoice,
} from "../../../components/automations/event-source-model";
import { useEventSourceStandIns } from "../../../components/automations/event-source-stand-ins";
import {
  EventSourceTile,
  eventSourceLogoResolver,
} from "../../../components/automations/event-source-tile";
import { eventTypesLabel } from "../../../components/automations/event-trigger-model";
import { PastedWebhookSteps } from "../../../components/automations/pasted-webhook-steps";
import type { AutomationDraft } from "../../../components/automations/automation-model";
import { CopyField } from "../../../ui/copy-field";
import { Field, FieldStack, TextArea, TextInput } from "../../../ui/field";
import { FormDialog } from "../../../ui/form-dialog";
import { Notice } from "../../../ui/notice";
import { SelectMenu } from "../../../ui/select-menu";
import { apiErrorFacts, isApiError, userErrorText } from "../../../ui/api-error";
import { useAppContext } from "../../app-context";
import { t } from "../../lib/console-text";
import { githubConnectedOf, githubConnectHref } from "../../lib/github-connect";
import { useNavigate } from "../../lib/navigation";
import {
  agentTriggerAwaitsSecret,
  agentTriggerCreateRequest,
  agentTriggerRepositoryEvents,
  AGENT_TRIGGER_CHAT_REPOSITORIES_MAX,
  agentTriggerDraftForPick,
  agentTriggerDraftFromSuggestion,
  agentTriggerIssues,
  agentTriggerMessage,
  agentTriggerMissingSource,
  agentTriggerOptions,
  agentTriggerPickKey,
  agentTriggerSaveError,
  agentTriggerSecretIssue,
  agentTriggerSourceStep,
  agentTriggerWithSources,
  agentTriggerChatWords,
  AGENT_TRIGGER_NEW_CHAT,
  type AgentTriggerChat,
  type AgentTriggerOption,
  type AgentTriggerPick,
  type AgentTriggerSetup,
} from "./agent-trigger-model";
import { AgentTriggerPicker } from "./agent-trigger-picker";
import { AgentTriggerRepositories } from "./agent-trigger-repositories";
import { gitHubRepositoryResource } from "../../lib/session-tools";
import { AgentTriggerChatField } from "./agent-trigger-chat-field";
import {
  AGENT_TRIGGER_DEFAULT_LABEL,
  agentTriggerConfirmation,
  agentTriggerOutcomeCards,
  agentTriggerOutcomeSuggestion,
  agentTriggerSentence,
  agentTriggerShapeOfSuggestion,
  type AgentTriggerOutcome,
} from "./agent-trigger-words";

// The one-click add beside the dialog, for pages outside this package (Get started).
export { addAgentSuggestedTrigger, agentTriggerSaveError } from "./agent-trigger-model";
export { agentTriggerRunsAs } from "./agent-trigger-words";

export interface AgentTriggerDialogProps {
  agent: Agent;
  workspaceId: string;
  /** A suggested trigger to start from; undefined starts at the picker. */
  suggestion?: AgentTemplateTrigger | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The automation it saved. */
  onCreated: (task: ScheduledTask) => void;
  /**
   * The full New automation form, for settings this dialog doesn't show,
   * starting at the source picked here when there is one, with the note and
   * chat choice.
   */
  onOpenFullForm: (start: {
    sourceId?: string | undefined;
    note?: string | undefined;
    chat?: AgentTriggerChat | undefined;
  }) => void;
  /** The "Add a source" page, at the kind a trigger needs. */
  onAddSource: (choice?: EventSourceChoice) => void;
}

export function AgentTriggerDialog(props: AgentTriggerDialogProps) {
  // Each opening starts again, and nothing is read while closed.
  if (!props.open) return null;
  return <AgentTriggerDialogBody key={props.suggestion?.name ?? ""} {...props} />;
}

/** Where events don't run: no sources, the same array every render. */
const NO_SOURCES: EventSource[] = [];

function AgentTriggerDialogBody({
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
  const navigate = useNavigate();
  const eventTriggers = context.clientConfig?.eventTriggers?.enabled === true;
  const githubConnected = githubConnectedOf(context.githubStatus?.status);
  const visibility = agent.visibility === "private" ? "private" : "workspace";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // The person's sources, with the ones added here.
  const loaded = useTriggerSources(workspaceId, eventTriggers);
  const [added, setAdded] = useState<EventSource[]>([]);
  const mine = useMemo(() => {
    if (!eventTriggers) return NO_SOURCES;
    // A source added before the list arrives is shown at once.
    if (!loaded.sources) return added.length > 0 ? added : undefined;
    if (added.length === 0) return loaded.sources;
    // A source changed here (its secret set) replaces the one read on opening.
    const current = loaded.sources.map(
      (source) => added.find((entry) => entry.id === source.id) ?? source,
    );
    const extra = added.filter((source) => !loaded.sources!.some((s) => s.id === source.id));
    return [...current, ...extra];
  }, [added, eventTriggers, loaded.sources]);
  const standIns = useEventSourceStandIns({
    client,
    workspaceId,
    sources: mine,
    readySources: loaded.ready,
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
  const options = useMemo(
    () =>
      agentTriggerOptions(t, {
        choices: eventSourceChoices(t),
        sources: formSources,
        eventTriggers,
        githubConnected,
      }),
    [eventTriggers, formSources, githubConnected],
  );

  // Without a suggestion it starts at the outcomes; only a schedule needs no pick.
  const [pick, setPick] = useState<AgentTriggerPick | null>(() =>
    suggestion || eventTriggers ? null : { kind: "schedule" },
  );
  // What should start it, outcome first; "other" opens the source picker.
  const [outcome, setOutcome] = useState<AgentTriggerOutcome | "other" | null>(() =>
    suggestion ? null : eventTriggers ? null : "schedule",
  );
  const [label, setLabel] = useState(AGENT_TRIGGER_DEFAULT_LABEL);
  // The repository a scheduled run opens, `owner/name`; none opens none.
  const [scheduleRepository, setScheduleRepository] = useState<string | null>(null);
  const outcomeSuggestion =
    outcome && outcome !== "schedule" && outcome !== "other"
      ? (agentTriggerOutcomeSuggestion(outcome, { agentName: agent.name, label }) ?? undefined)
      : undefined;
  // The suggestion the dialog was opened at, or the one an outcome stands for.
  const activeSuggestion = suggestion ?? outcomeSuggestion;
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    suggestion
      ? agentTriggerDraftFromSuggestion(suggestion, { timeZone })
      : agentTriggerDraftForPick({ kind: "schedule" }, { timeZone }),
  );
  // Triggers still waiting for a source take the person's own once sources load.
  const [filledFrom, setFilledFrom] = useState<EventSource[] | undefined>(undefined);
  if (formSources !== filledFrom) {
    setFilledFrom(formSources);
    const events = agentTriggerWithSources(draft.events, formSources);
    if (events !== draft.events) setDraft({ ...draft, events });
  }
  const [showEvents, setShowEvents] = useState(false);
  const [webhook, setWebhook] = useState<{
    sourceId: string;
    url: string;
    secret?: string | undefined;
  } | null>(null);
  const [issues, setIssues] = useState<ReturnType<typeof agentTriggerIssues>>({});
  const [chat, setChat] = useState<AgentTriggerChat>(AGENT_TRIGGER_NEW_CHAT);
  const [chatIssue, setChatIssue] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // A pasted webhook's secret: typed here, read once on save, never kept in
  // state or shown again. The field is uncontrolled, so the value isn't
  // mirrored into the page's HTML.
  const secretField = useRef<HTMLInputElement>(null);
  // Where focus goes after the field closes: back to Replace.
  const [focusReplace, setFocusReplace] = useState(false);
  const [secretIssue, setSecretIssue] = useState<string | undefined>(undefined);
  const [replacingSecret, setReplacingSecret] = useState<string | null>(null);
  const update = (patch: Partial<AutomationDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setIssues({});
    setError(null);
  };
  const chooseOutcome = (next: AgentTriggerOutcome | "other") => {
    setOutcome(next);
    setIssues({});
    setError(null);
    setShowEvents(false);
    if (next === "schedule") {
      choose({ kind: "schedule" });
      return;
    }
    setPick(null);
    const nextSuggestion =
      next === "other"
        ? undefined
        : agentTriggerOutcomeSuggestion(next, { agentName: agent.name, label });
    if (nextSuggestion) {
      setDraft((current) => ({
        ...agentTriggerDraftFromSuggestion(nextSuggestion, { sources: formSources, timeZone }),
        instructions: current.instructions,
      }));
    }
  };
  const changeLabel = (next: string) => {
    setLabel(next);
    const nextSuggestion = agentTriggerOutcomeSuggestion("issue_labelled", {
      agentName: agent.name,
      label: next,
    });
    if (nextSuggestion) {
      const events = agentTriggerDraftFromSuggestion(nextSuggestion, {
        sources: formSources,
        timeZone,
      }).events;
      setDraft((current) => ({ ...current, events }));
    }
  };
  const choose = (next: AgentTriggerPick) => {
    setPick(next);
    setIssues({});
    setError(null);
    setSecretIssue(undefined);
    setReplacingSecret(null);
    setFocusReplace(false);
    setDraft((current) => agentTriggerDraftForPick(next, { note: current.instructions, timeZone }));
  };

  const option: AgentTriggerOption | undefined = pick
    ? options.find((entry) => entry.key === agentTriggerPickKey(pick))
    : undefined;
  const picked = Boolean(activeSuggestion) || pick !== null;
  const isSchedule = picked && pick?.kind !== "new" && draft.events.triggers.length === 0;

  // What still stands before saving: a new kind's setup, or a suggestion's missing source.
  const missing =
    activeSuggestion && !isSchedule ? agentTriggerMissingSource(draft, formSources) : undefined;
  const missingChoice = missing ? automationTemplateSourceChoice(missing) : undefined;
  const setupChoice: EventSourceChoice | undefined =
    pick?.kind === "new" ? pick.choice : missingChoice;
  const setup: AgentTriggerSetup | undefined =
    pick?.kind === "new"
      ? (option?.setup ?? "add_source")
      : missing
        ? agentTriggerSourceStep(missing, { githubConnected })
        : undefined;
  // A suggestion's GitHub, Slack or This workspace source is added when it saves.
  const setupReady = !setup || (activeSuggestion !== undefined && setup === "create");
  // A picked Linear, Sentry or other app webhook: its secret is pasted here.
  const pickedSource =
    pick?.kind === "source"
      ? formSources?.find((source) => source.id === pick.sourceId)
      : undefined;
  const pasted = pickedSource ? pastedWebhookSetup(t, pickedSource) : null;
  const awaitingSecret =
    pasted !== null &&
    (agentTriggerAwaitsSecret(pickedSource) || replacingSecret === pickedSource?.id);
  const ready = setupReady && !awaitingSecret;

  // A GitHub event's run can open only the repositories it is given.
  const isGitHubTrigger = (trigger: AutomationDraft["events"]["triggers"][number]) =>
    formSources?.find((source) => source.id === trigger.sourceId)?.kind === "github" ||
    (!trigger.sourceId && trigger.templateSource?.kind === "github");
  const listensOnGitHub = draft.events.triggers.some(isGitHubTrigger);
  const repositories = context.githubRepos ?? [];
  // Chosen `owner/name`s; none covers every repository.
  const [chosenRepositories, setChosenRepositories] = useState<string[]>([]);

  const leave = (go: () => void) => {
    onOpenChange(false);
    go();
  };
  const connectGitHub = () => leave(() => void navigate({ href: githubConnectHref(workspaceId) }));

  /** Adds a source of the chosen kind; its events can start the agent right away. */
  const addSourceHere = async (choice: EventSourceChoice) => {
    const created = await client.createEventSource(
      workspaceId,
      createEventSourceRequest(t, { choice, name: "", visibility }),
    );
    setAdded((current) => [...current, created.source]);
    return created;
  };

  const submit = async (): Promise<boolean> => {
    setError(null);
    if (!picked) {
      setIssues({ when: "Choose what starts it." });
      return false;
    }
    if (outcome === "issue_labelled" && !label.trim()) {
      setIssues({ when: "Type the label that starts it." });
      return false;
    }
    if (setup === "connect_github") {
      connectGitHub();
      return false;
    }
    if (setup === "add_source") {
      leave(() => onAddSource(setupChoice));
      return false;
    }
    if (
      pick?.kind === "new" &&
      (setup === "create" || setup === "create_webhook" || setup === "create_pasted")
    ) {
      try {
        const created = await addSourceHere(pick.choice);
        if (setup === "create_webhook" && created.source.webhookUrl) {
          setWebhook({
            sourceId: created.source.id,
            url: created.source.webhookUrl,
            secret: created.signingSecret,
          });
        }
        choose({ kind: "source", sourceId: created.source.id });
      } catch (caught) {
        setError(userErrorText(caught));
      }
      return false;
    }
    if (awaitingSecret && pickedSource && pasted) {
      const secret = secretField.current?.value ?? "";
      const issue = agentTriggerSecretIssue(secret, pasted);
      if (issue) {
        setSecretIssue(issue);
        return false;
      }
      try {
        const saved = await client.updateEventSource(workspaceId, pickedSource.id, {
          signingSecret: secret.trim(),
        });
        if (secretField.current) secretField.current.value = "";
        setAdded((current) => [...current.filter((source) => source.id !== saved.id), saved]);
        setReplacingSecret(null);
        setFocusReplace(true);
      } catch (caught) {
        // A refused value belongs on the field; anything else above it.
        if (isApiError(caught) && apiErrorFacts(caught).status === 422)
          setSecretIssue(userErrorText(caught));
        else setError(userErrorText(caught));
      }
      return false;
    }
    const now = new Date();
    const found = agentTriggerIssues(t, draft, formSources ?? [], now);
    const noChat = chat.mode === "existing_session" && !chat.sessionId;
    if (noChat) setChatIssue("Choose a chat.");
    // The Repositories field says so: a continued chat opens at most 5.
    const tooManyRepositories =
      listensOnGitHub &&
      chat.mode !== "new_session_per_run" &&
      chosenRepositories.length > AGENT_TRIGGER_CHAT_REPOSITORIES_MAX;
    if (Object.values(found).some(Boolean) || noChat || tooManyRepositories) {
      setIssues(found);
      if (found.events) setShowEvents(true);
      return false;
    }
    // A source the suggestion lacks is added first; its refusal is about the source.
    let withSource = draft.events;
    if (missing && missingChoice) {
      try {
        withSource = await withAddedSource(draft, missing, missingChoice);
      } catch (caught) {
        setError(userErrorText(caught));
        return false;
      }
    }
    try {
      const saved = {
        ...draft,
        events: await standIns.realEvents(
          agentTriggerRepositoryEvents(
            withSource,
            // A suggestion's source added just now isn't in the list yet.
            (trigger) => isGitHubTrigger(trigger) || trigger.templateSource?.kind === "github",
            listensOnGitHub ? chosenRepositories : [],
          ),
        ),
      };
      const created = await client.createScheduledTask(
        workspaceId,
        agentTriggerCreateRequest(t, {
          agent,
          suggestion: activeSuggestion,
          draft: saved,
          // A new chat per run opens the repository its event is about; a
          // continued chat keeps the chosen ones open instead.
          resources:
            listensOnGitHub && chat.mode !== "new_session_per_run"
              ? repositories
                  .filter((repo) => chosenRepositories.includes(repo.fullName))
                  .map((repo) => gitHubRepositoryResource(repo, ""))
              : // A schedule has no event to say which repository: each run opens the chosen one.
                isSchedule && scheduleRepository
                ? repositories
                    .filter((repo) => repo.fullName === scheduleRepository)
                    .map((repo) => gitHubRepositoryResource(repo, ""))
                : [],
          sources: formSources ?? [],
          now,
          chat,
        }),
      );
      onCreated(created);
      return true;
    } catch (caught) {
      setError(agentTriggerSaveError(caught, visibility));
      return false;
    }
  };

  /** Adds the source a suggestion waits for and points its triggers at it. */
  const withAddedSource = async (
    current: AutomationDraft,
    wanted: AutomationTemplateEventSource,
    choice: EventSourceChoice,
  ): Promise<AutomationDraft["events"]> => {
    const sourceId = (await addSourceHere(choice)).source.id;
    return {
      ...current.events,
      triggers: current.events.triggers.map((trigger) =>
        !trigger.sourceId && trigger.templateSource?.kind === wanted.kind
          ? { ...trigger, sourceId }
          : trigger,
      ),
    };
  };

  const whenError = issues.when ?? issues.cadence;
  const setupName = setupChoice ? eventSourceChoiceName(t, setupChoice) : "";
  const submitLabel = !setupReady
    ? setup === "connect_github"
      ? "Connect GitHub"
      : setup === "create_webhook"
        ? "Create webhook"
        : setupChoice
          ? eventSourceAddLabel(t, setupChoice)
          : "Add a source"
    : awaitingSecret && pasted
      ? `Save ${pasted.secretName}`
      : "Add trigger";
  const shownWebhook =
    webhook && pick?.kind === "source" && pick.sourceId === webhook.sourceId ? webhook : null;
  // The full form can start at a source the person has (not a stand-in).
  const fullFormSourceId =
    !activeSuggestion &&
    pick?.kind === "source" &&
    mine?.some((source) => source.id === pick.sourceId)
      ? pick.sourceId
      : undefined;

  // The sentence that confirms it: what starts the agent, who can, and whose access it uses.
  const confirmation = (() => {
    if (!picked || !ready || (suggestion && !outcome)) return null;
    const now = new Date();
    if (isSchedule) {
      if (!draft.cadence) return null;
      const words = automationCadenceWords(t, draft.cadence, now)
        .sentence.replace(/^Runs /u, "")
        .replace(/\.$/u, "");
      return agentTriggerConfirmation({
        agentName: agent.name,
        sentence: `${words}${scheduleRepository ? `, on ${scheduleRepository}` : ""}`,
        outcome: "schedule",
      });
    }
    if (!outcomeSuggestion || !outcome || outcome === "other" || outcome === "schedule") {
      return null;
    }
    const shape = agentTriggerShapeOfSuggestion(outcomeSuggestion);
    const withRepositories =
      chosenRepositories.length > 0
        ? {
            ...shape,
            listens: shape.listens.map((listen) => ({
              ...listen,
              conditions: [
                ...listen.conditions,
                { field: "data.repository.full_name", op: "in", value: chosenRepositories },
              ],
            })),
          }
        : shape;
    return agentTriggerConfirmation({
      agentName: agent.name,
      sentence: agentTriggerSentence(t, withRepositories, { agentName: agent.name, now }),
      outcome,
    });
  })();
  const outcomeCards = agentTriggerOutcomeCards(agent.name);
  // An outcome shows only what it needs (a repository for GitHub and a schedule);
  // the note and chat choice stay on Other events and the full form.
  const advanced = outcome === null || outcome === "other";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={suggestion ? suggestion.name : "Add trigger"}
      description={`${agentTriggerChatWords(agent, chat)}. ${
        visibility === "private" ? "Only you see it." : "Visible to the workspace."
      }`}
      submitLabel={submitLabel}
      pendingLabel={awaitingSecret ? "Saving…" : ready ? "Adding…" : "Working…"}
      onSubmit={submit}
      error={error ?? undefined}
      footerStart={
        <button
          type="button"
          className="og-link text-xs"
          data-agent-trigger-full-form=""
          onClick={() =>
            leave(() =>
              onOpenFullForm({
                sourceId: fullFormSourceId,
                note: draft.instructions.trim() || undefined,
                chat,
              }),
            )
          }
        >
          Open full form
        </button>
      }
    >
      <FieldStack>
        {suggestion || !eventTriggers ? null : (
          <div className="flex min-w-0 flex-col gap-2" data-agent-trigger-outcomes="">
            <ChoiceCards
              label="When should it start?"
              layout="grid"
              value={outcome && outcome !== "other" ? outcome : undefined}
              onValueChange={(next) => chooseOutcome(next as AgentTriggerOutcome)}
              error={!picked && outcome !== "other" ? whenError : undefined}
            >
              {outcomeCards.map((card) => (
                <ChoiceCard
                  key={card.value}
                  value={card.value}
                  title={card.title}
                  description={card.description}
                />
              ))}
            </ChoiceCards>
            {outcome === "other" ? null : (
              <p className="m-0 text-sm text-fg-muted">
                <button
                  type="button"
                  className="og-link"
                  data-agent-trigger-other=""
                  onClick={() => chooseOutcome("other")}
                >
                  Other events
                </button>{" "}
                from any connected app or a webhook.
              </p>
            )}
          </div>
        )}
        {outcome === "other" ? (
          <AgentTriggerPicker
            options={options.filter((entry) => entry.pick.kind !== "schedule")}
            value={pick ? agentTriggerPickKey(pick) : null}
            onChange={(next) => choose(next.pick)}
            sourceLogo={sourceLogo}
            error={!picked ? whenError : undefined}
          />
        ) : null}
        {!picked ? null : setup && !setupReady ? (
          <SetupStep setup={setup} name={setupName} />
        ) : awaitingSecret && pickedSource && pasted ? (
          <div data-agent-trigger-secret="" className="min-w-0">
            <PastedWebhookSteps
              key={`${pickedSource.id}:${replacingSecret ?? ""}`}
              url={pickedSource.webhookUrl}
              tile={<EventSourceTile source={pickedSource} logo={sourceLogo} size="sm" />}
              setup={pasted}
              inputRef={secretField}
              onChange={() => {
                setSecretIssue(undefined);
                setError(null);
              }}
              error={secretIssue}
              autoFocus={replacingSecret === pickedSource.id}
              onKeep={
                agentTriggerAwaitsSecret(pickedSource)
                  ? undefined
                  : () => {
                      setReplacingSecret(null);
                      setSecretIssue(undefined);
                      setFocusReplace(true);
                    }
              }
            />
          </div>
        ) : isSchedule ? (
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
        ) : activeSuggestion &&
          !showEvents &&
          // An outcome asks for its source only while it has none.
          (!outcomeSuggestion || draft.events.triggers.some((trigger) => !trigger.sourceId)) ? (
          <SuggestionSources
            draft={draft}
            sources={formSources}
            pendingSource={missing && setup === "create" ? setupName : undefined}
            onChange={(events) => update({ events })}
            onEdit={outcomeSuggestion ? undefined : () => setShowEvents(true)}
            sourceIssue={issues.events ? "Choose a source." : undefined}
          />
        ) : outcomeSuggestion && !showEvents ? null : (
          <div className="flex min-w-0 flex-col gap-2">
            {shownWebhook ? <WebhookCreated {...shownWebhook} /> : null}
            {pasted && pickedSource ? (
              <SecretSet
                name={pasted.secretName}
                autoFocus={focusReplace}
                onReplace={
                  // Only whoever may change the source replaces its secret.
                  pickedSource.viewerAccess === "use"
                    ? undefined
                    : () => {
                        setReplacingSecret(pickedSource.id);
                        setFocusReplace(false);
                        setError(null);
                      }
                }
              />
            ) : null}
            <EventTriggersField
              value={draft.events}
              onChange={(events) => update({ events })}
              sources={formSources}
              loadEventTypes={standIns.loadEventTypes}
              issues={issues.events}
              sourceLogo={sourceLogo}
              onAddSource={(choice) => leave(() => onAddSource(choice))}
              allowOnce={false}
            />
            {whenError ? (
              <p role="alert" className="m-0 text-xs text-danger">
                {whenError}
              </p>
            ) : null}
          </div>
        )}
        {picked && ready && outcome === "issue_labelled" ? (
          <Field label="Label" error={issues.when && !label.trim() ? issues.when : undefined}>
            <TextInput
              value={label}
              data-agent-trigger-label=""
              onChange={(event) => changeLabel(event.target.value)}
              placeholder={AGENT_TRIGGER_DEFAULT_LABEL}
            />
          </Field>
        ) : null}
        {picked && ready && isSchedule && repositories.length > 0 ? (
          <Field label="Repository" optional hint="Each run opens it.">
            <div data-agent-trigger-schedule-repository="" className="min-w-0">
              <SelectMenu
                options={[
                  { value: "", label: "None" },
                  ...repositories.map((repo) => ({ value: repo.fullName, label: repo.fullName })),
                ]}
                value={scheduleRepository ?? ""}
                onValueChange={(next) => setScheduleRepository(next || null)}
                variant={repositories.length > 8 ? "combobox" : "menu"}
                searchPlaceholder="Search repositories"
                className="max-w-full"
              />
            </div>
          </Field>
        ) : null}
        {picked && ready && listensOnGitHub && repositories.length > 0 ? (
          <AgentTriggerRepositories
            repositories={repositories}
            value={chosenRepositories}
            onChange={setChosenRepositories}
            newChatPerRun={chat.mode === "new_session_per_run"}
          />
        ) : null}
        {picked && ready && advanced ? (
          <Field
            label="Note"
            optional
            hint={
              isSchedule
                ? "The agent's Instructions do the rest."
                : "Each run gets the event; the agent's Instructions do the rest."
            }
          >
            <TextArea
              rows={3}
              value={draft.instructions}
              onChange={(event) => update({ instructions: event.target.value })}
              placeholder={agentTriggerMessage({
                instructions: "",
                events: draft.events,
              })}
            />
          </Field>
        ) : null}
        {picked && ready && advanced ? (
          <AgentTriggerChatField
            agent={agent}
            workspaceId={workspaceId}
            value={chat}
            onChange={(next) => {
              setChat(next);
              setChatIssue(undefined);
              setError(null);
            }}
            error={chatIssue}
          />
        ) : null}
        {confirmation ? (
          <div
            data-agent-trigger-confirmation=""
            className="rounded-[14px] border border-border bg-surface-2 px-4 py-3"
          >
            <p className="m-0 text-sm leading-5 font-medium text-fg">{confirmation.headline}</p>
            <p className="mt-1 mb-0 text-sm leading-5 text-fg-muted">{confirmation.detail}</p>
          </div>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}

/** A kind of source not added yet, and what adding it takes, in one line. */
function SetupStep({ setup, name }: { setup: AgentTriggerSetup; name: string }) {
  if (setup === "connect_github") {
    return (
      <div data-agent-trigger-setup={setup}>
        <Notice>GitHub isn't connected to this workspace yet.</Notice>
      </div>
    );
  }
  const text =
    setup === "create"
      ? `Opengeni adds ${name} to this workspace.`
      : setup === "create_webhook"
        ? "Opengeni creates a URL that apps can send events to."
        : setup === "create_pasted"
          ? `Opengeni creates a webhook URL for ${name}, then takes the secret ${name} shows.`
          : `Add ${name} first.`;
  return (
    <p data-agent-trigger-setup={setup} className="m-0 text-sm leading-5 text-fg-muted">
      {text}
    </p>
  );
}

/** The new webhook's URL, and its signing secret, shown once. */
function WebhookCreated({ url, secret }: { url: string; secret?: string | undefined }) {
  return (
    <div data-agent-trigger-webhook="" className="flex min-w-0 flex-col gap-2">
      <Field label="Webhook URL" hint="Send events here.">
        <CopyField value={url} label="webhook URL" variant="field" />
      </Field>
      {secret ? (
        <Field label="Signing secret" hint="Shown once.">
          <CopyField value={secret} label="signing secret" variant="field" />
        </Field>
      ) : null}
    </div>
  );
}

/** A pasted webhook's secret is set; it is never shown, only replaced. */
function SecretSet({
  name,
  onReplace,
  autoFocus,
}: {
  name: string;
  /** Absent for someone who may only use the source. */
  onReplace?: (() => void) | undefined;
  autoFocus?: boolean | undefined;
}) {
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return (
    <p data-agent-trigger-secret-set="" className="m-0 text-sm text-fg-muted">
      <span role="status">{`${label} set.`}</span>
      {onReplace ? (
        <>
          {" "}
          <button type="button" className="og-link" onClick={onReplace} autoFocus={autoFocus}>
            Replace
          </button>
        </>
      ) : null}
    </p>
  );
}

/** A suggestion's triggers, each asking only which source it listens on. */
function SuggestionSources({
  draft,
  sources,
  pendingSource,
  onChange,
  onEdit,
  sourceIssue,
}: {
  draft: AutomationDraft;
  sources: EventSource[] | undefined;
  /** The kind Opengeni adds when it saves, when the person has none. */
  pendingSource: string | undefined;
  onChange: (events: AutomationDraft["events"]) => void;
  /** Absent for an outcome: Other events covers changing them. */
  onEdit?: (() => void) | undefined;
  sourceIssue: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {draft.events.triggers.map((trigger, index) => {
        const wanted = trigger.templateSource;
        const label = draft.events.triggers.length > 1 ? `Source ${index + 1}` : "Source";
        const hint = eventTypesLabel(t, trigger.eventTypes);
        if (!trigger.sourceId && pendingSource && wanted) {
          return (
            <Field key={trigger.key} label={label} hint={hint}>
              <p data-agent-trigger-setup="create" className="m-0 text-sm text-fg-muted">
                {`Opengeni adds ${pendingSource} to this workspace.`}
              </p>
            </Field>
          );
        }
        const fitting = (sources ?? []).filter(
          (source) =>
            source.id === trigger.sourceId || !wanted || eventSourceFitsTemplate(wanted, source),
        );
        return (
          <Field
            key={trigger.key}
            label={label}
            hint={hint}
            error={!trigger.sourceId ? sourceIssue : undefined}
          >
            <SelectMenu
              options={fitting.map((source) => ({
                value: source.id,
                label: source.name,
              }))}
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
      {onEdit ? (
        <div>
          <button type="button" className="og-link text-sm" onClick={onEdit}>
            Change events
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The person's event sources and the ones they can use without adding, read while open. */
function useTriggerSources(
  workspaceId: string,
  enabled: boolean,
): {
  sources: EventSource[] | undefined;
  ready: ReadyEventSource[] | undefined;
} {
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
