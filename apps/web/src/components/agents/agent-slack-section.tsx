/**
 * Where an agent is available in Slack: one row per connected Slack workspace,
 * with its handle, open use and channel intros. Turning it on checks its name
 * against Slack's rules there; the API says what it can't take.
 */
import { useState } from "react";
import {
  SLACK_AGENT_OPEN_LABEL,
  SLACK_AGENT_OPEN_NARROWED_NOTICE,
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

/** How people ask the agent in Slack: `@Opengeni +data-team`. */
export function agentSlackCall(handle: string): string {
  return `@Opengeni +${handle}`;
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

const ADMIN_ONLY = "Only a workspace admin can change this.";
const ORG_ADMIN_ONLY = "Only an organization admin can turn this on.";

function InstallRow({
  agent,
  install,
  workspaceName,
  onChange,
  onIntroduce,
}: {
  agent: Agent;
  install: AgentSlackInstall;
  workspaceName: string;
  onChange: (agent: Agent, install: AgentSlackInstall) => void;
  onIntroduce: (connectionId: string) => void;
}) {
  const { client } = useAppContext();
  const [pending, setPending] = useState<"availability" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const availability = install.availability;
  const on = availability !== null;
  const teamName = install.slackTeamName ?? "Slack workspace";
  const canManage = agent.viewer.canManageSlack;
  const shared = agent.visibility === "workspace";
  const privateReason = `Needs ${workspacePeopleLabel(workspaceName)} under Who can use it.`;

  async function run(
    kind: "availability" | "open",
    action: () => Promise<{ agent: Agent; availability: AgentSlackInstall["availability"] }>,
  ) {
    setPending(kind);
    setError(null);
    try {
      const result = await action();
      onChange(result.agent, { ...install, availability: result.availability });
    } catch (failure) {
      setError(agentSlackErrorText(failure, agent.name));
    } finally {
      setPending(null);
    }
  }

  return (
    <SettingRow
      label={`Slack · ${teamName}`}
      description={
        availability ? (
          <>
            People ask it with{" "}
            <span className="font-medium text-fg" data-agent-slack-handle="">
              {agentSlackCall(availability.handle)}
            </span>
          </>
        ) : shared ? (
          "Off"
        ) : (
          privateReason
        )
      }
      error={error ?? undefined}
      control={
        <Switch
          aria-label={`Available in ${teamName}`}
          checked={on}
          pending={pending === "availability"}
          disabled={!canManage || (!on && !shared)}
          disabledReason={!canManage ? ADMIN_ONLY : !shared ? privateReason : undefined}
          onCheckedChange={(next) =>
            void run("availability", () =>
              next
                ? client.putAgentSlackAvailability(
                    agent.workspaceId,
                    agent.id,
                    install.connectionId,
                    {},
                  )
                : client.deleteAgentSlackAvailability(
                    agent.workspaceId,
                    agent.id,
                    install.connectionId,
                  ),
            )
          }
        />
      }
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
                pending={pending === "open"}
                disabled={!canManage || (!availability.open && !agent.viewer.canOpenInSlack)}
                disabledReason={!canManage ? ADMIN_ONLY : ORG_ADMIN_ONLY}
                onCheckedChange={(next) =>
                  void run("open", () =>
                    client.putAgentSlackAvailability(
                      agent.workspaceId,
                      agent.id,
                      install.connectionId,
                      { expectedVersion: availability.version, open: next },
                    ),
                  )
                }
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
          workspaceName={workspaceName}
          onIntroduce={onIntroduce}
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
