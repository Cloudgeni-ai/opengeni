/**
 * One agent as a job card (docs/agents.md): what it does in one line, its
 * status, When it works (each trigger as a sentence, with whose access it
 * runs and when it last ran) and its recent work. Its setup (Instructions,
 * Can use, Learns, who can use and edit it, Skills) is on its Settings page,
 * one click away. The host renders the Slack rows (`renderSlack`), which need
 * the Slack integration's pieces.
 */
import { useEffect, useState, type ReactNode } from "react";
import { DownloadIcon, MessageSquareIcon, PencilIcon, SettingsIcon } from "lucide-react";
import {
  slackAgentCallText,
  type Agent,
  type AgentChat,
  type AgentChatsFilter,
} from "@opengeni/contracts";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "../../../ui/detail-page";
import { Section } from "../../../ui/section";
import { StatusBadge } from "../../../ui/status-badge";
import { DetailSection, DetailSkeleton } from "../../../ui/detail-sheet";
import { ErrorMessage } from "../../../ui/error-message";
import { inAppClick } from "../../../ui/in-app-click";
import { ListRow, ListRowSkeleton, RowList } from "../../../ui/list-row";
import { MetaChip } from "../../../ui/meta-chip";
import { RelativeTime } from "../../../ui/relative-time";
import { SegmentedControl } from "../../../ui/segmented-control";
import { SettingDangerRow, SettingRow } from "../../../ui/setting-row";
import { RowSelect } from "../settings/row-select";
import { Switch } from "../../../ui/switch";
import { useAppContext } from "../../app-context";
import { agentAvatar } from "../../lib/agent-avatar";
import { agentErrorCode, downloadAgentFile, useAgent, useAgentChats } from "../../lib/agents";
import { useNavigate } from "../../lib/navigation";
import { orgName } from "../../lib/org";
import { forgetSessionAgent } from "../../lib/session-agent";
import { toast } from "../../lib/toast";
import { slackLogo } from "../new-session-starter-logos";
import { SessionAvatar } from "../session/session-avatar";
import { DestructiveConfirm } from "../ui/destructive-confirm";
import { useAgentCostText } from "./agent-cost";
import {
  AgentCanUse,
  AgentMemoryEntries,
  AgentSkills,
  AgentWhenItWorks,
  useAgentTriggerTasks,
} from "./agent-setup-sections";
import { agentStatus, type AgentReadinessItem, type AgentReadinessSummary } from "./agent-status";
import {
  agentReadinessItems,
  agentReadinessSummary,
  useAgentsActivity,
  useAgentsReadiness,
} from "./agent-readiness";

export type AgentSlackSlot = (props: {
  agent: Agent;
  /** Show a change the Slack part saved (a new version, availability). */
  onAgentChange: (agent: Agent) => void;
}) => ReactNode;

const CHAT_FILTERS = [
  { value: "yours", label: "Yours" },
  { value: "everyone", label: "Everyone's" },
] as const satisfies readonly { value: AgentChatsFilter; label: string }[];

export const AGENT_VERSION_CONFLICT =
  "Someone else changed this agent. Reload to see their change, then try again.";

/** "People in Platform", the shared choice of Who can use it. */
export function workspacePeopleLabel(workspaceName: string | null | undefined): string {
  const name = workspaceName?.trim();
  return name ? `People in ${name}` : "People in this workspace";
}

/** "Who can use it: Anyone in <organization>". */
export function organizationPeopleLabel(organizationName: string | null | undefined): string {
  const name = organizationName?.trim();
  return name ? `Anyone in ${name}` : "Anyone in the organization";
}

/** Who can use an agent, in words. */
export function agentAudienceLabel(
  visibility: Agent["visibility"],
  names: { workspaceName: string | null | undefined; organizationName: string | null | undefined },
): string {
  if (visibility === "private") return "Only me";
  if (visibility === "organization") return organizationPeopleLabel(names.organizationName);
  return workspacePeopleLabel(names.workspaceName);
}

/** "Who can edit": the two choices, as the agent page offers them. */
export const AGENT_EDIT_ACCESS_OPTIONS = [
  { value: "creator_and_admins", label: "Creator and admins" },
  { value: "everyone", label: "Everyone in workspace" },
] as const satisfies readonly { value: Agent["editAccess"]; label: string }[];

/** Who may change who can use or edit it, and delete it; older servers said `canEdit`. */
export function agentViewerCanManage(agent: Pick<Agent, "viewer">): boolean {
  return agent.viewer.canManage ?? agent.viewer.canEdit;
}

/** "Who can edit" a shared agent: its creator and admins, or everyone in the workspace. */
function EditAccessRow({
  agent,
  workspaceId,
  onSaved,
}: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
}) {
  const { client } = useAppContext();
  const [pending, setPending] = useState<Agent["editAccess"] | null>(null);
  const canManage = agentViewerCanManage(agent);
  return (
    <SettingRow
      label="Who can edit"
      controlWidth="select"
      data-agent-edit-access=""
      control={
        <RowSelect
          options={AGENT_EDIT_ACCESS_OPTIONS}
          value={pending ?? agent.editAccess}
          disabled={!canManage || pending !== null}
          {...(canManage
            ? {}
            : { disabledReason: "Only whoever made it, or a workspace admin, can change this." })}
          onValueChange={(next) => {
            if (next === agent.editAccess) return;
            setPending(next);
            client
              .updateAgent(workspaceId, agent.id, {
                expectedVersion: agent.version,
                editAccess: next,
              })
              .then(
                (saved) => onSaved(saved),
                (error: unknown) =>
                  toast.error("Couldn't change who can edit it", {
                    description:
                      agentErrorCode(error) === "agent_version_conflict"
                        ? AGENT_VERSION_CONFLICT
                        : userErrorText(error),
                  }),
              )
              .finally(() => setPending(null));
          }}
        />
      }
    />
  );
}

function SourceIcon({ chat }: { chat: Pick<AgentChat, "source"> }) {
  return chat.source === "slack" ? (
    <img
      src={slackLogo}
      alt="Started in Slack"
      title="Started in Slack"
      className="size-4 rounded-[3px]"
      data-agent-chat-source="slack"
    />
  ) : (
    <MessageSquareIcon
      aria-label="Started in the app"
      className="size-4 text-fg-subtle"
      data-agent-chat-source="app"
    />
  );
}

function Prose({ text, empty }: { text: string; empty: string }) {
  return text.trim() ? (
    <p className="m-0 max-h-72 overflow-y-auto text-sm leading-5 break-words whitespace-pre-wrap text-fg">
      {text}
    </p>
  ) : (
    <p className="m-0 text-sm text-fg-muted">{empty}</p>
  );
}

function AgentChats({
  agent,
  workspaceId,
  title = "Chats",
}: {
  agent: Agent;
  workspaceId: string;
  title?: string | undefined;
}) {
  const navigate = useNavigate();
  // Recent work shows everyone's runs of a shared agent; its triggers run as their owners.
  const [filter, setFilter] = useState<AgentChatsFilter>(
    title === "Chats" || agent.visibility === "private" ? "yours" : "everyone",
  );
  const chats = useAgentChats(workspaceId, agent.id, filter);
  // An Only me agent's chats are all its owner's.
  const shared = agent.visibility !== "private";
  return (
    <DetailSection
      title={title}
      action={
        shared ? (
          <SegmentedControl
            size="sm"
            aria-label="Whose chats"
            options={CHAT_FILTERS}
            value={filter}
            onValueChange={setFilter}
          />
        ) : undefined
      }
    >
      {chats.chats === undefined ? (
        <RowList label="Chats" flush busy>
          <ListRowSkeleton count={2} />
        </RowList>
      ) : chats.error && chats.chats.length === 0 ? (
        <ErrorMessage
          variant="inline"
          title="Couldn't load chats"
          {...apiErrorDetails(chats.error)}
          action={
            <Button type="button" variant="outline" size="sm" onClick={chats.reload}>
              Try again
            </Button>
          }
        >
          {userErrorText(chats.error)}
        </ErrorMessage>
      ) : chats.chats.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {filter === "yours" ? "You haven't chatted with it yet." : "No chats yet."}
        </p>
      ) : (
        <>
          <RowList label="Chats" flush>
            {chats.chats.map((chat) => {
              const href = `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(chat.sessionId)}`;
              return (
                <ListRow
                  key={chat.sessionId}
                  leading={<SourceIcon chat={chat} />}
                  title={chat.title?.trim() || "Untitled chat"}
                  meta={[<RelativeTime key="time" date={chat.updatedAt} />]}
                  href={href}
                  linkProps={{ onClick: inAppClick(() => void navigate({ href })) }}
                />
              );
            })}
          </RowList>
          {chats.loadMore || chats.loadingMore ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={chats.loadingMore}
              onClick={() => chats.loadMore?.()}
            >
              {chats.loadingMore ? "Loading…" : "Show more"}
            </Button>
          ) : null}
        </>
      )}
    </DetailSection>
  );
}

function MemoryRow({
  agent,
  workspaceId,
  onSaved,
}: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
}) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? agent.memory.enabled;
  const collectionId = agent.memory.collectionId;
  const href = collectionId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/state?entry=${encodeURIComponent(collectionId)}&agent=${encodeURIComponent(agent.id)}`
    : null;
  return (
    <SettingRow
      label="Remember across chats"
      description={
        enabled
          ? agent.memory.reviewFirst
            ? "Its chats save what they learn to its Memory. New Memory waits for review first."
            : "Its chats save what they learn to its Memory and read it in later chats."
          : "Each chat starts fresh."
      }
      hint={
        href && enabled ? (
          <a
            href={href}
            onClick={inAppClick(() => void navigate({ href }))}
            className="w-fit rounded-[4px] text-xs text-fg underline decoration-fg/25 underline-offset-2 hover:decoration-fg"
            data-agent-memory=""
          >
            Open in Knowledge
          </a>
        ) : undefined
      }
      control={
        <Switch
          aria-label="Remember across chats"
          checked={enabled}
          pending={pending !== null}
          disabled={!agent.viewer.canEdit}
          disabledReason="Only whoever made it, or a workspace admin, can change this."
          onCheckedChange={(next) => {
            setPending(next);
            client
              .updateAgent(workspaceId, agent.id, {
                expectedVersion: agent.version,
                memoryEnabled: next,
              })
              .then(
                (saved) => onSaved(saved),
                (error: unknown) =>
                  toast.error("Couldn't change Memory", {
                    description:
                      agentErrorCode(error) === "agent_version_conflict"
                        ? AGENT_VERSION_CONFLICT
                        : userErrorText(error),
                  }),
              )
              .finally(() => setPending(null));
          }}
        />
      }
    />
  );
}

/** The page's frame while the agent loads or can't be read. */
function useAgentOrFallback(
  workspaceId: string,
  agentId: string,
  backLabel: string,
  onBack: () => void,
) {
  const state = useAgent(workspaceId, agentId);
  const back = { label: backLabel, onClick: onBack };
  const agent = state.agent;
  let fallback: ReactNode = null;
  if (agent === undefined) {
    fallback = (
      <DetailPage back={back}>
        <DetailSkeleton sections={3} />
      </DetailPage>
    );
  } else if (agent === null) {
    fallback = (
      <DetailPage back={back}>
        {state.error ? (
          <ErrorMessage
            title="Couldn't load this agent"
            {...apiErrorDetails(state.error)}
            action={
              <Button type="button" variant="outline" size="sm" onClick={state.reload}>
                Try again
              </Button>
            }
          >
            {userErrorText(state.error)}
          </ErrorMessage>
        ) : (
          <ErrorMessage title="This agent isn't available">
            It was deleted, or you can't use it.
          </ErrorMessage>
        )}
      </DetailPage>
    );
  }
  return { state, agent: agent ?? null, back, fallback };
}

export type { AgentReadinessItem } from "./agent-status";

/**
 * Ready to work: what the server's readiness check says is still missing.
 * Shown only while something required is; the setup page finishes it.
 */
export function AgentReadinessSection({
  items,
  onFinish,
}: {
  items: readonly AgentReadinessItem[];
  onFinish?: (() => void) | undefined;
}) {
  const missing = items.filter((item) => item.required && !item.ready);
  if (missing.length === 0) return null;
  const done = items.filter((item) => item.required && item.ready).length;
  const required = items.filter((item) => item.required).length;
  return (
    <Section
      title="Ready to work"
      description={`${done} of ${required} required ready. Its triggers stay off until all are.`}
      variant="group"
      data-agent-readiness=""
      action={
        onFinish ? (
          <Button type="button" size="sm" onClick={onFinish}>
            Finish setup
          </Button>
        ) : undefined
      }
    >
      {items.map((item) => (
        <SettingRow
          key={item.key}
          data-agent-readiness-item={item.key}
          label={item.label}
          description={
            item.ready ? (item.required ? "Required" : "Optional") : (item.reason ?? "Required")
          }
          control={
            <StatusBadge
              variant="dot"
              status={item.ready ? "ready" : item.required ? "incomplete" : "not_connected"}
            >
              {item.ready ? "Ready" : item.required ? "Missing" : "Not set up"}
            </StatusBadge>
          }
        />
      ))}
    </Section>
  );
}

/** The one ready-made agent this one works well with, by name; display only. */
function useWorksWellWith(workspaceId: string, templateKey: string | null): string | null {
  const { client } = useAppContext();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    setName(null);
    if (!templateKey) return;
    let live = true;
    client.listAgentTemplates(workspaceId).then(
      (list) => {
        const partner = list.find((entry) => entry.key === templateKey)?.setup?.worksWellWith;
        if (live && partner) setName(list.find((entry) => entry.key === partner)?.name ?? null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, templateKey, workspaceId]);
  return name;
}

export function AgentPage({
  workspaceId,
  agentId,
  readiness,
  readinessItems,
  worksWellWith,
  onFinishSetup,
}: {
  workspaceId: string;
  agentId: string;
  /** The server's readiness check, summarised; absent when unknown. */
  readiness?: AgentReadinessSummary | null | undefined;
  /** Its readiness check, item by item. */
  readinessItems?: readonly AgentReadinessItem[] | undefined;
  /** At most one agent it works well with ("PR reviewer"); never required. */
  worksWellWith?: string | null | undefined;
  /** Opens its setup page (Enable) to finish what is missing. */
  onFinishSetup?: (() => void) | undefined;
}) {
  const { workspaces, accessContext } = useAppContext();
  const navigate = useNavigate();
  const toList = () =>
    void navigate({ to: "/workspaces/$workspaceId/agents", params: { workspaceId } });
  const { agent, back, fallback } = useAgentOrFallback(workspaceId, agentId, "Agents", toList);
  // What it cost, for people who may see Usage; read before the agent loads.
  const costText = useAgentCostText({ id: agentId }, workspaceId);
  const triggers = useAgentTriggerTasks(workspaceId, agentId);
  // The server's readiness check, unless the host passed its own.
  const checked = useAgentsReadiness(workspaceId, agent ? [agent] : undefined).get(agentId);
  const activity = useAgentsActivity(workspaceId, [agentId]).get(agentId);
  const partner = useWorksWellWith(workspaceId, agent?.templateKey ?? null);
  if (!agent) return <>{fallback}</>;
  const summary = readiness ?? (checked ? agentReadinessSummary(checked) : null);
  const items = readinessItems ?? (checked ? agentReadinessItems(checked) : undefined);
  const partnerName = worksWellWith ?? partner;
  const workspace = workspaces.find((row) => row.id === agent.workspaceId);
  const organizationName = workspace
    ? orgName(workspace.accountId, accessContext.accountGrants)
    : null;
  const inSlack = agent.visibility !== "private" && agent.slack.length > 0;
  const status = agentStatus({
    triggers: triggers.tasks,
    inSlack,
    readiness: summary,
    working: activity?.working,
  });
  const chat = () =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions",
      params: { workspaceId },
      search: { agent: agent.id },
    });
  const settings = () =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId/settings",
      params: { workspaceId, agentId: agent.id },
    });
  return (
    <DetailPage back={back}>
      <DetailPageHeader
        leading={
          <SessionAvatar
            avatar={agentAvatar(agent)}
            name={agent.name}
            workspaceId={workspaceId}
            seed={agent.id}
            size="lg"
          />
        }
        title={agent.name}
        chips={
          <>
            {status ? (
              <span data-agent-status={status.key} className="inline-flex">
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </span>
            ) : null}
            {agent.visibility === "private" ? <MetaChip variant="soft">Only me</MetaChip> : null}
          </>
        }
        meta={agent.description ? [agent.description] : undefined}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={settings}
              data-agent-settings=""
            >
              <SettingsIcon />
              Settings
            </Button>
            <Button type="button" size="sm" className="pointer-coarse:h-11" onClick={chat}>
              <MessageSquareIcon />
              Chat
            </Button>
          </>
        }
      />
      <DetailPageBody
        aside={
          <DetailAside>
            {costText ? (
              <DetailAsideItem label="Cost">
                <span className="tabular-nums" data-agent-cost="">
                  {costText}
                </span>
              </DetailAsideItem>
            ) : null}
            {partnerName ? (
              <DetailAsideItem label="Works well with">
                <span data-agent-works-well-with="">{partnerName}</span>
              </DetailAsideItem>
            ) : null}
            <DetailAsideItem label="Who can use it">
              {agentAudienceLabel(agent.visibility, {
                workspaceName: workspace?.name ?? null,
                organizationName,
              })}
            </DetailAsideItem>
            {agent.visibility !== "private" ? (
              <DetailAsideItem label="Who can edit">
                {AGENT_EDIT_ACCESS_OPTIONS.find((option) => option.value === agent.editAccess)
                  ?.label ?? "Creator and admins"}
              </DetailAsideItem>
            ) : null}
          </DetailAside>
        }
      >
        {items ? <AgentReadinessSection items={items} onFinish={onFinishSetup} /> : null}
        <AgentWhenItWorks
          agent={agent}
          workspaceId={workspaceId}
          tasks={triggers.tasks}
          setTasks={triggers.setTasks}
        />
        <AgentChats agent={agent} workspaceId={workspaceId} title="Recent work" />
      </DetailPageBody>
    </DetailPage>
  );
}

/**
 * An agent's Settings: Instructions, Can use, Learns, who can use and edit
 * it (with Slack), Skills, export and delete. Each part saves on its own;
 * Edit opens the form for its name, description and Instructions.
 */
export function AgentSettingsPage({
  workspaceId,
  agentId,
  renderSlack,
}: {
  workspaceId: string;
  agentId: string;
  /** Where it is available in Slack, rendered under the app row. */
  renderSlack?: AgentSlackSlot | undefined;
}) {
  const { client, workspaces, accessContext } = useAppContext();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const toAgent = () =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId",
      params: { workspaceId, agentId },
    });
  const { state, agent, back, fallback } = useAgentOrFallback(
    workspaceId,
    agentId,
    "Agent",
    toAgent,
  );
  if (!agent) return <>{fallback}</>;
  const workspace = workspaces.find((row) => row.id === agent.workspaceId);
  const workspaceName = workspace?.name ?? null;
  const organizationName = workspace
    ? orgName(workspace.accountId, accessContext.accountGrants)
    : null;
  const saved = (next: Agent) => {
    state.set(next);
    forgetSessionAgent(workspaceId, next.id);
  };
  const edit = () =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId/edit",
      params: { workspaceId, agentId: agent.id },
    });
  return (
    <DetailPage back={{ ...back, label: agent.name }}>
      <DetailPageHeader
        title="Settings"
        meta={[agent.name]}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="pointer-coarse:size-11"
              aria-label="Export"
              title="Export as a file to import in another workspace"
              onClick={() => downloadAgentFile(agent)}
            >
              <DownloadIcon />
            </Button>
            {agent.viewer.canEdit ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={edit}
              >
                <PencilIcon />
                Edit
              </Button>
            ) : null}
          </>
        }
      />
      <DetailPageBody>
        <DetailSection title="Instructions">
          <Prose text={agent.instructions} empty="None. It works like an ordinary chat." />
        </DetailSection>
        <AgentCanUse agent={agent} workspaceId={workspaceId} onSaved={saved} />
        <DetailSection title="Learns">
          <MemoryRow agent={agent} workspaceId={workspaceId} onSaved={saved} />
          <AgentMemoryEntries agent={agent} workspaceId={workspaceId} />
        </DetailSection>
        <DetailSection title="Who can use it">
          <p className="m-0 text-sm text-fg">
            {agentAudienceLabel(agent.visibility, {
              workspaceName,
              organizationName,
            })}
          </p>
          {agent.visibility !== "private" ? (
            <EditAccessRow agent={agent} workspaceId={workspaceId} onSaved={saved} />
          ) : null}
          {/* The host's Slack rows name the app as each Slack workspace knows it. */}
          {agent.slack.length > 0 && !renderSlack ? (
            <p className="m-0 text-sm text-fg-muted" data-agent-slack-line="">
              Ask in Slack:{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 text-xs text-fg">
                {slackAgentCallText(agent.name)}
              </code>
            </p>
          ) : null}
          {renderSlack ? renderSlack({ agent, onAgentChange: saved }) : null}
        </DetailSection>
        <AgentSkills agent={agent} workspaceId={workspaceId} onSaved={saved} />
        {agentViewerCanManage(agent) ? (
          <SettingDangerRow
            label="Delete agent"
            description="Its chats stay as ordinary chats."
            onClick={() => setDeleting(true)}
          />
        ) : null}
      </DetailPageBody>
      <DestructiveConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${agent.name}?`}
        consequences={[
          "Its chats stay and continue as ordinary chats.",
          ...(agent.slack.length > 0 ? ["It stops answering in Slack."] : []),
          ...(agent.memory.collectionId ? ["Its Memory stays in Knowledge."] : []),
        ]}
        confirmLabel="Delete agent"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          try {
            await client.deleteAgent(workspaceId, agent.id);
            forgetSessionAgent(workspaceId, agent.id);
            toast.success(`Deleted ${agent.name}`);
            void navigate({ to: "/workspaces/$workspaceId/agents", params: { workspaceId } });
            return true;
          } catch (error) {
            toast.error(`Couldn't delete ${agent.name}`, { description: userErrorText(error) });
            return false;
          }
        }}
      />
    </DetailPage>
  );
}
