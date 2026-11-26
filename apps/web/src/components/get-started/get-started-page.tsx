/**
 * Get started: the guided setups (./guided-setups.ts). The list, and one
 * setup's three steps, each with one action. Nothing here is new machinery:
 * Connect opens the existing Connect pages, Add uses the Agents page's
 * ready-made add, and Turn on opens the agent page's Add trigger dialog.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChartLineIcon, GitPullRequestIcon, ListChecksIcon, RocketIcon } from "lucide-react";
import type { Agent, AgentSummary, AgentTemplate, CapabilityCatalogItem } from "@opengeni/sdk";

import { useAppContext } from "@opengeni/react/app/app-context";
import {
  addAgentSuggestedTrigger,
  AgentTriggerDialog,
  agentTriggerSaveError,
} from "@opengeni/react/app/components/agents/agent-trigger-dialog";
import { t } from "@opengeni/react/app/lib/console-text";
import { githubConnectedOf, githubConnectHref } from "@opengeni/react/app/lib/github-connect";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { toast } from "@opengeni/react/app/lib/toast";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { Notice } from "@opengeni/react/ui/notice";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { SettingRow, SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

import {
  GUIDED_SETUPS,
  agentForSetup,
  catalogConnectHref,
  catalogItemConnected,
  catalogItemFor,
  guidedSetupByKey,
  setupTriggerTask,
  type GuidedSetup,
} from "./guided-setups";

const SETUP_ICONS: Record<GuidedSetup["icon"], ReactNode> = {
  "git-pull-request": <GitPullRequestIcon />,
  "list-checks": <ListChecksIcon />,
  "chart-line": <ChartLineIcon />,
};

/** Each setup's tile hue, so the three read apart at a glance. */
const SETUP_HUES: Record<GuidedSetup["icon"], number> = {
  "git-pull-request": 275,
  "list-checks": 185,
  "chart-line": 45,
};

/** One setup's trigger: on, paused (with its task), none, or unknown when it can't be read. */
type TriggerState =
  | { kind: "on" }
  | { kind: "paused"; taskId: string }
  | { kind: "off" }
  | { kind: "unknown" };

/** What the page knows about the workspace; null while it reads. */
type SetupState = {
  /** Null when they can't be read: then nothing offers to add another. */
  agents: AgentSummary[] | null;
  /** Each setup's trigger, by key; absent while it has no agent. */
  triggers: Map<string, TriggerState>;
  /** The connector catalog; null when it can't be read. */
  catalog: CapabilityCatalogItem[] | null;
};

function useSetupState(workspaceId: string) {
  const { client } = useAppContext();
  const [state, setState] = useState<SetupState | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let live = true;
    void (async () => {
      // Each read degrades on its own: a step it can't read shows as not done.
      const [agents, catalog] = await Promise.all([
        client.listAgents(workspaceId).catch(() => null),
        client
          .listCapabilities(workspaceId)
          .then((response) => response.items)
          .catch(() => null),
      ]);
      const triggers = new Map<string, TriggerState>();
      await Promise.all(
        GUIDED_SETUPS.map(async (setup) => {
          const agent = agents ? agentForSetup(agents, setup) : null;
          if (!agent) return;
          const tasks = await client
            .listScheduledTasks(workspaceId, { agentId: agent.id, limit: 200 })
            .catch(() => null);
          const task = tasks ? setupTriggerTask(tasks, agent.id, setup) : null;
          triggers.set(
            setup.key,
            !tasks
              ? { kind: "unknown" }
              : !task
                ? { kind: "off" }
                : task.status === "active"
                  ? { kind: "on" }
                  : { kind: "paused", taskId: task.id },
          );
        }),
      );
      if (live) setState({ agents, triggers, catalog });
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, revision]);
  return { state, reload };
}

export function GetStartedPage({
  workspaceId,
  setupKey,
}: {
  workspaceId: string;
  setupKey?: string | undefined;
}) {
  const navigate = useNavigate();
  const { state, reload } = useSetupState(workspaceId);
  const open = (key: string | undefined) =>
    void navigate({
      to: "/workspaces/$workspaceId/get-started",
      params: { workspaceId },
      search: key ? { setup: key } : {},
    });
  const setup = guidedSetupByKey(setupKey);
  if (setup) {
    return (
      <GuidedSetupSteps
        key={setup.key}
        workspaceId={workspaceId}
        setup={setup}
        state={state}
        reload={reload}
        onBack={() => open(undefined)}
      />
    );
  }
  return (
    <DetailPage>
      <DetailPageHeader
        leading={<LogoTile name="Get started" icon={<RocketIcon />} hue={160} />}
        title="Get started"
        meta={["Pick a setup. Each ends with an agent at work."]}
      />
      <DetailSection title="Setups">
        <RowList label="Setups" variant="catalog" busy={state === null}>
          {state === null ? (
            <ListRowSkeleton count={GUIDED_SETUPS.length} />
          ) : (
            GUIDED_SETUPS.map((entry) => (
              <ListRow
                key={entry.key}
                leading={
                  <LogoTile
                    name={entry.title}
                    icon={SETUP_ICONS[entry.icon]}
                    hue={SETUP_HUES[entry.icon]}
                  />
                }
                title={entry.title}
                description={entry.description}
                status={
                  state.triggers.get(entry.key)?.kind === "on" ? (
                    <StatusBadge status="ready" variant="dot" />
                  ) : undefined
                }
                onOpen={() => open(entry.key)}
              />
            ))
          )}
        </RowList>
      </DetailSection>
    </DetailPage>
  );
}

function DoneBadge({ children = "Done" }: { children?: ReactNode }) {
  return (
    <StatusBadge tone="success" variant="dot">
      {children}
    </StatusBadge>
  );
}

function GuidedSetupSteps({
  workspaceId,
  setup,
  state,
  reload,
  onBack,
}: {
  workspaceId: string;
  setup: GuidedSetup;
  state: SetupState | null;
  reload: () => void;
  onBack: () => void;
}) {
  const context = useAppContext();
  const { client, accessContext } = context;
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [triggerOpen, setTriggerOpen] = useState(false);

  const summary = state?.agents ? agentForSetup(state.agents, setup) : null;
  const agentId = agent?.id ?? summary?.id ?? null;
  // The full agent, for the Add trigger dialog.
  useEffect(() => {
    if (!summary || agent?.id === summary.id) return;
    let live = true;
    client.getAgent(workspaceId, summary.id).then(
      (full) => live && setAgent(full),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [agent?.id, client, summary, workspaceId]);
  // The template's suggested trigger this setup turns on.
  useEffect(() => {
    let live = true;
    client.listAgentTemplates(workspaceId).then(
      (list) =>
        live && setTemplate(list.find((entry) => entry.key === setup.agentTemplateKey) ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, setup.agentTemplateKey, workspaceId]);
  const suggestion = template?.suggestedTriggers.find((entry) => entry.name === setup.triggerName);

  // Step 1: the connection.
  const connection = setup.connection;
  const catalogItem =
    connection.kind === "catalog" && state?.catalog
      ? catalogItemFor(state.catalog, connection.mcpUrl)
      : null;
  const githubStatus = context.githubStatus?.status;
  const connected =
    connection.kind === "github"
      ? githubConnectedOf(githubStatus) === true
      : catalogItemConnected(catalogItem);
  // A connector this deployment doesn't offer, or GitHub without its app here.
  const notOffered =
    connection.kind === "github"
      ? githubStatus === "disabled"
      : state?.catalog != null && catalogItem === null;
  const connect = () =>
    void navigate({
      href:
        connection.kind === "github"
          ? githubConnectHref(workspaceId)
          : catalogConnectHref(workspaceId, catalogItem?.id ?? null),
    });

  // Step 2: the agent.
  const canAdd = hasWorkspacePermission(accessContext, workspaceId, "sessions:create");
  const agentsUnknown = state !== null && state.agents === null && !agent;
  const addAgent = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const created = await client.createAgentFromTemplate(workspaceId, setup.agentTemplateKey, {
        editAccess: "everyone",
      });
      setAgent(created);
      toast.success(`Added ${created.name}`);
      reload();
    } catch (error) {
      toast.error(`Couldn't add ${setup.agentName}`, { description: userErrorText(error) });
    } finally {
      setAdding(false);
    }
  };
  const openAgent = () => {
    if (!agentId) return;
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId",
      params: { workspaceId, agentId },
    });
  };

  // Step 3: the trigger.
  const trigger = state?.triggers.get(setup.key) ?? null;
  const triggerOn = trigger?.kind === "on";
  const ready = Boolean(agentId) && triggerOn;
  const canEditAgent = agent?.viewer.canEdit !== false;
  const resume = async (taskId: string) => {
    setTurningOn(true);
    try {
      await client.resumeScheduledTask(workspaceId, taskId);
      reload();
    } catch (error) {
      toast.error("Couldn't turn on the trigger", { description: userErrorText(error) });
    } finally {
      setTurningOn(false);
    }
  };
  // A one-click suggestion is added as it is; anything it lacks opens the dialog.
  const turnOn = async () => {
    if (!agent || !suggestion || turningOn) return;
    if (!suggestion.oneClick) {
      setTriggerOpen(true);
      return;
    }
    setTurningOn(true);
    try {
      const outcome = await addAgentSuggestedTrigger(t, {
        client,
        workspaceId,
        agent,
        suggestion,
        githubConnected: githubConnectedOf(githubStatus),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: new Date(),
      });
      if (outcome.kind === "needs_setup") {
        setTriggerOpen(true);
        return;
      }
      toast.success("Trigger added", { description: outcome.task.name });
      reload();
    } catch (error) {
      toast.error("Couldn't add the trigger", {
        description: agentTriggerSaveError(
          error,
          agent.visibility === "private" ? "private" : "workspace",
        ),
      });
    } finally {
      setTurningOn(false);
    }
  };
  const triggerDescription = !agentId
    ? `Add ${setup.agentName} first.`
    : trigger?.kind === "unknown"
      ? "Couldn't check its triggers."
      : !canEditAgent
        ? `Needs edit access to ${setup.agentName}.`
        : undefined;

  return (
    <DetailPage back={{ label: "Get started", onClick: onBack }}>
      <DetailPageHeader
        leading={
          <LogoTile
            name={setup.title}
            icon={SETUP_ICONS[setup.icon]}
            hue={SETUP_HUES[setup.icon]}
          />
        }
        title={setup.title}
        meta={[setup.description]}
      />
      {ready ? (
        <Notice tone="success" className="mt-6">
          {setup.ready}
        </Notice>
      ) : null}
      <DetailSection title="Steps">
        {state === null ? (
          <SettingRowSkeleton />
        ) : (
          <>
            <SettingRow
              data-guided-step="connect"
              label={`1. Connect ${connection.name}`}
              description={notOffered ? `${connection.name} isn't offered here.` : undefined}
              control={
                connected ? (
                  <DoneBadge>Connected</DoneBadge>
                ) : notOffered ? undefined : (
                  <RowButton onClick={connect}>Connect</RowButton>
                )
              }
            />
            <SettingRow
              data-guided-step="agent"
              label={`2. Add ${setup.agentName}`}
              description={
                agentsUnknown
                  ? "Couldn't check your agents."
                  : !agentId && !canAdd
                    ? "Ask a workspace admin to add it."
                    : (template?.description ?? undefined)
              }
              control={
                agentId ? (
                  <RowButton onClick={openAgent}>Open</RowButton>
                ) : agentsUnknown ? (
                  <RowButton onClick={reload}>Retry</RowButton>
                ) : canAdd ? (
                  <RowButton disabled={adding} onClick={() => void addAgent()}>
                    Add
                  </RowButton>
                ) : undefined
              }
            />
            <SettingRow
              data-guided-step="trigger"
              label={`3. ${setup.triggerLabel}`}
              description={triggerDescription}
              control={
                triggerOn ? (
                  <DoneBadge>On</DoneBadge>
                ) : trigger?.kind === "unknown" ? (
                  <RowButton onClick={reload}>Retry</RowButton>
                ) : trigger?.kind === "paused" ? (
                  <RowButton
                    disabled={!canEditAgent || turningOn}
                    onClick={() => void resume(trigger.taskId)}
                  >
                    Turn on
                  </RowButton>
                ) : (
                  <RowButton
                    disabled={!agent || !suggestion || !canEditAgent || turningOn}
                    onClick={() => void turnOn()}
                  >
                    Turn on
                  </RowButton>
                )
              }
            />
          </>
        )}
      </DetailSection>
      {agent && suggestion ? (
        <AgentTriggerDialog
          agent={agent}
          workspaceId={workspaceId}
          suggestion={suggestion}
          open={triggerOpen}
          onOpenChange={setTriggerOpen}
          onCreated={(task) => {
            setTriggerOpen(false);
            toast.success("Trigger added", { description: task.name });
            reload();
          }}
          onOpenFullForm={(start) =>
            void navigate({
              to: "/workspaces/$workspaceId/automations/new",
              params: { workspaceId },
              search: {
                agent: agent.id,
                ...(template
                  ? { agentTrigger: template.suggestedTriggers.indexOf(suggestion) }
                  : {}),
                ...(start.sourceId ? { source: start.sourceId } : {}),
                returnTo: "agent",
              },
              ...(start.note || start.chat
                ? { state: { agentTriggerStart: { note: start.note, chat: start.chat } } }
                : {}),
            })
          }
          onAddSource={(kind) =>
            void navigate({
              to: "/workspaces/$workspaceId/automations/sources/new",
              params: { workspaceId },
              search: kind ? { kind } : {},
            })
          }
        />
      ) : null}
    </DetailPage>
  );
}
