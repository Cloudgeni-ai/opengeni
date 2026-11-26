/**
 * Agents: every agent the reader can chat with in this workspace, theirs or
 * shared, each with one status (Ready, 1 step left, Needs PostHog, On call),
 * what starts it and when it last ran; then one Ready-made list, each opening
 * a preview before it is added. Bot templates and Slack agents became agents,
 * so their old pages land here, with a one-time note saying so.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BotIcon,
  ChevronDownIcon,
  FilePlusIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import {
  agentInitialsAvatar,
  type AgentListFilter,
  type AgentSummary,
  type AgentTemplate,
} from "@opengeni/contracts";
import type { EventSource, ScheduledTask } from "@opengeni/sdk";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { DetailPage, DetailPageHeader } from "../../../ui/detail-page";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { EmptyState } from "../../../ui/empty-state";
import { ErrorMessage } from "../../../ui/error-message";
import { ListRow, ListRowSkeleton, RowList, type ListRowProps } from "../../../ui/list-row";
import { LogoTile } from "../../../ui/logo-tile";
import { MetaChip } from "../../../ui/meta-chip";
import { Notice } from "../../../ui/notice";
import { RelativeTime } from "../../../ui/relative-time";
import { Section } from "../../../ui/section";
import { SegmentedControl } from "../../../ui/segmented-control";
import { StatusBadge } from "../../../ui/status-badge";
import { useAppContext } from "../../app-context";
import { agentAvatar } from "../../lib/agent-avatar";
import { duplicateAgentNames, parseAgentFile, useAgents } from "../../lib/agents";
import { useNavigate } from "../../lib/navigation";
import { hasWorkspacePermission } from "../../lib/permissions";
import { t } from "../../lib/console-text";
import { toast } from "../../lib/toast";
import { SessionAvatar } from "../session/session-avatar";
import { useDismissedNotice } from "./agent-notices";
import { agentTriggers } from "./agent-setup-sections";
import { agentStartsWords, agentStatus, type AgentReadinessSummary } from "./agent-status";
import { agentTriggerSentence, agentTriggerShapeOfTask } from "./agent-trigger-words";
import { readyMadeAgentSetup } from "./ready-made-agent-setup";
import { inAppClick } from "../../../ui/in-app-click";
import "../../../../styles/connect.css";

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "yours", label: "Yours" },
] as const satisfies readonly { value: AgentListFilter; label: string }[];

export const AGENTS_SUBTITLE = "Agents that work for your team, on their own or when asked.";

export const BOT_TEMPLATES_MOVED =
  "Bot templates are now agents. Each kept its name, icon and who can use it. Its setup text is now its Instructions.";

export const SLACK_AGENTS_MOVED =
  "Slack agents are now agents. Manage them here. Nothing changes in Slack.";

/** Several agents share a name: say which, and suggest a rename. Agents are never merged. */
export function duplicateNamesText(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return quoted.length === 1
    ? `More than one agent is called ${list}. Rename one so people can tell them apart.`
    : `More than one agent is called ${list}. Rename them so people can tell them apart.`;
}

export function AgentsPage({
  workspaceId,
  after,
  onCreateWithChat,
  readinessOf,
}: {
  workspaceId: string;
  /** More sections under the workspace's own agents (the app's "Managed in Console" list). */
  after?: ReactNode | undefined;
  /** Opens "Create with chat": describe the agent, and a chat drafts and saves it. */
  onCreateWithChat?: (() => void) | undefined;
  /** The server's readiness check per agent, once read; absent when unknown. */
  readinessOf?: ((agentId: string) => AgentReadinessSummary | null | undefined) | undefined;
}) {
  const { client, accessContext } = useAppContext();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AgentListFilter>("all");
  const state = useAgents(workspaceId, { filter });
  const fileInput = useRef<HTMLInputElement | null>(null);
  const templatesNotice = useDismissedNotice("agents.botTemplatesMoved");
  const slackNotice = useDismissedNotice("agents.slackAgentsMoved");
  const agents = state.agents;

  const open = (agent: Pick<AgentSummary, "id">) =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId",
      params: { workspaceId, agentId: agent.id },
    });
  const create = () =>
    void navigate({ to: "/workspaces/$workspaceId/agents/new", params: { workspaceId } });
  const preview = (template: Pick<AgentTemplate, "key">) =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/ready-made/$templateKey",
      params: { workspaceId, templateKey: template.key },
    });
  const readyMade = useReadyMadeAgents(workspaceId, agents, filter === "all");
  const facts = useAgentListFacts(workspaceId, agents);
  const canAdd = hasWorkspacePermission(accessContext, workspaceId, "sessions:create");
  // Ready-made agents show in one place: their own section when it's there,
  // otherwise the Add agent menu.
  const readyMadeSection =
    state.supported && canAdd && agents !== undefined && readyMade.offered.length > 0;

  const importFile = async (file: File) => {
    const parsed = parseAgentFile(await file.text());
    if (!parsed.ok) {
      toast.error("Couldn't import the agent", { description: parsed.error });
      return;
    }
    try {
      // An Only me agent stays Only me, unless this workspace has no Only me chats.
      // If that can't be read, the server decides and says why it refuses.
      const onlyMeUnavailable =
        parsed.request.visibility === "private" &&
        (await client.getSessionTenancyCreateCapabilities(workspaceId).then(
          (capabilities) => !capabilities.canCreatePrivate,
          () => false,
        ));
      const request = onlyMeUnavailable
        ? { ...parsed.request, visibility: "workspace" as const }
        : parsed.request;
      const created = await client.createAgent(workspaceId, {
        ...request,
        editAccess: request.editAccess ?? "everyone",
      });
      state.replace((current) => [created, ...current]);
      toast.success("Agent imported", {
        description: onlyMeUnavailable
          ? `${created.name} is for everyone here: Only me chats aren't available.`
          : created.name,
      });
    } catch (error) {
      toast.error("Couldn't import the agent", { description: userErrorText(error) });
    }
  };

  const actions = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      <AddAgentMenu
        workspaceId={workspaceId}
        readyMade={readyMade}
        onPreview={preview}
        showReadyMade={!readyMadeSection}
        onChat={canAdd ? onCreateWithChat : undefined}
        onBlank={create}
        onImport={() => fileInput.current?.click()}
      />
    </>
  );

  // The notes show only while the moved agents are here to see.
  const showTemplatesNote =
    !templatesNotice.dismissed && (agents ?? []).some((agent) => agent.origin === "bot_template");
  const showSlackNote =
    !slackNotice.dismissed && (agents ?? []).some((agent) => agent.origin === "slack_agent");
  const duplicates = duplicateAgentNames(agents ?? []);

  return (
    <DetailPage>
      <DetailPageHeader
        leading={<LogoTile name="Agents" icon={<BotIcon />} />}
        title="Agents"
        meta={[AGENTS_SUBTITLE]}
        actions={state.supported ? actions : undefined}
      />
      {showTemplatesNote || showSlackNote || duplicates.length > 0 ? (
        <div className="mt-6 grid gap-3">
          {showTemplatesNote ? (
            <Notice tone="info" onDismiss={templatesNotice.dismiss}>
              {BOT_TEMPLATES_MOVED}
            </Notice>
          ) : null}
          {showSlackNote ? (
            <Notice tone="info" onDismiss={slackNotice.dismiss}>
              {SLACK_AGENTS_MOVED}
            </Notice>
          ) : null}
          {duplicates.length > 0 ? <Notice>{duplicateNamesText(duplicates)}</Notice> : null}
        </div>
      ) : null}
      {!state.supported ? (
        <Notice className="mt-6">This server doesn't have agents yet.</Notice>
      ) : (
        <Section
          title={filter === "yours" ? "Yours" : "Your agents"}
          variant="group"
          data-agents-list=""
          action={
            <SegmentedControl
              size="sm"
              aria-label="Show"
              options={FILTER_OPTIONS}
              value={filter}
              onValueChange={setFilter}
            />
          }
        >
          {agents === undefined ? (
            <RowList label="Agents" variant="catalog" busy>
              <ListRowSkeleton count={4} />
            </RowList>
          ) : state.error && agents.length === 0 ? (
            <ErrorMessage
              variant="inline"
              title="Couldn't load agents"
              {...apiErrorDetails(state.error)}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={state.reload}
                  className="pointer-coarse:h-11"
                >
                  Try again
                </Button>
              }
            >
              Check your connection, then try again.
            </ErrorMessage>
          ) : agents.length === 0 ? (
            filter === "yours" ? (
              <p className="text-sm text-fg-muted">You haven't made an agent here yet.</p>
            ) : (
              <EmptyState
                icon={<BotIcon />}
                title="No agents yet"
                description="Make one here, or from a chat with Make this an agent."
                action={
                  <Button type="button" size="sm" onClick={create}>
                    <PlusIcon />
                    New agent
                  </Button>
                }
              />
            )
          ) : (
            <RowList label="Agents" variant="resource">
              {agents.map((agent) => {
                const row = agentRowFacts(agent, facts, readinessOf?.(agent.id));
                return (
                  <ListRow
                    key={agent.id}
                    leading={
                      <SessionAvatar
                        avatar={agentAvatar(agent)}
                        name={agent.name}
                        workspaceId={workspaceId}
                        seed={agent.id}
                        size="md"
                      />
                    }
                    title={agent.name}
                    // Every shared agent is in Slack, so only Only me (app only) is marked.
                    titleAddon={
                      agent.visibility === "private" ? (
                        <MetaChip variant="soft">Only me</MetaChip>
                      ) : undefined
                    }
                    status={
                      row.status ? (
                        <span data-agent-row-status={row.status.key} className="inline-flex">
                          <StatusBadge variant="dot" tone={row.status.tone}>
                            {row.status.label}
                          </StatusBadge>
                        </span>
                      ) : undefined
                    }
                    meta={[
                      <span key="starts" data-agent-row-starts="">
                        {row.starts}
                      </span>,
                      ...(row.lastRun
                        ? [<RelativeTime key="last" date={row.lastRun} prefix="Last ran" />]
                        : []),
                    ]}
                    indicator="open"
                    onOpen={() => open(agent)}
                  />
                );
              })}
            </RowList>
          )}
        </Section>
      )}
      {readyMadeSection ? (
        <ReadyMadeAgents workspaceId={workspaceId} readyMade={readyMade} onPreview={preview} />
      ) : null}
      {state.supported && facts.withoutAgent > 0 ? (
        <p className="mt-2 mb-0 text-sm text-fg-muted" data-agents-automations-without="">
          {facts.withoutAgent === 1
            ? "1 automation runs without an agent. "
            : `${facts.withoutAgent} automations run without an agent. `}
          <a
            href={`/workspaces/${encodeURIComponent(workspaceId)}/automations`}
            className="og-link"
            onClick={(event) => {
              event.preventDefault();
              void navigate({
                to: "/workspaces/$workspaceId/automations",
                params: { workspaceId },
              });
            }}
          >
            See automations
          </a>
        </p>
      ) : null}
      {after}
    </DetailPage>
  );
}

type ReadyMadeAgentsState = {
  /** Ready-made agents not added here yet, in gallery order. */
  offered: AgentTemplate[];
};

/**
 * Ready-made agents nobody here has added yet (whatever the list's filter).
 * Opening one shows its preview; only its Add agent adds it.
 */
function useReadyMadeAgents(
  workspaceId: string,
  agents: readonly AgentSummary[] | undefined,
  /** Whether `agents` is every agent here (the All filter), not only some. */
  listedIsAll: boolean,
): ReadyMadeAgentsState {
  const { client } = useAppContext();
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  // Ready-made agents anyone here already added, whatever the list's filter.
  // null when that can't be read: then only the All list can tell.
  const [addedHere, setAddedHere] = useState<ReadonlySet<string> | null>(new Set());
  useEffect(() => {
    let live = true;
    Promise.all([
      client.listAgentTemplates(workspaceId),
      client.listAgents(workspaceId).catch(() => null),
    ]).then(
      ([list, all]) => {
        if (!live) return;
        setAddedHere(
          all
            ? new Set(all.flatMap((agent) => (agent.templateKey ? [agent.templateKey] : [])))
            : null,
        );
        setTemplates(list);
      },
      () => live && setTemplates([]),
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const listed = new Set(
    (agents ?? []).flatMap((agent) => (agent.templateKey ? [agent.templateKey] : [])),
  );
  const offered =
    addedHere === null && !listedIsAll
      ? []
      : (templates ?? []).filter(
          (template) => !listed.has(template.key) && !addedHere?.has(template.key),
        );
  return { offered };
}

/** What the list says about each agent: its triggers, their sources and its last chat. */
interface AgentListFacts {
  /** Triggers by agent id; null while they load. */
  triggers: ReadonlyMap<string, ScheduledTask[]> | null;
  sources: readonly Pick<EventSource, "id" | "name" | "kind">[];
  lastRuns: ReadonlyMap<string, string>;
  /** Automations here that run without an agent. */
  withoutAgent: number;
}

/** How many agents' last runs are read for the list, at most. */
const LAST_RUN_READS_MAX = 30;

function useAgentListFacts(
  workspaceId: string,
  agents: readonly AgentSummary[] | undefined,
): AgentListFacts {
  const { client } = useAppContext();
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [sources, setSources] = useState<EventSource[]>([]);
  const [lastRuns, setLastRuns] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    let live = true;
    client.listScheduledTasks(workspaceId, { limit: 200 }).then(
      (list) => live && setTasks(list),
      () => live && setTasks([]),
    );
    client.listEventSources(workspaceId).then(
      (list) => live && setSources(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const ids = (agents ?? [])
    .slice(0, LAST_RUN_READS_MAX)
    .map((agent) => agent.id)
    .join(",");
  useEffect(() => {
    if (!ids) return;
    let live = true;
    for (const agentId of ids.split(",")) {
      client.listAgentChats(workspaceId, agentId, { filter: "everyone", limit: 1 }).then(
        (page) => {
          const latest = page.chats[0]?.updatedAt;
          if (live && latest) setLastRuns((current) => new Map(current).set(agentId, latest));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [client, ids, workspaceId]);
  const triggers =
    tasks === null
      ? null
      : new Map((agents ?? []).map((agent) => [agent.id, agentTriggers(tasks, agent.id)] as const));
  const withoutAgent = (tasks ?? []).filter(
    (task) => !task.agentConfig.agentId && (task.action?.kind ?? "agent_turn") === "agent_turn",
  ).length;
  return { triggers, sources, lastRuns, withoutAgent };
}

/** One agent's row: its status, what starts it and when it last ran. */
function agentRowFacts(
  agent: AgentSummary,
  facts: AgentListFacts,
  readiness: AgentReadinessSummary | null | undefined,
) {
  const triggers = facts.triggers?.get(agent.id) ?? null;
  const inSlack = agent.visibility !== "private" && agent.slack.length > 0;
  const now = new Date();
  const sentences = (triggers ?? []).map((task) =>
    agentTriggerSentence(t, agentTriggerShapeOfTask(task, facts.sources), {
      agentName: agent.name,
      now,
    }),
  );
  return {
    status: agentStatus({ triggers, inSlack, readiness }),
    starts:
      triggers === null
        ? ""
        : agentStartsWords(sentences, { inSlack }) +
          (triggers.length > 0 && !triggers.some((task) => task.status === "active")
            ? " · Off"
            : ""),
    lastRun: facts.lastRuns.get(agent.id) ?? null,
  };
}

function readyMadeAvatar(workspaceId: string, template: AgentTemplate, size: "sm" | "md") {
  return (
    <SessionAvatar
      avatar={template.avatar ?? agentInitialsAvatar(template.name, template.key)}
      name={template.name}
      workspaceId={workspaceId}
      seed={template.key}
      size={size}
    />
  );
}

/** Under the workspace's agents: ready-made ones not added yet, each opening its preview. */
function ReadyMadeAgents({
  workspaceId,
  readyMade,
  onPreview,
}: {
  workspaceId: string;
  readyMade: ReadyMadeAgentsState;
  onPreview: (template: AgentTemplate) => void;
}) {
  return (
    <Section
      title="Ready-made"
      description="Open one to see what it does and what it needs before you add it."
      variant="group"
      data-ready-made-agents=""
    >
      <RowList label="Ready-made agents" variant="resource">
        {readyMade.offered.map((template) => {
          const needs = readyMadeAgentSetup(template).needs.filter((need) => need.required);
          return (
            <ListRow
              key={template.key}
              leading={readyMadeAvatar(workspaceId, template, "md")}
              title={template.name}
              description={template.description || undefined}
              meta={
                needs.length > 0
                  ? [`Needs ${needs.map((need) => need.label).join(" and ")}`]
                  : undefined
              }
              indicator="open"
              href={`/workspaces/${encodeURIComponent(workspaceId)}/agents/ready-made/${encodeURIComponent(template.key)}`}
              linkProps={
                {
                  "data-ready-made-agent": template.key,
                  onClick: inAppClick(() => onPreview(template)),
                } as ListRowProps["linkProps"]
              }
            />
          );
        })}
      </RowList>
    </Section>
  );
}

/**
 * The one way to add an agent: by chat (when the host offers it), ready-made
 * agents (each added as an ordinary agent the person then sets up on its
 * page; one already added here is not offered), then a new agent from the
 * form or one imported from a file.
 */
function AddAgentMenu({
  workspaceId,
  readyMade,
  onPreview,
  showReadyMade,
  onChat,
  onBlank,
  onImport,
}: {
  workspaceId: string;
  readyMade: ReadyMadeAgentsState;
  /** Opens a ready-made agent's preview; nothing is added from the menu. */
  onPreview: (template: AgentTemplate) => void;
  /** False while the page's own Ready-made section lists them. */
  showReadyMade: boolean;
  onChat?: (() => void) | undefined;
  onBlank: () => void;
  onImport: () => void;
}) {
  const { offered } = readyMade;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" className="pointer-coarse:h-11" data-add-agent="">
          <PlusIcon />
          Add agent
          <ChevronDownIcon className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {onChat ? (
          <>
            <DropdownMenuItem onSelect={onChat} data-agent-create-with-chat="">
              <MessageSquarePlusIcon />
              Create with chat
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {showReadyMade && offered.length > 0 ? (
          <>
            <DropdownMenuLabel>Ready-made</DropdownMenuLabel>
            {offered.map((template) => (
              <DropdownMenuItem
                key={template.key}
                data-agent-template={template.key}
                onSelect={() => onPreview(template)}
                className="items-start"
              >
                {readyMadeAvatar(workspaceId, template, "sm")}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{template.name}</span>
                  {template.description ? (
                    <span className="line-clamp-2 text-xs text-fg-muted">
                      {template.description}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onBlank}>
          <FilePlusIcon />
          New agent
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onImport} title="Import an .agent.json or .bot.json file">
          <UploadIcon />
          Import from file
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
