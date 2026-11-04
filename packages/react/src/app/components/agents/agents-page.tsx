/**
 * Agents: every agent the reader can chat with in this workspace, theirs or
 * shared. Bot templates and Slack agents became agents, so their old pages
 * land here, with a one-time note saying so.
 */
import { useRef, useState } from "react";
import { BotIcon, PlusIcon, UploadIcon } from "lucide-react";
import type { AgentListFilter, AgentSummary } from "@opengeni/contracts";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { DetailPage, DetailPageHeader } from "../../../ui/detail-page";
import { DetailSection } from "../../../ui/detail-sheet";
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
  "Bot templates are now agents. Each kept its name, icon and who can use it. Its setup text is now its first message.";

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

export function AgentsPage({ workspaceId }: { workspaceId: string }) {
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
      const onlyMeUnavailable =
        parsed.request.visibility === "private" &&
        !(await client.getSessionTenancyCreateCapabilities(workspaceId)).canCreatePrivate;
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        title="Import an .agent.json or .bot.json file"
        onClick={() => fileInput.current?.click()}
      >
        <UploadIcon />
        Import
      </Button>
      <Button type="button" size="sm" className="pointer-coarse:h-11" onClick={create}>
        <PlusIcon />
        New agent
      </Button>
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
    </DetailPage>
  );
}
