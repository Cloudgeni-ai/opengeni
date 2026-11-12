/**
 * Where an agent works in Slack: one row per Slack workspace linked to its
 * workspace. A shared agent is available in each of them on its own; a row
 * says how people ask it there, or why it can't be (Only me, its name), with
 * open use and channel intros under it.
 */
import { useState } from "react";
import {
  SLACK_AGENT_OPEN_LABEL,
  SLACK_AGENT_OPEN_NARROWED_NOTICE,
  slackAgentCallText,
  slackAgentNameProblem,
  slackAgentNameProblemText,
  slackAgentOpenDisclosure,
  type SlackAgentNameProblem,
} from "@opengeni/contracts";
import type { Agent, AgentSlackInstall } from "@opengeni/sdk";

import { useAppContext } from "@opengeni/react/app/app-context";
import { workspacePeopleLabel } from "@opengeni/react/app/components/agents/agent-page";
import { agentErrorCode, useAgentSlackInstalls } from "@opengeni/react/app/lib/agents";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import { apiErrorDetails, userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Notice } from "@opengeni/react/ui/notice";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { SettingRow, SettingRowLink } from "@opengeni/react/ui/setting-row";
import { Skeleton } from "@opengeni/react/ui/skeleton";
import { Switch } from "@opengeni/react/ui/switch";

/** How people ask the agent in Slack: `@Opengeni Data team`. */
export function agentSlackCall(name: string): string {
  return slackAgentCallText(name);
}

/** Why Slack refused, in words; falls back to the server's own message. */
export function agentSlackErrorText(error: unknown, agentName: string): string {
  switch (agentErrorCode(error)) {
    case "agent_slack_name_taken":
      return `Another agent in this Slack workspace is called “${agentName}”. Rename this one first.`;
    case "agent_slack_name_invalid": {
      const details = (error as { details?: { problem?: unknown } }).details;
      const problem = typeof details?.problem === "string" ? details.problem : null;
      return problem
        ? `${slackAgentNameProblemText(agentName, problem as SlackAgentNameProblem)} Rename it first.`
        : "Slack can't use this name. Rename it first.";
    }
    case "agent_slack_requires_workspace_visibility":
      return "Only agents everyone in the workspace can use can be in Slack. Change Who can use it first.";
    case "slack_bot_unavailable":
      return "The Opengeni Slack app isn't on for this workspace. An organization admin can turn it on from the Slack page.";
    case "agent_slack_personal_workspace":
      return "Agents in a personal workspace stay in the app.";
    case "agent_version_conflict":
      return "Someone else changed this. Reload to see their change, then try again.";
    default:
      return userErrorText(error);
  }
}

/** What Move here drops, said next to the button. */
export const AGENT_SLACK_MOVE_RESETS =
  "Moving it here turns off open use and clears its channel settings and intros there.";

/** Why the agent isn't available in one linked Slack workspace, in words. */
export function agentSlackUnavailableText(
  agent: Pick<Agent, "name">,
  install: AgentSlackInstall,
  installs: readonly AgentSlackInstall[],
  workspaceName: string,
): string {
  switch (install.unavailable) {
    case "agent_slack_requires_workspace_visibility":
      return `Only me agents stay in the app. Choose ${workspacePeopleLabel(workspaceName)} under Who can use it to use it in Slack.`;
    case "agent_slack_personal_workspace":
      return "Agents in a personal workspace stay in the app.";
    case "agent_slack_name_taken":
      return `Another agent here is already called “${agent.name}”. Rename this one to use it in Slack.`;
    case "agent_slack_name_invalid": {
      const problem = slackAgentNameProblem(agent.name);
      return problem
        ? `${slackAgentNameProblemText(agent.name, problem)} Rename it to use it in Slack.`
        : "Slack can't use this name. Rename it to use it in Slack.";
    }
    case "agent_slack_single_install": {
      // An agent is in one Slack workspace at a time until the agents
      // contract step lifts it; this case goes with it.
      const other = installs.find(
        (row) => row.connectionId !== install.connectionId && row.availability !== null,
      );
      return `For now an agent works in one Slack workspace, and it's in ${other?.slackTeamName ?? "another one"}.`;
    }
    default:
      return "Not available yet. Reload to try again.";
  }
}

const ADMIN_ONLY = "Only a workspace admin can change this.";
const ORG_ADMIN_ONLY = "Only an organization admin can turn this on.";

function InstallRow({
  agent,
  install,
  installs,
  workspaceName,
  onChange,
  onMoved,
  onIntroduce,
}: {
  agent: Agent;
  install: AgentSlackInstall;
  installs: readonly AgentSlackInstall[];
  workspaceName: string;
  onChange: (agent: Agent, install: AgentSlackInstall) => void;
  onMoved: (agent: Agent) => void;
  onIntroduce: (connectionId: string) => void;
}) {
  const { client } = useAppContext();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = install.availability;
  const teamName = install.slackTeamName ?? "Slack workspace";
  const canManage = agent.viewer.canManageSlack;

  async function setOpen(open: boolean, version: number) {
    setPending(true);
    setError(null);
    try {
      const result = await client.putAgentSlackAvailability(
        agent.workspaceId,
        agent.id,
        install.connectionId,
        { expectedVersion: version, open },
      );
      onChange(result.agent, { ...install, availability: result.availability, unavailable: null });
    } catch (failure) {
      setError(agentSlackErrorText(failure, agent.name));
    } finally {
      setPending(false);
    }
  }

  // While an agent is in one Slack workspace at a time, choosing another one moves it.
  async function moveHere() {
    setPending(true);
    setError(null);
    try {
      const result = await client.putAgentSlackAvailability(
        agent.workspaceId,
        agent.id,
        install.connectionId,
        {},
      );
      onMoved(result.agent);
    } catch (failure) {
      setError(agentSlackErrorText(failure, agent.name));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingRow
      label={`Slack · ${teamName}`}
      control={
        !availability && install.unavailable === "agent_slack_single_install" && canManage ? (
          <RowButton disabled={pending} onClick={() => void moveHere()}>
            Move here
          </RowButton>
        ) : undefined
      }
      description={
        availability ? (
          <>
            People ask it with{" "}
            <span className="font-medium text-fg" data-agent-slack-handle="">
              {agentSlackCall(agent.name)}
            </span>
          </>
        ) : canManage && install.unavailable === "agent_slack_single_install" ? (
          `${agentSlackUnavailableText(agent, install, installs, workspaceName)} ${AGENT_SLACK_MOVE_RESETS}`
        ) : (
          agentSlackUnavailableText(agent, install, installs, workspaceName)
        )
      }
      error={error ?? undefined}
    >
      {availability ? (
        <>
          <SettingRow
            label={SLACK_AGENT_OPEN_LABEL}
            description={slackAgentOpenDisclosure(agent.name, workspaceName)}
            control={
              <Switch
                aria-label={SLACK_AGENT_OPEN_LABEL}
                checked={availability.open}
                pending={pending}
                disabled={!canManage || (!availability.open && !agent.viewer.canOpenInSlack)}
                disabledReason={!canManage ? ADMIN_ONLY : ORG_ADMIN_ONLY}
                onCheckedChange={(next) => void setOpen(next, availability.version)}
              />
            }
          />
          {availability.open ? (
            <Notice className="my-3">{SLACK_AGENT_OPEN_NARROWED_NOTICE}</Notice>
          ) : null}
          {canManage ? (
            <SettingRow
              label="Introduce in channels"
              description="Post a short intro so people know to ask it."
              control={
                <RowButton onClick={() => onIntroduce(install.connectionId)}>Introduce</RowButton>
              }
            />
          ) : null}
        </>
      ) : null}
    </SettingRow>
  );
}

export function AgentSlackSection({
  agent,
  onAgentChange,
  onIntroduce,
}: {
  agent: Agent;
  onAgentChange: (agent: Agent) => void;
  onIntroduce: (connectionId: string) => void;
}) {
  const { workspaces } = useAppContext();
  const navigate = useNavigate();
  const installs = useAgentSlackInstalls(agent.workspaceId, agent.id);
  const workspaceName = workspaces.find((row) => row.id === agent.workspaceId)?.name ?? "";
  const value = installs.value;
  if (value === undefined) {
    return (
      <div className="grid gap-2 py-3" aria-busy="true" aria-label="Loading Slack">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-64" />
      </div>
    );
  }
  if (installs.error && value.installs.length === 0) {
    return (
      <ErrorMessage
        variant="inline"
        className="my-3"
        title="Couldn't load Slack"
        {...apiErrorDetails(installs.error)}
        action={
          <Button type="button" variant="outline" size="sm" onClick={installs.reload}>
            Try again
          </Button>
        }
      >
        {userErrorText(installs.error)}
      </ErrorMessage>
    );
  }
  if (value.installs.length === 0) {
    const href = `/workspaces/${encodeURIComponent(agent.workspaceId)}/plugins?open=integration:slack`;
    return (
      <SettingRow
        label="Slack"
        description="No Slack workspace is connected here."
        hint={
          agent.viewer.canManageSlack ? (
            <SettingRowLink onClick={() => void navigate({ href })}>Connect Slack</SettingRowLink>
          ) : undefined
        }
      />
    );
  }
  const anyOn = value.installs.some((install) => install.availability !== null);
  // A reason that comes from the agent itself, such as Only me, is the same
  // in every Slack workspace, so it is said once.
  const first = value.installs[0]!;
  if (
    !anyOn &&
    (first.unavailable === "agent_slack_requires_workspace_visibility" ||
      first.unavailable === "agent_slack_personal_workspace") &&
    value.installs.every((install) => install.unavailable === first.unavailable)
  ) {
    return (
      <SettingRow
        label="Slack"
        description={agentSlackUnavailableText(agent, first, value.installs, workspaceName)}
      />
    );
  }
  return (
    <>
      {!value.routingEnabled && anyOn ? (
        <Notice className="my-3">
          This server doesn't route Slack channels to workspaces, so agents don't answer in Slack.
        </Notice>
      ) : null}
      {value.installs.map((install) => (
        <InstallRow
          key={install.connectionId}
          agent={agent}
          install={install}
          installs={value.installs}
          workspaceName={workspaceName}
          onIntroduce={onIntroduce}
          onMoved={(nextAgent) => {
            onAgentChange(nextAgent);
            installs.reload();
          }}
          onChange={(nextAgent, nextInstall) => {
            onAgentChange(nextAgent);
            installs.set({
              ...value,
              installs: value.installs.map((row) =>
                row.connectionId === nextInstall.connectionId ? nextInstall : row,
              ),
            });
          }}
        />
      ))}
    </>
  );
}
