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
import { AgentTriggerDialog } from "@opengeni/react/app/components/agents/agent-trigger-dialog";
import { githubConnectedOf, githubConnectHref } from "@opengeni/react/app/lib/github-connect";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import { toast } from "@opengeni/react/app/lib/toast";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
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
  setupTriggerOn,
  type GuidedSetup,
} from "./guided-setups";

const SETUP_ICONS: Record<GuidedSetup["icon"], ReactNode> = {
  "git-pull-request": <GitPullRequestIcon />,
  "list-checks": <ListChecksIcon />,
  "chart-line": <ChartLineIcon />,
};

/** What the page knows about the workspace; null while it reads. */
type SetupState = {
  agents: AgentSummary[];
  /** The setups whose trigger is on, by key. */
  triggersOn: Set<string>;
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
        client.listAgents(workspaceId).catch(() => [] as AgentSummary[]),
        client
          .listCapabilities(workspaceId)
          .then((response) => response.items)
          .catch(() => null),
      ]);
      const triggersOn = new Set<string>();
      await Promise.all(
        GUIDED_SETUPS.map(async (setup) => {
          const agent = agentForSetup(agents, setup);
          if (!agent) return;
          const tasks = await client
            .listScheduledTasks(workspaceId, { agentId: agent.id, limit: 200 })
            .catch(() => []);
          if (setupTriggerOn(tasks, agent.id, setup)) triggersOn.add(setup.key);
        }),
      );
      if (live) setState({ agents, triggersOn, catalog });
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
        leading={<LogoTile name="Get started" icon={<RocketIcon />} />}
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
                leading={<LogoTile name={entry.title} icon={SETUP_ICONS[entry.icon]} />}
                title={entry.title}
                description={entry.description}
                status={
                  state.triggersOn.has(entry.key) ? (
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
  const { client } = context;
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [triggerOpen, setTriggerOpen] = useState(false);

  const summary = state ? agentForSetup(state.agents, setup) : null;
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
      (list) => live && setTemplate(list.find((t) => t.key === setup.agentTemplateKey) ?? null),
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
  const connected =
    connection.kind === "github"
      ? githubConnectedOf(context.githubStatus?.status) === true
      : catalogItemConnected(catalogItem);
  const notOffered =
    connection.kind === "catalog" && state?.catalog != null && catalogItem === null;
  const connect = () =>
    void navigate({
      href:
        connection.kind === "github"
          ? githubConnectHref(workspaceId)
          : catalogConnectHref(workspaceId, catalogItem!.id),
    });

  // Step 2: the agent.
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
  const triggerOn = state?.triggersOn.has(setup.key) ?? false;
  const ready = Boolean(agentId) && triggerOn;

  return (
    <DetailPage back={{ label: "Get started", onClick: onBack }}>
      <DetailPageHeader
        leading={<LogoTile name={setup.title} icon={SETUP_ICONS[setup.icon]} />}
        title={setup.title}
        meta={[setup.description]}
      />
      {ready ? (
        <Notice
          tone="success"
          className="mt-6"
          action={
            <Button type="button" size="sm" variant="outline" onClick={openAgent}>
              Open {setup.agentName}
            </Button>
          }
        >
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
              description={
                notOffered ? `${connection.name} isn't offered here.` : `So the agent can use it.`
              }
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
              description={template?.description ?? undefined}
              control={
                agentId ? (
                  <RowButton onClick={openAgent}>Open</RowButton>
                ) : (
                  <RowButton disabled={adding} onClick={() => void addAgent()}>
                    Add
                  </RowButton>
                )
              }
            />
            <SettingRow
              data-guided-step="trigger"
              label={`3. ${setup.triggerLabel}`}
              description={agentId ? undefined : `Add ${setup.agentName} first.`}
              control={
                triggerOn ? (
                  <DoneBadge>On</DoneBadge>
                ) : (
                  <RowButton
                    disabled={!agent || !suggestion || agent.viewer.canEdit === false}
                    onClick={() => setTriggerOpen(true)}
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
