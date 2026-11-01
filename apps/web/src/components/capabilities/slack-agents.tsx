/**
 * Slack agents: named teammates people call through the one Opengeni Slack
 * app with `@Opengeni +name`. Each works in one fixed Opengeni workspace.
 * The list shows every agent in the organization to anyone; edit and delete
 * appear only where the reader administers the agent's workspace.
 */
import { useCallback, useEffect, useState } from "react";
import type { SlackAgent } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import { SessionAvatar } from "@opengeni/react/app/components/session/session-avatar";
import {
  apiErrorDetails,
  isPermissionDenied,
  userErrorText,
  userErrorTextWithoutReference,
} from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { Notice } from "@opengeni/react/ui/notice";

/** How people call an agent in Slack. */
export function slackAgentCall(agent: Pick<SlackAgent, "handle">): string {
  return `@Opengeni +${agent.handle}`;
}

/** The reason code the API put in a refusal's details, such as `slack_bot_unavailable`. */
export function slackAgentErrorCode(error: unknown): string | null {
  if (!(error instanceof OpenGeniApiError)) return null;
  const code = error.details?.code;
  return typeof code === "string" ? code : null;
}

export type SlackAgentsState = {
  /** Undefined while the first load runs. */
  agents: SlackAgent[] | undefined;
  routingEnabled: boolean;
  /** This workspace saves new Knowledge for review first. */
  memoryReviewFirst: boolean;
  error: unknown;
  reload: () => void;
  /** Apply a local change (a create, edit or delete) without reloading. */
  replace: (update: (agents: SlackAgent[]) => SlackAgent[]) => void;
};

/** Every Slack agent in the organization of `workspaceId`. */
export function useSlackAgents(workspaceId: string): SlackAgentsState {
  const { client } = useAppContext();
  const [agents, setAgents] = useState<SlackAgent[] | undefined>(undefined);
  const [routingEnabled, setRoutingEnabled] = useState(true);
  const [memoryReviewFirst, setMemoryReviewFirst] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    void client
      .listOpenGeniSlackAgents(workspaceId)
      .then((result) => {
        if (!live) return;
        setAgents(result.agents);
        setRoutingEnabled(result.routingEnabled);
        setMemoryReviewFirst(result.memoryReviewFirst);
      })
      .catch((failure: unknown) => {
        if (!live) return;
        setError(failure);
        setAgents((current) => current ?? []);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const replace = useCallback(
    (update: (agents: SlackAgent[]) => SlackAgent[]) =>
      setAgents((current) => update(current ?? [])),
    [],
  );
  return { agents, routingEnabled, memoryReviewFirst, error, reload, replace };
}

export function SlackAgentsSection({
  workspaceId,
  state,
  canCreate,
  createUnavailable,
  onCreate,
  onEdit,
  onIntroduce,
}: {
  workspaceId: string;
  state: SlackAgentsState;
  /** The reader administers this workspace, where new agents work. */
  canCreate: boolean;
  /** Why agents can't be created here yet, shown in place of the action. */
  createUnavailable?: string | null | undefined;
  onCreate: () => void;
  onEdit: (agent: SlackAgent) => void;
  onIntroduce: (agent: SlackAgent) => void;
}) {
  const { client, workspaces } = useAppContext();
  const [deleting, setDeleting] = useState<SlackAgent | null>(null);
  const { agents, error } = state;
  const workspaceName = (agent: SlackAgent) =>
    agent.targetWorkspaceName ??
    workspaces.find((workspace) => workspace.id === agent.targetWorkspaceId)?.name ??
    "Another workspace";
  const createAction = canCreate && !createUnavailable;
  // Nothing to show and nothing to do: no empty card.
  if (agents?.length === 0 && !error && !canCreate) return null;
  return (
    <DetailSection
      title="Slack agents"
      description="Agents people call in Slack. Each works in one Opengeni workspace."
      action={
        createAction && agents && agents.length > 0 ? (
          <Button size="sm" variant="outline" onClick={onCreate}>
            Create agent
          </Button>
        ) : undefined
      }
    >
      {!state.routingEnabled && agents && agents.length > 0 ? (
        <Notice className="mb-3">
          This server doesn't route Slack channels to workspaces, so Slack agents don't answer.
        </Notice>
      ) : null}
      {error && isPermissionDenied(error) ? (
        <p className="text-sm text-fg-muted">
          Only workspace members can see Slack agents. Ask a workspace admin for access.
        </p>
      ) : error ? (
        <ErrorMessage
          variant="inline"
          title="Couldn't load Slack agents"
          {...apiErrorDetails(error)}
          action={
            <Button variant="outline" size="sm" onClick={state.reload}>
              Try again
            </Button>
          }
        >
          {userErrorTextWithoutReference(error)}
        </ErrorMessage>
      ) : agents === undefined ? (
        <RowList label="Slack agents" flush busy>
          <ListRowSkeleton count={2} />
        </RowList>
      ) : agents.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-fg-muted">{createUnavailable ?? "No Slack agents yet."}</p>
          {createAction ? (
            <Button size="sm" onClick={onCreate}>
              Create agent
            </Button>
          ) : null}
        </div>
      ) : (
        <RowList label="Slack agents" flush>
          {agents.map((agent) => (
            <ListRow
              key={agent.id}
              leading={
                <SessionAvatar
                  avatar={agent.avatar}
                  name={agent.name}
                  workspaceId={agent.targetWorkspaceId}
                  seed={agent.id}
                  size="md"
                />
              }
              title={agent.name}
              description={agent.description}
              meta={[
                workspaceName(agent),
                slackAgentCall(agent),
                ...(agent.open ? ["Anyone in Slack"] : []),
              ]}
              onOpen={agent.viewerCanManage ? () => onEdit(agent) : undefined}
              menuLabel={`More actions for ${agent.name}`}
              menu={
                agent.viewerCanManage ? (
                  <>
                    <DropdownMenuItem onSelect={() => onEdit(agent)}>Edit</DropdownMenuItem>
                    {agent.targetWorkspaceId === workspaceId ? (
                      <DropdownMenuItem onSelect={() => onIntroduce(agent)}>
                        Introduce in channels
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(agent)}>
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : undefined
              }
            />
          ))}
        </RowList>
      )}
      <DestructiveConfirm
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? "this Slack agent"}?`}
        consequences={[
          "Its channel settings are removed.",
          deleting?.knowledgeCollectionId ? "Its chats and Memory stay." : "Its chats stay.",
        ]}
        confirmLabel="Delete agent"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          const agent = deleting;
          if (!agent) return true;
          try {
            await client.deleteOpenGeniSlackAgent(agent.targetWorkspaceId, agent.id);
            state.replace((current) => current.filter((entry) => entry.id !== agent.id));
            toast.success(`Deleted ${agent.name}`);
            return true;
          } catch (failure) {
            toast.error(`Couldn't delete ${agent.name}`, { description: userErrorText(failure) });
            return false;
          }
        }}
      />
    </DetailSection>
  );
}
