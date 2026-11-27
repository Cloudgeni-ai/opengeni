/**
 * Enable: turns on a ready-made agent, a ready-made app or a Get started
 * setup (docs/agents.md#enable). Reads the workspace and runs the actions;
 * ./enable-view.tsx draws the page. Nothing here is new machinery: Connect
 * opens the existing Connect flows, the agent is added from its template, its
 * trigger is the template's suggested trigger (through the agent page's Add
 * trigger dialog when it needs a choice), and the first message is an
 * ordinary chat with the agent.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  Agent,
  AgentSummary,
  AgentTemplate,
  AppTemplate,
  SetupConnectionState,
  SetupReadiness,
} from "@opengeni/sdk";

import { useAppContext } from "@opengeni/react/app/app-context";
import {
  addAgentSuggestedTrigger,
  AgentTriggerDialog,
  agentTriggerRunsAs,
  agentTriggerSaveError,
} from "@opengeni/react/app/components/agents/agent-trigger-dialog";
import {
  chosenAppPackage,
  type ChosenAppPackage,
} from "@opengeni/react/app/components/artifacts/app-package";
import { AppTemplatePreview } from "@opengeni/react/app/components/artifacts/app-template-preview";
import {
  addedReadyMadeApp,
  readyMadeAppTileSeed,
} from "@opengeni/react/app/components/artifacts/available-apps";
import { ArtifactTypeIcon } from "@opengeni/react/app/components/artifacts/artifact-page-chrome";
import { t } from "@opengeni/react/app/lib/console-text";
import { githubConnectedOf } from "@opengeni/react/app/lib/github-connect";
import { isPersonalWorkspace } from "@opengeni/react/app/lib/managed-self-context";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { installReadyMadeApp } from "@opengeni/react/app/lib/ready-made-apps";
import { toast } from "@opengeni/react/app/lib/toast";
import {
  invalidateAppPackageStatus,
  useAppPackageStatus,
} from "@opengeni/react/app/lib/use-app-package-status";
import { invalidateArtifactCatalog } from "@opengeni/react/app/lib/use-artifact-catalog";
import { userErrorText } from "@opengeni/react/ui/api-error";
import type { DetailBackLink } from "@opengeni/react/ui/detail-page";
import { logoTileHue } from "@opengeni/react/ui/logo-tile";
import { CheckboxField } from "@opengeni/react/ui/field";

import { agentForSetup, catalogConnectHref, setupTriggerTask } from "../get-started/guided-setups";
import {
  NOTHING_TO_CONNECT,
  enableHref,
  enableStage,
  turnOnBlocker,
  withRequiredProviders,
  type EnableStep,
  type EnableSubject,
} from "./enable-subject";
import { EnableView, type AskedVia, type EnableFact } from "./enable-view";

type TriggerState =
  | { kind: "on" }
  | { kind: "paused"; taskId: string; runsAs: string }
  | { kind: "off" }
  | { kind: "unknown" };

export interface EnablePageProps {
  workspaceId: string;
  subject: EnableSubject;
  step?: EnableStep | undefined;
  /** Overrides for a Get started setup: its own title, line and icon. */
  title?: string | undefined;
  description?: string | undefined;
  icon?: ReactNode | undefined;
  back?: DetailBackLink | undefined;
  /** This page's address on its Connect step: where Connect returns. */
  returnPath?: string | undefined;
}

export function EnablePage(props: EnablePageProps) {
  return props.subject.kind === "agent" ? (
    <AgentEnable {...props} subject={props.subject} />
  ) : (
    <AppEnable {...props} subject={props.subject} />
  );
}

/**
 * Ask an admin: the workspace's admins are asked in their inbox, with a link
 * back to this step. Where that isn't possible yet (or it fails), the link is
 * copied for the person to send instead.
 */
function useAskAdmin(workspaceId: string, returnPath: string) {
  const { client } = useAppContext();
  const [asked, setAsked] = useState<ReadonlyMap<string, AskedVia>>(() => new Map());
  const ask = useCallback(
    async (connection: SetupConnectionState) => {
      const done = (via: AskedVia) =>
        setAsked((current) => new Map(current).set(connection.provider, via));
      // An older client without the request copies the link straight away.
      const status =
        typeof client.requestSetupConnection === "function"
          ? await client
              .requestSetupConnection(workspaceId, {
                provider: connection.provider,
                name: connection.name,
                returnPath,
              })
              .then((response) => response.status)
              .catch(() => "unavailable" as const)
          : "unavailable";
      if (status === "requested") {
        done("inbox");
        toast.success("Request sent", {
          description: `Your admins were asked to connect ${connection.name}.`,
        });
        return;
      }
      if (status === "already_asked") {
        done("already");
        toast.info("Already asked", {
          description: `Your admins already have your request to connect ${connection.name}.`,
        });
        return;
      }
      const link = `${window.location.origin}${returnPath}`;
      await (
        navigator.clipboard?.writeText(link) ?? Promise.reject(new Error("no clipboard"))
      ).then(
        () => {
          done("link");
          toast.success("Link copied", {
            description: `Send it to an admin to connect ${connection.name}.`,
          });
        },
        () => {
          done("link");
          toast.info(`Send an admin this link to connect ${connection.name}`, {
            description: link,
          });
        },
      );
    },
    [client, returnPath, workspaceId],
  );
  return { asked, ask };
}

/** Ask an admin, only where there is one to ask: never in a Personal workspace. */
function useCanAskAdmin(workspaceId: string): boolean {
  const { workspaces, managedSelfContext } = useAppContext();
  const workspace = (workspaces ?? []).find((row) => row.id === workspaceId) ?? null;
  return !isPersonalWorkspace(workspace, managedSelfContext);
}

function useConnect(workspaceId: string, returnPath: string, label: string, reload: () => void) {
  const { client, connectPersonalGitHub } = useAppContext();
  const navigate = useNavigate();
  return useCallback(
    async (connection: SetupConnectionState) => {
      if (connection.provider === "github.com") {
        // The server says how this viewer connects GitHub: their own GitHub
        // (back to this page and step), or the workspace's GitHub App.
        if (connection.connectVia === "github_personal") {
          await connectPersonalGitHub(workspaceId);
          return;
        }
        try {
          const github = await client.getGitHubApp(workspaceId, { returnPath });
          if (github.status === "bound") {
            reload();
            return;
          }
          if (!github.linkUrl) {
            throw new Error(
              github.configured
                ? "Your account can't connect GitHub here."
                : "GitHub isn't set up on this server.",
            );
          }
          window.location.assign(github.linkUrl);
        } catch (error) {
          toast.error("Couldn't start connecting GitHub", { description: userErrorText(error) });
        }
        return;
      }
      void navigate({
        href: catalogConnectHref(workspaceId, connection.catalogItemId, {
          path: returnPath,
          label,
        }),
      });
    },
    [client, connectPersonalGitHub, label, navigate, reload, returnPath, workspaceId],
  );
}

type AgentData = {
  template: AgentTemplate | null;
  /** The name of the one agent it works well with, when offered here. */
  worksWellWithName: string | null;
  readiness: SetupReadiness | null;
  readinessFailed: boolean;
  agents: AgentSummary[] | null;
  agent: Agent | null;
  trigger: TriggerState;
};

function AgentEnable({
  workspaceId,
  subject,
  step,
  title,
  description,
  icon,
  back,
  returnPath,
}: EnablePageProps & { subject: Extract<EnableSubject, { kind: "agent" }> }) {
  const context = useAppContext();
  const { client, accessContext } = context;
  const subjectId = accessContext.subjectId;
  const navigate = useNavigate();
  const [data, setData] = useState<AgentData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const [busy, setBusy] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [justOn, setJustOn] = useState(false);
  const [firstSessionId, setFirstSessionId] = useState<string | null>(null);

  const { templateKey, triggerName: setupTriggerName } = subject;
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // Readiness for the trigger it turns on (GitHub events need the
        // GitHub App), read alongside the lists: without a setup's own
        // trigger the server takes the same default as triggerNameOf.
        const [templates, agents, readiness] = await Promise.all([
          client.listAgentTemplates(workspaceId),
          client.listAgents(workspaceId).catch(() => null),
          client
            .getAgentTemplateReadiness(
              workspaceId,
              templateKey,
              setupTriggerName ? { trigger: setupTriggerName } : undefined,
            )
            .catch(() => null),
        ]);
        const template = templates.find((entry) => entry.key === templateKey) ?? null;
        const summary = agents ? agentForSetup(agents, { agentTemplateKey: templateKey }) : null;
        const triggerName = triggerNameOf(setupTriggerName, template);
        const [agent, tasks] = summary
          ? await Promise.all([
              client.getAgent(workspaceId, summary.id).catch(() => null),
              client
                .listScheduledTasks(workspaceId, { agentId: summary.id, limit: 200 })
                .catch(() => null),
            ])
          : [null, []];
        const task =
          summary && tasks && triggerName
            ? setupTriggerTask(tasks, summary.id, { triggerName })
            : null;
        if (!live) return;
        setFailed(null);
        const partner = template?.setup?.worksWellWith ?? null;
        setData({
          template,
          worksWellWithName: templates.find((entry) => entry.key === partner)?.name ?? null,
          readiness,
          readinessFailed: readiness === null,
          agents,
          agent,
          trigger: !tasks
            ? { kind: "unknown" }
            : !task
              ? { kind: "off" }
              : task.status === "active"
                ? { kind: "on" }
                : {
                    kind: "paused",
                    taskId: task.id,
                    runsAs: agentTriggerRunsAs(task, subjectId),
                  },
        });
      } catch (error) {
        if (live) setFailed(userErrorText(error, "Couldn't read this agent."));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, revision, setupTriggerName, subjectId, templateKey, workspaceId]);

  const template = data?.template ?? null;
  const name = template?.name ?? subject.templateKey;
  const pagePath =
    returnPath ??
    enableHref(workspaceId, { kind: "agent", templateKey: subject.templateKey }, "connect");
  const { asked, ask } = useAskAdmin(workspaceId, pagePath);
  const canAskAdmin = useCanAskAdmin(workspaceId);
  const connect = useConnect(workspaceId, pagePath, title ?? name, reload);
  const readiness = data?.readiness
    ? withRequiredProviders(data.readiness, subject.requireProviders)
    : null;
  const triggerName = triggerNameOf(setupTriggerName, template);
  const suggestion =
    template?.suggestedTriggers.find((entry) => entry.name === triggerName) ?? null;
  const agent = data?.agent ?? null;
  const on = justOn || data?.trigger.kind === "on";
  const canAdd = hasWorkspacePermission(accessContext, workspaceId, "sessions:create");
  const triggersUnknown = data?.trigger.kind === "unknown";
  const blocker =
    data && !template
      ? "This ready-made agent isn't offered here."
      : // Without its triggers, Turn on could add a second one.
        triggersUnknown
        ? "Couldn't check its triggers."
        : turnOnBlocker({
            readiness,
            canAdd,
            canEdit: agent?.viewer.canEdit !== false,
            added: agent !== null,
            triggerFound: suggestion !== null,
            subjectName: name,
          });

  const openAgent = (id: string) =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId",
      params: { workspaceId, agentId: id },
    });
  const openSession = (sessionId: string) =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId, sessionId },
    });
  const ensureAgent = async (): Promise<Agent> => {
    if (agent) return agent;
    const created = await client.createAgentFromTemplate(workspaceId, subject.templateKey, {
      editAccess: "everyone",
    });
    setData((current) => (current ? { ...current, agent: created } : current));
    return created;
  };
  // After a new trigger is on: it says hello on its own, in an ordinary chat.
  // Turning a paused one back on doesn't repeat the hello.
  const afterOn = async (target: Agent, greet = true) => {
    setJustOn(true);
    const firstMessage = template?.setup?.firstMessage;
    if (!greet || !firstMessage) return;
    try {
      const session = await client.createSession(workspaceId, {
        agentId: target.id,
        initialMessage: firstMessage,
      });
      setFirstSessionId(session.id);
    } catch {
      // It is on either way; the first message is a courtesy.
    }
  };
  const turnOn = async () => {
    if (busy || blocker || !suggestion) return;
    setBusy(true);
    try {
      const target = await ensureAgent();
      const trigger = data?.trigger;
      if (trigger?.kind === "paused") {
        await client.resumeScheduledTask(workspaceId, trigger.taskId);
        await afterOn(target, false);
        return;
      }
      if (!suggestion.oneClick) {
        setTriggerOpen(true);
        return;
      }
      const outcome = await addAgentSuggestedTrigger(t, {
        client,
        workspaceId,
        agent: target,
        suggestion,
        githubConnected: githubConnectedOf(context.githubStatus?.status),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: new Date(),
      });
      if (outcome.kind === "needs_setup") {
        setTriggerOpen(true);
        return;
      }
      await afterOn(target);
    } catch (error) {
      toast.error(`Couldn't turn on ${name}`, {
        description: agent
          ? agentTriggerSaveError(error, agent.visibility === "private" ? "private" : "workspace")
          : userErrorText(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const finishLater = async () => {
    if (busy) return;
    if (agent) {
      openAgent(agent.id);
      return;
    }
    if (!canAdd) {
      navigate({ href: back?.href ?? `/workspaces/${encodeURIComponent(workspaceId)}/agents` });
      return;
    }
    setBusy(true);
    try {
      const created = await ensureAgent();
      toast.success(`Added ${created.name}`, { description: "It stays off until you turn it on." });
      openAgent(created.id);
    } catch (error) {
      toast.error(`Couldn't add ${name}`, { description: userErrorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const startFirstJob = async (text: string) => {
    const target = agent;
    if (!target) return;
    try {
      const session = await client.createSession(workspaceId, {
        agentId: target.id,
        initialMessage: text,
      });
      openSession(session.id);
    } catch (error) {
      toast.error("Couldn't start the chat", { description: userErrorText(error) });
    }
  };

  const facts: EnableFact[] = [
    {
      label: "Agent",
      description: agent ? `${name}, already added.` : `Adds ${name}. Everyone here can edit it.`,
    },
    ...(suggestion
      ? [
          {
            label: "Trigger",
            description: `${suggestion.name}. ${
              data?.trigger.kind === "paused" ? data.trigger.runsAs : "Runs as you"
            }.`,
          },
        ]
      : []),
    ...(template?.setup?.firstMessage && data?.trigger.kind !== "paused"
      ? [{ label: "First message", description: "It says hello in a new chat right away." }]
      : []),
  ];
  const worksWellWith = template?.setup?.worksWellWith ?? null;
  const worksWellWithName = data?.worksWellWithName ?? null;
  const firstJob = template?.setup?.firstJob ?? null;

  return (
    <>
      <EnableView
        name={title ?? name}
        description={description ?? template?.description ?? ""}
        icon={icon}
        back={back}
        step={step}
        readiness={readiness}
        loading={data === null && failed === null}
        loadError={
          failed ??
          (data?.readinessFailed
            ? "Couldn't check its connections."
            : triggersUnknown
              ? "Couldn't check its triggers."
              : null)
        }
        onRetry={reload}
        repository={template?.setup?.repository ?? null}
        facts={facts}
        wontDoWithoutAsking={template?.setup?.wontDoWithoutAsking ?? []}
        worksWellWith={
          worksWellWith && worksWellWithName
            ? {
                name: worksWellWithName,
                onOpen: () =>
                  void navigate({
                    href: enableHref(workspaceId, { kind: "agent", templateKey: worksWellWith }),
                  }),
              }
            : null
        }
        stage={enableStage({ readiness, on })}
        blocker={failed ? failed : blocker}
        busy={busy}
        asked={asked}
        onConnect={(connection) => void connect(connection)}
        onAskAdmin={canAskAdmin ? ask : undefined}
        onTurnOn={() => void turnOn()}
        onFinishLater={() => void finishLater()}
        done={{
          title: `${name} is on.`,
          open: firstSessionId
            ? { label: "Open chat", onClick: () => openSession(firstSessionId) }
            : { label: "Open agent", onClick: () => agent && openAgent(agent.id) },
          firstJob:
            firstJob && agent
              ? { text: firstJob, onStart: () => void startFirstJob(firstJob) }
              : null,
        }}
      />
      {agent && suggestion ? (
        <AgentTriggerDialog
          agent={agent}
          workspaceId={workspaceId}
          suggestion={suggestion}
          open={triggerOpen}
          onOpenChange={setTriggerOpen}
          onCreated={() => {
            setTriggerOpen(false);
            void afterOn(agent);
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
    </>
  );
}

/** The trigger a subject turns on: the setup's own, else the template's first one-click one. */
function triggerNameOf(
  setupTriggerName: string | undefined,
  template: AgentTemplate | null,
): string | null {
  if (setupTriggerName) return setupTriggerName;
  const triggers = template?.suggestedTriggers ?? [];
  return (triggers.find((entry) => entry.oneClick) ?? triggers[0])?.name ?? null;
}

function AppEnable({
  workspaceId,
  subject,
  step,
  title,
  description,
  icon,
  back,
  returnPath,
}: EnablePageProps & { subject: Extract<EnableSubject, { kind: "app" }> }) {
  const { client, accessContext } = useAppContext();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<AppTemplate | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [appId, setAppId] = useState<string | null>(null);
  const [demoData, setDemoData] = useState(true);
  useEffect(() => {
    let live = true;
    client.listAppTemplates(workspaceId).then(
      (list) => {
        if (!live) return;
        setFailed(null);
        setTemplate(list.find((entry) => entry.key === subject.templateKey) ?? null);
      },
      (error: unknown) => live && setFailed(userErrorText(error, "Couldn't read this app.")),
    );
    return () => {
      live = false;
    };
  }, [client, revision, subject.templateKey, workspaceId]);
  // The package as the install dialog reads it: its page for the preview,
  // whether it has demo data, its Skills and automations.
  const chosen = useMemo<ChosenAppPackage | null>(() => {
    try {
      return template ? chosenAppPackage(template.package) : null;
    } catch {
      return null;
    }
  }, [template]);
  // Already added here (opened again from Get started or the sidebar): it
  // opens that app instead of adding another.
  const packages = useAppPackageStatus(client, workspaceId);
  const added = template ? addedReadyMadeApp(template, packages.apps.values()) : null;
  const shownAppId = appId ?? added?.appId ?? null;
  const pagePath =
    returnPath ??
    enableHref(workspaceId, { kind: "app", templateKey: subject.templateKey }, "connect");
  const { asked, ask } = useAskAdmin(workspaceId, pagePath);
  const canAskAdmin = useCanAskAdmin(workspaceId);
  const name = template?.name ?? subject.templateKey;
  const connect = useConnect(workspaceId, pagePath, title ?? name, () =>
    setRevision((value) => value + 1),
  );
  const canAdd = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  // A ready-made app asks for any tool it uses inside the app itself.
  const readiness = NOTHING_TO_CONNECT;
  const blocker =
    template === null
      ? "This ready-made app isn't offered here."
      : turnOnBlocker({
          readiness,
          canAdd,
          canEdit: true,
          added: shownAppId !== null,
          triggerFound: true,
          subjectName: name,
        });
  const openApp = (id: string) =>
    void navigate({
      to: "/workspaces/$workspaceId/apps/$appId/$",
      params: { workspaceId, appId: id, _splat: "" },
    });
  const turnOn = async () => {
    if (!template || busy || blocker || shownAppId) return;
    setBusy(true);
    try {
      const installed = await installReadyMadeApp(
        client,
        workspaceId,
        template,
        chosen?.hasDemoData ? demoData : undefined,
      );
      invalidateArtifactCatalog(client, workspaceId);
      invalidateAppPackageStatus();
      if (installed.notInstalled.length > 0) {
        toast.warning(`${template.name} was added without some parts`, {
          description: installed.notInstalled.map((problem) => problem.reason).join(" "),
        });
      }
      setAppId(installed.app.id);
    } catch (error) {
      toast.error(`Couldn't add ${name}`, { description: userErrorText(error) });
    } finally {
      setBusy(false);
    }
  };
  // What installing adds.
  const facts = useMemo<EnableFact[]>(() => {
    const list: EnableFact[] = [{ label: "App", description: `Adds ${name} to Apps.` }];
    for (const skill of chosen?.skills ?? []) {
      list.push({ label: `Skill: ${skill.name}`, description: skill.description });
    }
    for (const automation of chosen?.automations ?? []) {
      list.push({ label: `Automation: ${automation.name}`, description: "Added switched off." });
    }
    return list;
  }, [chosen, name]);
  const firstJob = template?.setup?.firstJob ?? null;
  return (
    <EnableView
      name={title ?? name}
      description={description ?? template?.description ?? ""}
      // The Apps list's tile for it: the app icon in its own hue.
      icon={icon ?? <ArtifactTypeIcon kind="site" />}
      hue={
        icon
          ? undefined
          : logoTileHue(template ? readyMadeAppTileSeed(template) : subject.templateKey)
      }
      back={back}
      step={step}
      readiness={readiness}
      loading={template === undefined && failed === null}
      loadError={failed}
      onRetry={() => setRevision((value) => value + 1)}
      facts={facts}
      wontDoWithoutAsking={template?.setup?.wontDoWithoutAsking ?? []}
      preview={
        template && chosen ? <AppTemplatePreview template={template} html={chosen.html} /> : null
      }
      options={
        chosen?.hasDemoData ? (
          // Taken when Turn on adds it, so a checkbox rather than a switch.
          <CheckboxField
            label="Include demo data"
            checked={demoData}
            onCheckedChange={setDemoData}
          />
        ) : null
      }
      stage={shownAppId ? "on" : "turn-on"}
      blocker={failed ?? blocker}
      busy={busy}
      asked={asked}
      onConnect={(connection) => void connect(connection)}
      onAskAdmin={canAskAdmin ? ask : undefined}
      onTurnOn={() => void turnOn()}
      done={{
        title: `${name} is ready.`,
        open: { label: "Open app", onClick: () => shownAppId && openApp(shownAppId) },
        firstJob:
          firstJob && shownAppId ? { text: firstJob, onStart: () => openApp(shownAppId) } : null,
      }}
    />
  );
}
