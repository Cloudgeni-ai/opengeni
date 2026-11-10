/**
 * One agent: chat with it, its chats, what it follows (Instructions and First
 * message), Memory, who can use it and where it is available. The app is
 * always on; the host renders the Slack part (`renderSlack`), which needs the
 * Slack integration's own pieces.
 */
import { useState, type ReactNode } from "react";
import { DownloadIcon, MessageSquareIcon, PencilIcon } from "lucide-react";
import type { Agent, AgentChat, AgentChatsFilter } from "@opengeni/contracts";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { DetailPage, DetailPageBody, DetailPageHeader } from "../../../ui/detail-page";
import { DetailSection, DetailSkeleton } from "../../../ui/detail-sheet";
import { ErrorMessage } from "../../../ui/error-message";
import { inAppClick } from "../../../ui/in-app-click";
import { ListRow, ListRowSkeleton, RowList } from "../../../ui/list-row";
import { MetaChip } from "../../../ui/meta-chip";
import { RelativeTime } from "../../../ui/relative-time";
import { SegmentedControl } from "../../../ui/segmented-control";
import { SettingDangerRow, SettingRow } from "../../../ui/setting-row";
import { Switch } from "../../../ui/switch";
import { useAppContext } from "../../app-context";
import { agentAvatar } from "../../lib/agent-avatar";
import { agentErrorCode, downloadAgentFile, useAgent, useAgentChats } from "../../lib/agents";
import { useNavigate } from "../../lib/navigation";
import { forgetSessionAgent } from "../../lib/session-agent";
import { toast } from "../../lib/toast";
import { slackLogo } from "../new-session-starter-logos";
import { SessionAvatar } from "../session/session-avatar";
import { DestructiveConfirm } from "../ui/destructive-confirm";

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

function AgentChats({ agent, workspaceId }: { agent: Agent; workspaceId: string }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AgentChatsFilter>("yours");
  const chats = useAgentChats(workspaceId, agent.id, filter);
  // An Only me agent's chats are all its owner's.
  const shared = agent.visibility === "workspace";
  return (
    <DetailSection
      title="Chats"
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
    ? `/workspaces/${encodeURIComponent(workspaceId)}/state?entry=${encodeURIComponent(collectionId)}`
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

export function AgentPage({
  workspaceId,
  agentId,
  renderSlack,
}: {
  workspaceId: string;
  agentId: string;
  /** Where it is available in Slack, rendered under the app row. */
  renderSlack?: AgentSlackSlot | undefined;
}) {
  const { client, workspaces } = useAppContext();
  const navigate = useNavigate();
  const state = useAgent(workspaceId, agentId);
  const [deleting, setDeleting] = useState(false);
  const back = {
    label: "Agents",
    onClick: () =>
      void navigate({ to: "/workspaces/$workspaceId/agents", params: { workspaceId } }),
  };
  const agent = state.agent;
  if (agent === undefined) {
    return (
      <DetailPage back={back}>
        <DetailSkeleton sections={3} />
      </DetailPage>
    );
  }
  if (agent === null) {
    return (
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
  const workspaceName = workspaces.find((row) => row.id === agent.workspaceId)?.name ?? null;
  const saved = (next: Agent) => {
    state.set(next);
    forgetSessionAgent(workspaceId, next.id);
  };
  const chat = () =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions",
      params: { workspaceId },
      search: { agent: agent.id },
    });
  const edit = () =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId/edit",
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
          agent.visibility === "private" ? <MetaChip variant="soft">Only me</MetaChip> : undefined
        }
        meta={agent.description ? [agent.description] : undefined}
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
            <Button type="button" size="sm" className="pointer-coarse:h-11" onClick={chat}>
              <MessageSquareIcon />
              Chat
            </Button>
          </>
        }
      />
      <DetailPageBody>
        <AgentChats agent={agent} workspaceId={workspaceId} />
        <DetailSection title="Instructions">
          <Prose text={agent.instructions} empty="None. It works like an ordinary chat." />
        </DetailSection>
        <DetailSection title="Memory">
          <MemoryRow agent={agent} workspaceId={workspaceId} onSaved={saved} />
        </DetailSection>
        <DetailSection title="Who can use it">
          <p className="m-0 text-sm text-fg">
            {agent.visibility === "private" ? "Only me" : workspacePeopleLabel(workspaceName)}
          </p>
        </DetailSection>
        <DetailSection title="Available in">
          <SettingRow
            label="Opengeni app"
            description="Always on. Start a chat with it from the composer."
          />
          {renderSlack ? renderSlack({ agent, onAgentChange: saved }) : null}
        </DetailSection>
        {agent.viewer.canEdit ? (
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
