/**
 * Agents: every agent the reader can chat with in this workspace, theirs or
 * shared. Bot templates and Slack agents became agents, so their old pages
 * land here, with a one-time note saying so.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BotIcon, ChevronDownIcon, FilePlusIcon, PlusIcon, UploadIcon } from "lucide-react";
import {
  agentInitialsAvatar,
  type Agent,
  type AgentListFilter,
  type AgentSummary,
  type AgentTemplate,
} from "@opengeni/contracts";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { DetailPage, DetailPageHeader } from "../../../ui/detail-page";
import { DetailSection } from "../../../ui/detail-sheet";
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
import { ListRow, ListRowSkeleton, RowList } from "../../../ui/list-row";
import { LogoTile } from "../../../ui/logo-tile";
import { MetaChip } from "../../../ui/meta-chip";
import { Notice } from "../../../ui/notice";
import { SegmentedControl } from "../../../ui/segmented-control";
import { useAppContext } from "../../app-context";
import { agentAvatar } from "../../lib/agent-avatar";
import { duplicateAgentNames, parseAgentFile, useAgents } from "../../lib/agents";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import { SessionAvatar } from "../session/session-avatar";
import { useDismissedNotice } from "./agent-notices";

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "yours", label: "Yours" },
] as const satisfies readonly { value: AgentListFilter; label: string }[];

export const AGENTS_SUBTITLE = "Named agents you can chat with here and in Slack.";

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
}: {
  workspaceId: string;
  /** More sections under the workspace's own agents (the app's "Managed in Console" list). */
  after?: ReactNode | undefined;
}) {
  const { client } = useAppContext();
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
      const created = await client.createAgent(workspaceId, request);
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
        added={
          new Set((agents ?? []).flatMap((agent) => (agent.templateKey ? [agent.templateKey] : [])))
        }
        onAdded={(agent) => {
          state.replace((current) => [agent, ...current]);
          open(agent);
        }}
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
        <DetailSection
          title={filter === "yours" ? "Yours" : "In this workspace"}
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
            <RowList label="Agents" variant="catalog">
              {agents.map((agent) => (
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
                  titleAddon={
                    <>
                      {agent.visibility === "private" ? (
                        <MetaChip variant="soft">Only me</MetaChip>
                      ) : null}
                      {agent.slack.length > 0 ? <MetaChip variant="soft">Slack</MetaChip> : null}
                    </>
                  }
                  description={agent.description || undefined}
                  onOpen={() => open(agent)}
                />
              ))}
            </RowList>
          )}
        </DetailSection>
      )}
      {after}
    </DetailPage>
  );
}

/**
 * The one way to add an agent: ready-made agents first (each added as an
 * ordinary agent the person then sets up on its page; one already added here
 * is not offered), then a blank agent or one imported from a file.
 */
function AddAgentMenu({
  workspaceId,
  added,
  onAdded,
  onBlank,
  onImport,
}: {
  workspaceId: string;
  added: ReadonlySet<string>;
  onAdded: (agent: Agent) => void;
  onBlank: () => void;
  onImport: () => void;
}) {
  const { client } = useAppContext();
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  // Ready-made agents anyone here already added, whatever the list's filter.
  const [addedHere, setAddedHere] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      client.listAgentTemplates(workspaceId),
      client.listAgents(workspaceId).catch(() => []),
    ]).then(
      ([list, agents]) => {
        if (!live) return;
        setAddedHere(
          new Set(agents.flatMap((agent) => (agent.templateKey ? [agent.templateKey] : []))),
        );
        setTemplates(list);
      },
      () => live && setTemplates([]),
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const offered = (templates ?? []).filter(
    (template) => !added.has(template.key) && !addedHere.has(template.key),
  );
  const add = async (template: AgentTemplate) => {
    setAdding(template.key);
    try {
      const agent = await client.createAgentFromTemplate(workspaceId, template.key);
      toast.success(`Added ${agent.name}`);
      onAdded(agent);
    } catch (error) {
      toast.error(`Couldn't add ${template.name}`, { description: userErrorText(error) });
    } finally {
      setAdding(null);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          className="pointer-coarse:h-11"
          disabled={adding !== null}
          data-add-agent=""
        >
          <PlusIcon />
          Add agent
          <ChevronDownIcon className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {offered.length > 0 ? (
          <>
            <DropdownMenuLabel>Ready-made</DropdownMenuLabel>
            {offered.map((template) => (
              <DropdownMenuItem
                key={template.key}
                data-agent-template={template.key}
                disabled={adding !== null}
                onSelect={() => void add(template)}
                className="items-start"
              >
                <SessionAvatar
                  avatar={template.avatar ?? agentInitialsAvatar(template.name, template.key)}
                  name={template.name}
                  workspaceId={workspaceId}
                  seed={template.key}
                  size="sm"
                />
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
          Blank agent
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onImport}
          title="Import an .agent.json or .bot.json file"
        >
          <UploadIcon />
          Import from file
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
