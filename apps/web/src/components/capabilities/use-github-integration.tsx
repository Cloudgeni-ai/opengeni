import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NativeConnectSetup,
  type NativeConnectRequest,
} from "@opengeni/react/app/components/capabilities/native-connect-setup";
import { toast } from "sonner";
import { userErrorText } from "@opengeni/react/ui/api-error";
import type {
  GitHubActionPoliciesResponse,
  GitHubActionPolicyActorState,
  GitHubActionPolicyDecision,
  GitHubActionPolicyGroup,
} from "@opengeni/sdk";

import type {
  IntegrationChip,
  IntegrationFooter,
  IntegrationOption,
  IntegrationSection,
  IntegrationViewModel,
} from "@opengeni/react/app/components/capabilities/integration-view-model";
import {
  markPersonalGitHubRepositoryChooser,
  personalGitHubSetupLink,
  takePersonalGitHubRepositoryChooser,
} from "@/lib/personal-github-oauth";
import type { IntegrationAdapter } from "@/components/capabilities/use-api-integration-accounts";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { PersonalGitHubDialog } from "@/components/capabilities/personal-github-dialog";
import { useAppContext } from "@opengeni/react/app/app-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import type { GitHubAppInfo } from "@opengeni/react/app/types";

export const GITHUB_APP_DESCRIPTION =
  "Work on repositories, issues, and pull requests through the Opengeni app.";
/** With personal sign-in enabled, GitHub connects two ways. */
export const GITHUB_DESCRIPTION = "Work on repositories, issues, and pull requests.";
export const PERSONAL_GITHUB_SECTION = {
  title: "Your GitHub",
  description: "Work appears under your name. Only in chats you start, on repos you choose.",
} as const;
export const GITHUB_APP_SECTION = {
  title: "Opengeni app",
  description: "Work appears as the Opengeni bot, shared with the workspace.",
} as const;
// Use the same bundled mark as the conversation card. The workspace App row
// does not have a registry logo path, and a remote favicon is not reliable.
export const GITHUB_LOGO_URL = "/capability-logos/github.svg";

const GITHUB_ACTION_POLICY_GROUPS: Array<{
  id: GitHubActionPolicyGroup;
  label: string;
  description: string;
}> = [
  {
    id: "routine",
    label: "Create and update work",
    description: "Branches, issues, pull requests, comments, and reviewer requests.",
  },
  {
    id: "review",
    label: "Submit reviews",
    description: "Comment, approve, or request changes on a pull request.",
  },
  {
    id: "merge",
    label: "Merge pull requests",
    description: "Merge, squash, or rebase a pull request. This can change protected branches.",
  },
];

/**
 * Maps the workspace GitHub App binding onto the shared integration view-model.
 * The GitHub status, repositories, and mutations already live in the app
 * context (the repository picker uses the same data), so this adapter reads
 * from there instead of fetching again.
 */
export function useGitHubIntegration({ workspaceId }: { workspaceId: string }): IntegrationAdapter {
  const context = useAppContext();
  const connectTransport = useMemo(() => context.client.connectTransport(), [context.client]);
  const [connectRequest, setConnectRequest] = useState<NativeConnectRequest | null>(null);
  const completeConnect = useCallback(() => {
    setConnectRequest(null);
    // The connect flow just changed the binding: read GitHub's list fresh.
    void context.refreshGitHub(workspaceId, undefined, { sync: true, userInitiated: true });
  }, [context, workspaceId]);
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "github:manage");
  const canManagePersonal = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "connections:write",
  );
  const status = context.githubStatus;
  const repositories = context.githubRepos;
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [personalDisconnectOpen, setPersonalDisconnectOpen] = useState(false);
  const [actionPolicies, setActionPolicies] = useState<GitHubActionPoliciesResponse | null>(null);
  const [actionPolicyFailed, setActionPolicyFailed] = useState(false);
  const [actionPolicyBusy, setActionPolicyBusy] = useState<string | null>(null);
  const actionPolicyRequest = useRef(0);
  const actionPolicyMutation = useRef<number | null>(null);
  const installations = status?.installations ?? [];
  const busy = context.githubAppBusy || disconnecting;

  // A failed status fetch with no prior snapshot is unknown, not unbound: show a
  // visible failure with a retry instead of pinning the tile at Loading. The
  // same goes for a repository list that never loaded.
  const statusFailed = status === null && !context.repoBusy && context.githubStatusFailed;
  const repositoriesFailed =
    status !== null &&
    !context.repoBusy &&
    context.githubStatusFailed &&
    !context.githubCatalogReady;
  const loadFailed = statusFailed || repositoriesFailed;
  const catalogLoading = context.repoBusy || !context.githubCatalogReady;
  const personalConnection = context.personalGitHubStatus?.connection ?? null;
  const personalConnected = personalConnection?.status === "active";
  const personalNeedsAttention = Boolean(
    personalConnection && personalConnection.status !== "active",
  );
  const bound = status?.status === "bound" && installations.length > 0;
  const broken = bound && installations.some((installation) => installation.lifecycle !== "active");
  const chip =
    personalNeedsAttention || broken || loadFailed
      ? ({ label: "Needs attention", tone: "warn" } as const)
      : personalConnected
        ? ({ label: "Connected", tone: "ok" } as const)
        : githubChip(status, canManage, statusFailed);
  const connectUrl = status?.installUrl ?? status?.linkUrl ?? null;
  const personalCatalogReady = context.personalGitHubCatalogReady;
  const personalStatusLoaded = context.personalGitHubStatus !== null;

  // Back from connecting on GitHub: go straight to choosing repositories.
  useEffect(() => {
    if (
      personalConnected &&
      personalCatalogReady &&
      takePersonalGitHubRepositoryChooser(workspaceId)
    )
      setPersonalOpen(true);
  }, [personalConnected, personalCatalogReady, workspaceId]);

  // `github=personal` (the agent's "connect my GitHub" link) lands on the
  // personal action: the chooser when connected, else the Connect button.
  const setupLinkHandled = useRef(false);
  useEffect(() => {
    if (setupLinkHandled.current || !personalStatusLoaded) return;
    const link = personalGitHubSetupLink(window.location.search);
    if (!link) return;
    setupLinkHandled.current = true;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${link.cleanedSearch}${window.location.hash}`,
    );
    if (personalConnected) {
      setPersonalOpen(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-integration-section-action="github-personal"]',
      );
      target?.scrollIntoView?.({ block: "center" });
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [personalStatusLoaded, personalConnected]);
  const actionPolicyActorKey = [
    ...installations.map((installation) => `app:${installation.installationId}`),
    personalConnection ? `personal:${personalConnection.id}` : "",
  ].join("|");

  const refreshActionPolicies = useCallback(async () => {
    const request = ++actionPolicyRequest.current;
    setActionPolicyFailed(false);
    try {
      const policies = await context.client.getGitHubActionPolicies(workspaceId);
      if (actionPolicyRequest.current !== request) return;
      setActionPolicies(policies);
    } catch {
      if (actionPolicyRequest.current !== request) return;
      setActionPolicies(null);
      setActionPolicyFailed(true);
    }
  }, [context.client, workspaceId]);

  useEffect(() => {
    setActionPolicies(null);
    setActionPolicyBusy(null);
    actionPolicyMutation.current = null;
    void refreshActionPolicies();
    return () => {
      actionPolicyRequest.current += 1;
      actionPolicyMutation.current = null;
    };
  }, [actionPolicyActorKey, refreshActionPolicies]);

  async function updateActionPolicy(
    actor: GitHubActionPolicyActorState,
    group: GitHubActionPolicyGroup,
    decision: GitHubActionPolicyDecision,
  ) {
    // The endpoint returns the whole actor. Permit one save at a time so older
    // snapshots cannot overwrite another group, including same-frame changes.
    if (actionPolicyMutation.current !== null) return;
    const request = ++actionPolicyRequest.current;
    actionPolicyMutation.current = request;
    const key = githubActionPolicyOptionId(actor, group);
    setActionPolicyBusy(key);
    try {
      const updated = await context.client.updateGitHubActionPolicy(workspaceId, {
        actor:
          actor.kind === "workspace_app"
            ? { kind: "workspace_app", installationId: actor.installationId }
            : { kind: "personal", connectionId: actor.connectionId },
        group,
        decision,
      });
      if (actionPolicyRequest.current !== request) return;
      setActionPolicies((current) =>
        current
          ? {
              ...current,
              actors: current.actors.map((candidate) =>
                sameGitHubActionPolicyActor(candidate, updated) ? updated : candidate,
              ),
            }
          : current,
      );
    } catch (error) {
      if (actionPolicyRequest.current !== request) return;
      toast.error("Could not update GitHub action approvals", {
        description: userErrorText(error),
      });
    } finally {
      if (actionPolicyMutation.current === request) {
        actionPolicyMutation.current = null;
        setActionPolicyBusy(null);
      }
    }
  }

  const facts: IntegrationViewModel["connection"] = [];
  for (const installation of installations) {
    facts.push({
      label: installation.accountType === "Organization" ? "Organization" : "GitHub account",
      value: installation.accountLogin ?? `Installation ${installation.installationId}`,
    });
    if (installation.lifecycle !== "active") {
      facts.push({ label: "GitHub status", value: installation.lifecycle });
    }
  }
  if (
    status &&
    installations.length === 0 &&
    status.setupMode === "operator" &&
    !status.configured
  ) {
    facts.push({
      label: "GitHub App",
      value: "Not set up on this server yet. Connecting creates it first.",
    });
  }

  function reconnect() {
    if (status?.configured && canManage) {
      setConnectRequest({
        scope: { workspaceId, transport: connectTransport },
        providerId: "github-app",
        displayName: "GitHub App",
        ownership: "workspace",
        returnUrl: window.location.href,
        idempotencyKey: crypto.randomUUID(),
      });
      return;
    }
    if (status?.setupMode === "operator" && !status.configured) {
      void context.startGitHubAppManifestFlow(workspaceId);
    }
  }

  async function disconnectAll(): Promise<boolean> {
    setDisconnecting(true);
    try {
      // ConfirmDialog contract: return false when anything failed so the dialog
      // stays open instead of closing as a success.
      let allSucceeded = true;
      for (const installation of installations) {
        const succeeded = await context.disconnectGitHubInstallation(
          workspaceId,
          installation.installationId,
        );
        if (!succeeded) allSucceeded = false;
      }
      return allSucceeded;
    } finally {
      setDisconnecting(false);
    }
  }

  const appFooter: IntegrationFooter = !canManage
    ? { kind: "locked" }
    : status === null
      ? { kind: "setup", onSetup: () => {}, disabled: true }
      : bound
        ? {
            kind: broken ? "repair" : "connected",
            onReconnect: reconnect,
            onDisconnect: () => setDisconnectOpen(true),
            reconnectDisabled: connectUrl === null,
            busy,
          }
        : {
            kind: "setup",
            onSetup: reconnect,
            disabled:
              connectUrl === null && !(status.setupMode === "operator" && !status.configured),
            busy,
          };
  // With personal sign-in, GitHub connects two ways: each named section owns
  // its one action, and the header keeps only Disconnect for the App.
  const sectioned = context.personalGitHubStatus?.enabled === true;
  const footer: IntegrationFooter = sectioned
    ? bound && canManage
      ? {
          kind: "actions",
          secondary: {
            label: "Disconnect Opengeni app",
            onClick: () => setDisconnectOpen(true),
            destructive: true,
          },
          busy,
        }
      : { kind: "actions" }
    : appFooter;

  const configurableInstallations = installations.filter(
    (installation) => installation.configureUrl,
  );
  const configureUrl = configurableInstallations[0]?.configureUrl ?? null;

  // With several installations, one shared "Change repositories" link would
  // silently open only the first installation's GitHub settings; emit one
  // action per installation instead.
  const installationOptions: IntegrationOption[] =
    bound && canManage && configurableInstallations.length > 1
      ? configurableInstallations.map((installation) => ({
          kind: "link" as const,
          id: `github-repositories-${installation.installationId}`,
          label: installation.accountLogin ?? `GitHub installation ${installation.installationId}`,
          description: "Choose which repositories this installation shares.",
          action: {
            label: "Change repositories",
            onClick: () => window.open(installation.configureUrl!, "_blank", "noopener,noreferrer"),
          },
        }))
      : [];
  const personalLogin = personalConnection
    ? String(personalConnection.metadata.githubLogin ?? "connected")
    : null;
  const personalRepositoryCount = context.personalGitHubSelection?.repositories.length ?? 0;
  const startPersonalConnect = (reconnecting: boolean) => {
    // Return from GitHub straight into the repository chooser.
    markPersonalGitHubRepositoryChooser(workspaceId);
    if (reconnecting) void context.reconnectPersonalGitHub(workspaceId);
    else void context.connectPersonalGitHub(workspaceId);
  };
  const personalSection: IntegrationSection = {
    id: "github-personal",
    ...PERSONAL_GITHUB_SECTION,
    ...(personalConnected
      ? {
          status: `Connected as @${personalLogin} · ${personalRepositoryCount === 1 ? "1 repo" : `${personalRepositoryCount} repos`}`,
        }
      : personalNeedsAttention
        ? { status: `@${personalLogin} needs to reconnect.` }
        : {}),
    ...(!canManagePersonal
      ? { note: "Your access doesn't allow connecting accounts in this workspace." }
      : {
          action: personalConnected
            ? {
                label: "Choose repos",
                onClick: () => setPersonalOpen(true),
                primary: personalRepositoryCount === 0,
                disabled: context.personalGitHubBusy,
              }
            : {
                label: personalNeedsAttention ? "Reconnect" : "Connect",
                onClick: () => startPersonalConnect(personalNeedsAttention),
                primary: true,
                busy: context.personalGitHubBusy,
                connectProviderId: "github-personal",
              },
        }),
  };
  const installedOn = installations.map(
    (installation) => installation.accountLogin ?? `installation ${installation.installationId}`,
  );
  const operatorUnconfigured =
    status !== null && status.setupMode === "operator" && !status.configured;
  const appSection: IntegrationSection = {
    id: "github-app",
    ...GITHUB_APP_SECTION,
    ...(status === null
      ? { status: "Loading…" }
      : bound
        ? {
            status: broken
              ? `Installed on ${installedOn.join(", ")}. Needs attention.`
              : `Installed on ${installedOn.join(", ")}`,
          }
        : {}),
    ...(!canManage
      ? {
          note: bound
            ? "A workspace admin manages the Opengeni app."
            : "Ask a workspace admin to install the Opengeni app.",
        }
      : status === null
        ? {}
        : {
            ...(operatorUnconfigured
              ? { note: "Not set up on this server yet. Installing creates it first." }
              : {}),
            action: {
              label: broken ? "Repair" : bound ? "Install on another account" : "Install app",
              onClick: reconnect,
              primary: broken,
              busy,
              disabled: connectUrl === null && !operatorUnconfigured,
              ...(operatorUnconfigured ? {} : { connectProviderId: "github-app" }),
            },
          }),
  };
  const actionPolicyOptions: IntegrationOption[] = actionPolicyFailed
    ? [
        {
          kind: "link",
          id: "github-action-policy-retry",
          label: "Action approvals",
          description: "Approval settings could not be loaded.",
          action: { label: "Retry", onClick: () => void refreshActionPolicies() },
        },
      ]
    : actionPolicies?.enabled
      ? actionPolicies.actors.flatMap((actor) =>
          GITHUB_ACTION_POLICY_GROUPS.map((group) => {
            const value = actor.groups[group.id];
            const optionId = githubActionPolicyOptionId(actor, group.id);
            return {
              kind: "choice" as const,
              id: optionId,
              label: `${actor.label} · ${group.label}`,
              description: `${group.description} Applies to new attempts; existing approvals keep their original policy. Repository access and session approval settings still apply.`,
              value,
              choices: [
                ...(value === "mixed" ? [{ value: "mixed", label: "Mixed", disabled: true }] : []),
                { value: "ask", label: "Ask every time" },
                { value: "allow", label: "Allow" },
                { value: "block", label: "Block" },
              ],
              disabled:
                actionPolicyBusy !== null ||
                (actor.kind === "workspace_app" ? !canManage : !canManagePersonal),
              busy: actionPolicyBusy === optionId,
              onChange: (next: string) => {
                if (next === "allow" || next === "ask" || next === "block") {
                  void updateActionPolicy(actor, group.id, next);
                }
              },
            };
          }),
        )
      : [];
  const options = [...installationOptions, ...actionPolicyOptions];

  const model: IntegrationViewModel = {
    id: "github",
    name: "GitHub",
    description: sectioned ? GITHUB_DESCRIPTION : GITHUB_APP_DESCRIPTION,
    mark: { logoSrc: GITHUB_LOGO_URL, monogram: "G" },
    chip,
    connection: sectioned ? [] : facts,
    ...(sectioned ? { sections: [personalSection, appSection] } : {}),
    ...(bound && !repositoriesFailed
      ? {
          access: {
            title: sectioned ? "Opengeni app repositories" : "Repositories",
            items: repositories.map((repository) => ({
              name: repository.fullName,
              meta: repository.private ? "private" : "public",
            })),
            emptyMessage: catalogLoading
              ? "Loading repositories…"
              : githubEmptyRepositoriesMessage(installations),
            ...(canManage && configureUrl && configurableInstallations.length === 1
              ? {
                  editLabel: "Change repositories",
                  onEdit: () => window.open(configureUrl, "_blank", "noopener,noreferrer"),
                }
              : {}),
          },
        }
      : {}),
    options,
    footer,
    ...(loadFailed
      ? {
          notice: {
            tone: "failed" as const,
            title: statusFailed
              ? "GitHub status could not be loaded."
              : "Repositories could not be loaded.",
            ...(statusFailed
              ? { description: "The GitHub App binding is unknown until the status loads." }
              : {}),
            action: {
              label: "Retry",
              onClick: () =>
                void context.refreshGitHub(workspaceId, undefined, { userInitiated: true }),
            },
          },
        }
      : status && !status.configured && status.setupMode === "platform"
        ? {
            notice: {
              tone: "muted" as const,
              title: "GitHub is temporarily unavailable for this Opengeni deployment.",
            },
          }
        : {}),
  };

  const dialogs = (
    <>
      {connectRequest && (
        <NativeConnectSetup
          transport={connectTransport}
          workspaceId={workspaceId}
          request={connectRequest}
          onClose={() => setConnectRequest(null)}
          onComplete={completeConnect}
        />
      )}
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={sectioned ? "Disconnect the Opengeni app?" : "Disconnect GitHub?"}
        description={
          installations.length > 1
            ? `This unlinks all ${installations.length} GitHub installations from this workspace. Sessions lose access to their repositories, and the app stays installed on GitHub until you remove it there.`
            : "This unlinks the GitHub installation from this workspace. Sessions lose access to its repositories, and the app stays installed on GitHub until you remove it there."
        }
        confirmLabel={sectioned ? "Disconnect" : "Disconnect GitHub"}
        cancelAutoFocus
        onConfirm={disconnectAll}
      />
      {personalConnection ? (
        <PersonalGitHubDialog
          open={personalOpen}
          onOpenChange={setPersonalOpen}
          login={String(personalConnection.metadata.githubLogin ?? "connected")}
          repositories={context.personalGitHubRepositories}
          loading={!personalCatalogReady}
          busy={context.personalGitHubBusy}
          onSave={(selections) => context.savePersonalGitHubRepositories(workspaceId, selections)}
          onReconnect={() => void context.reconnectPersonalGitHub(workspaceId)}
          onDisconnect={() => setPersonalDisconnectOpen(true)}
        />
      ) : null}
      <ConfirmDialog
        open={personalDisconnectOpen}
        onOpenChange={setPersonalDisconnectOpen}
        title="Disconnect your GitHub?"
        description="Opengeni will stop acting as you. The Opengeni app is unaffected."
        confirmLabel="Disconnect"
        cancelAutoFocus
        onConfirm={async () => {
          const disconnected = await context.disconnectPersonalGitHub(workspaceId);
          if (disconnected) setPersonalOpen(false);
          return disconnected;
        }}
      />
    </>
  );

  return { model, dialogs };
}

export function githubChip(
  status: GitHubAppInfo | null,
  canManage: boolean,
  statusFailed = false,
): IntegrationChip {
  if (status === null) {
    return statusFailed
      ? { label: "Needs attention", tone: "warn" }
      : { label: "Loading", tone: "plain" };
  }
  const bound = status.status === "bound" && status.installations.length > 0;
  if (bound) {
    if (status.installations.some((installation) => installation.lifecycle !== "active")) {
      return { label: "Needs attention", tone: "warn" };
    }
    return canManage
      ? { label: "Connected", tone: "ok" }
      : { label: "Set up by an admin", tone: "plain" };
  }
  return { label: "Not connected", tone: "idle" };
}

function githubEmptyRepositoriesMessage(installations: GitHubAppInfo["installations"]): string {
  return installations.some((installation) => installation.repositoryScope === "all")
    ? "This installation shares every repository it can see."
    : "No repositories are shared with Opengeni yet. Change repositories on GitHub to allow some.";
}

function githubActionPolicyOptionId(
  actor: GitHubActionPolicyActorState,
  group: GitHubActionPolicyGroup,
): string {
  const actorId =
    actor.kind === "workspace_app"
      ? `app-${actor.installationId}`
      : `personal-${actor.connectionId}`;
  return `github-action-policy-${actorId}-${group}`;
}

function sameGitHubActionPolicyActor(
  left: GitHubActionPolicyActorState,
  right: GitHubActionPolicyActorState,
): boolean {
  return left.kind === "workspace_app" && right.kind === "workspace_app"
    ? left.installationId === right.installationId
    : left.kind === "personal" && right.kind === "personal"
      ? left.connectionId === right.connectionId
      : false;
}
