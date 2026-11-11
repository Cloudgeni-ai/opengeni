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
  GitHubInstallationBinding,
} from "@opengeni/sdk";

import type {
  IntegrationChip,
  IntegrationFooter,
  IntegrationPolicyCell,
  IntegrationPolicyTable,
  IntegrationSection,
  IntegrationSectionRow,
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
import { openGitHubInstallationSettings } from "@opengeni/react/app/lib/github-app-connect";
import { openBlankTab } from "@opengeni/react/app/lib/navigation";
import { markGitHubAccessChanged } from "@opengeni/react/app/lib/github-access-return";
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
}> = [
  { id: "routine", label: "Create and update work" },
  { id: "review", label: "Submit reviews" },
  { id: "merge", label: "Merge pull requests" },
];

const GITHUB_ACTION_POLICY_CHOICES = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask first" },
  { value: "block", label: "Block" },
];

/** The fix an installation that is not active needs, in the order people meet it. */
export type GitHubInstallationFix = "reinstall" | "configure" | "authorize" | "recheck" | "remove";

/**
 * What is wrong with one installation and the one action that fixes it.
 * `problem` is what is wrong; `remedy` says what the action does, for people
 * who can take it. Null while active. Servers before the `issue` field fall
 * back to the lifecycle, with "unverified" read as a link that needs
 * authorizing again.
 */
export function githubInstallationAttention(installation: GitHubInstallationBinding): {
  label: string;
  /** The page's one-line summary, naming the installation. */
  summary: string;
  problem: string;
  remedy: string | null;
  fix: GitHubInstallationFix;
  actionLabel: string;
} | null {
  if (installation.lifecycle === "active") return null;
  const account = installation.accountLogin ?? "this account";
  const organization = installation.accountType === "Organization";
  const issue =
    installation.issue ??
    (installation.lifecycle === "deleted"
      ? "uninstalled"
      : installation.lifecycle === "suspended"
        ? "suspended"
        : "owner_unconfirmed");
  switch (issue) {
    case "uninstalled":
      return {
        label: "Uninstalled on GitHub",
        summary: `The Opengeni app was uninstalled from ${account} on GitHub.`,
        problem: `The Opengeni app was removed from ${account} on GitHub.`,
        remedy: "Reinstall it, or remove it here.",
        fix: "reinstall",
        actionLabel: "Reinstall",
      };
    case "suspended":
      return {
        label: "Suspended on GitHub",
        summary: `The Opengeni app is suspended on ${account}.`,
        problem: `The Opengeni app is suspended on ${account}.`,
        remedy: "Unsuspend it in GitHub's settings.",
        fix: "configure",
        actionLabel: "Unsuspend on GitHub",
      };
    case "no_repositories":
      return {
        label: "No repositories",
        summary: `${account} shares no repositories with Opengeni.`,
        problem: `${account} shares no repositories with Opengeni.`,
        remedy: "Choose some on GitHub.",
        fix: "configure",
        actionLabel: "Choose repositories",
      };
    case "github_unreachable":
      return {
        label: "Not checked",
        summary: `Opengeni couldn't check ${account} on GitHub.`,
        problem: `Opengeni couldn't check ${account} on GitHub.`,
        remedy: null,
        fix: "recheck",
        actionLabel: "Check again",
      };
    case "account_changed":
      return {
        label: "Account changed",
        summary: `The installation on ${account} moved to another GitHub account.`,
        problem: "This installation now belongs to another GitHub account.",
        remedy: "Remove it, then install the app again.",
        fix: "remove",
        actionLabel: "Remove",
      };
    case "owner_unconfirmed":
      return {
        label: "Needs authorization",
        summary: `${account} needs authorization.`,
        problem: organization
          ? `An owner of ${account} hasn't confirmed this link.`
          : `${account} hasn't confirmed this link.`,
        remedy: organization
          ? "An owner signs in to GitHub to confirm it."
          : `Sign in to GitHub as ${account} to confirm it.`,
        fix: "authorize",
        actionLabel: "Authorize",
      };
  }
}

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
  // The account name is kept from the click, so the title stays right even if
  // the installation drops out of the status while the dialog is open.
  const [unlinkTarget, setUnlinkTarget] = useState<{
    installationId: number;
    account: string;
  } | null>(null);
  const [openingInstallationId, setOpeningInstallationId] = useState<number | null>(null);
  const openingInstallation = useRef<number | null>(null);
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
  // A disconnected (revoked) row offers Connect, not Reconnect.
  const personalNeedsAttention = Boolean(
    personalConnection &&
    personalConnection.status !== "active" &&
    personalConnection.status !== "revoked",
  );
  const bound = status?.status === "bound" && installations.length > 0;
  // Stored installations stay unlinkable even when none is active (suspended,
  // deleted or unverified leave the workspace "unbound" but still linked).
  const linked = status !== null && installations.length > 0;
  // Any linked installation that is not active needs attention, including
  // when none is active and the workspace reads as unbound.
  const broken =
    linked && installations.some((installation) => installation.lifecycle !== "active");
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
    // The chooser saves the allowlist, which needs connections:write.
    if (personalConnected && canManagePersonal) {
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
  }, [personalStatusLoaded, personalConnected, canManagePersonal]);
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

  /**
   * Saves one or more actor/group decisions in order. The endpoint returns the
   * whole actor, so one batch runs at a time and each save applies before the
   * next starts; older snapshots cannot overwrite another group, including
   * same-frame changes. A failure stops the batch and says so.
   */
  async function updateActionPolicies(
    changes: Array<{
      actor: GitHubActionPolicyActorState;
      group: GitHubActionPolicyGroup;
      decision: GitHubActionPolicyDecision;
    }>,
    busyKey: string,
  ) {
    if (actionPolicyMutation.current !== null || changes.length === 0) return;
    const request = ++actionPolicyRequest.current;
    actionPolicyMutation.current = request;
    setActionPolicyBusy(busyKey);
    try {
      for (const { actor, group, decision } of changes) {
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
      }
    } catch (error) {
      if (actionPolicyRequest.current !== request) return;
      toast.error("Could not update GitHub approvals", {
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
  // Installations are rows on the page (with their status), so the aside
  // keeps only what the rows cannot say.
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

  function reconnect(
    repair?: Pick<
      NativeConnectRequest,
      "title" | "description" | "authorizeLabel" | "reconnectAccountId"
    >,
  ) {
    if (status?.configured && canManage) {
      setConnectRequest({
        scope: { workspaceId, transport: connectTransport },
        providerId: "github-app",
        displayName: "GitHub App",
        // A repair names its installation, so Connect starts at that
        // installation's fix instead of the account chooser.
        ...(repair ? { ...repair, logoUrl: GITHUB_LOGO_URL } : {}),
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
            // Each installation row carries its own specific fix, so the
            // header keeps the generic Reconnect in its ⋯ menu.
            kind: "connected",
            onReconnect: () => reconnect(),
            onDisconnect: () => setDisconnectOpen(true),
            reconnectDisabled: connectUrl === null,
            busy,
          }
        : {
            kind: "setup",
            onSetup: () => reconnect(),
            disabled:
              connectUrl === null && !(status.setupMode === "operator" && !status.configured),
            busy,
          };
  // With personal sign-in, GitHub connects two ways: each named section owns
  // its one action, and the header keeps only Disconnect for the App.
  const sectioned = context.personalGitHubStatus?.enabled === true;
  const footer: IntegrationFooter = sectioned
    ? linked && canManage
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

  // Installation settings links carry ten-minute signed state, so the copy in
  // the loaded status may be stale: open the tab inside the click, then mint a
  // fresh link for it. One at a time, so a double-click opens one tab.
  function openInstallationRepositories(installationId: number) {
    if (openingInstallation.current !== null) return;
    const tab = openBlankTab();
    // Back from GitHub, the composer's repository menu refreshes and syncs.
    markGitHubAccessChanged(workspaceId);
    openingInstallation.current = installationId;
    setOpeningInstallationId(installationId);
    openGitHubInstallationSettings(context.client, workspaceId, installationId, (url) => {
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    })
      .catch((error: unknown) => {
        tab?.close();
        toast.error("Couldn't open GitHub", { description: userErrorText(error, "Try again.") });
      })
      .finally(() => {
        openingInstallation.current = null;
        setOpeningInstallationId(null);
      });
  }

  // One compact row per installation, every installation listed so each one
  // stays fixable and removable. A healthy row shows what it shares and opens
  // its own GitHub settings (one shared link would only ever open the
  // first); a row that needs attention says what is wrong and offers the one
  // action that fixes it. Remove sits in the row's ⋯ menu.
  const installationRows: IntegrationSectionRow[] = installations.map((installation) => {
    const account =
      installation.accountLogin ?? `GitHub installation ${installation.installationId}`;
    const attention = githubInstallationAttention(installation);
    const rowDisabled = busy || openingInstallationId !== null;
    const remove = () => setUnlinkTarget({ installationId: installation.installationId, account });
    const configurable = installation.configureUrl !== null;
    // A fix that needs GitHub settings falls back to Remove when this viewer
    // has no settings link.
    const fix =
      attention && attention.fix === "configure" && !configurable
        ? ({ fix: "remove", actionLabel: "Remove" } as const)
        : attention;
    const action: IntegrationSectionRow["action"] = !canManage
      ? undefined
      : fix
        ? {
            label: fix.actionLabel,
            ariaLabel: `${fix.actionLabel}: ${account}`,
            primary: true,
            disabled:
              rowDisabled ||
              ((fix.fix === "reinstall" || fix.fix === "authorize") && connectUrl === null),
            onClick: () => {
              if (fix.fix === "configure")
                openInstallationRepositories(installation.installationId);
              else if (fix.fix === "recheck")
                void context.refreshGitHub(workspaceId, undefined, {
                  sync: true,
                  userInitiated: true,
                });
              else if (fix.fix === "remove") remove();
              // A server that names no issue can't start a repair at one
              // installation; it gets the account chooser.
              else
                reconnect(
                  installation.issue === undefined
                    ? undefined
                    : githubRepairDialog(installation, fix.fix),
                );
            },
          }
        : configurable
          ? {
              label: "Change repositories",
              ariaLabel: `Change repositories for ${account}`,
              disabled: rowDisabled,
              onClick: () => openInstallationRepositories(installation.installationId),
            }
          : undefined;
    return {
      id: `github-installation-${installation.installationId}`,
      title: account,
      meta: [
        installation.accountType === "Organization" ? "Organization" : "Personal account",
        installation.repositoryCount === 1
          ? "1 repository"
          : `${installation.repositoryCount} repositories`,
      ].join(" · "),
      ...(attention
        ? {
            attention: {
              label: attention.label,
              detail:
                canManage && attention.remedy
                  ? `${attention.problem} ${attention.remedy}`
                  : attention.problem,
            },
          }
        : {}),
      ...(action ? { action } : {}),
      ...(canManage && fix?.fix !== "remove"
        ? { menu: [{ label: "Remove", onClick: remove, destructive: true, disabled: rowDisabled }] }
        : {}),
    };
  });
  const personalLogin = personalConnection
    ? String(personalConnection.metadata.githubLogin ?? "connected")
    : null;
  // The page opens with what needs attention, naming the installation. The
  // row keeps the one fix, so the summary has no action of its own.
  const attentionRows = installations.flatMap((installation, index) => {
    const attention = githubInstallationAttention(installation);
    return attention ? [{ attention, row: installationRows[index]! }] : [];
  });
  const attentionNotice: IntegrationViewModel["notice"] =
    attentionRows.length === 0
      ? undefined
      : {
          tone: "waiting",
          title:
            attentionRows.length === 1
              ? attentionRows[0]!.attention.summary
              : attentionRows.length <= 3
                ? `${githubListText(attentionRows.map(({ row }) => row.title))} need attention.`
                : `${attentionRows.length} installations need attention.`,
        };
  // Unknown until the selection loads: a failed read is not "0 repos".
  const personalRepositoryCount = context.personalGitHubSelection?.repositories.length ?? null;
  const personalAllRepositories =
    Boolean(context.personalGitHubSelection?.allRepositoriesAccess) &&
    context.personalGitHubStatus?.allRepositoriesAvailable !== false;
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
          status:
            personalRepositoryCount === null
              ? `Connected as @${personalLogin}`
              : personalAllRepositories
                ? `Connected as @${personalLogin} · All repos`
                : `Connected as @${personalLogin} · ${personalRepositoryCount === 1 ? "1 repo" : `${personalRepositoryCount} repos`}`,
        }
      : personalNeedsAttention
        ? { status: `@${personalLogin} needs to reconnect.`, statusTone: "warn" as const }
        : {}),
    ...(!canManagePersonal
      ? { note: "Your access doesn't allow connecting accounts in this workspace." }
      : {
          action: personalConnected
            ? {
                label: "Choose repos",
                onClick: () => setPersonalOpen(true),
                primary: personalRepositoryCount === 0 && !personalAllRepositories,
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
  const operatorUnconfigured =
    status !== null && status.setupMode === "operator" && !status.configured;
  const appSection: IntegrationSection = {
    id: "github-app",
    ...GITHUB_APP_SECTION,
    // The rows say where it is installed and what needs attention.
    ...(status === null ? { status: "Loading…" } : {}),
    ...(linked ? { rows: installationRows } : {}),
    ...(!canManage
      ? {
          note: linked
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
              label: linked ? "Install on another account" : "Install app",
              onClick: () => reconnect(),
              primary: !linked,
              busy,
              disabled: connectUrl === null && !operatorUnconfigured,
              ...(operatorUnconfigured ? {} : { connectProviderId: "github-app" }),
            },
          }),
  };
  // Approvals: one compact table. Rows are the three kinds of action; columns
  // are who acts. "Opengeni app" covers every installation at once (Mixed when
  // they differ), with per-installation choices behind Advanced.
  const policyActors = actionPolicies?.enabled ? actionPolicies.actors : [];
  const appPolicyActors = policyActors.filter((actor) => actor.kind === "workspace_app");
  const personalPolicyActors = policyActors.filter((actor) => actor.kind === "personal");
  const policyColumns: Array<{
    id: string;
    label: string;
    actors: GitHubActionPolicyActorState[];
    editable: boolean;
  }> = [
    ...(appPolicyActors.length > 0
      ? [{ id: "app", label: "Opengeni app", actors: appPolicyActors, editable: canManage }]
      : []),
    ...(personalPolicyActors.length > 0
      ? [
          {
            id: "personal",
            label: "Your GitHub",
            actors: personalPolicyActors,
            editable: canManagePersonal,
          },
        ]
      : []),
  ];
  const policyCell = (
    actors: GitHubActionPolicyActorState[],
    groups: GitHubActionPolicyGroup[],
    editable: boolean,
    busyKey: string,
  ): IntegrationPolicyCell | undefined =>
    actors.length === 0
      ? undefined
      : {
          value: commonGitHubActionPolicyDecision(actors, groups),
          disabled: !editable || actionPolicyBusy !== null,
          busy: actionPolicyBusy === busyKey,
        };
  const setPolicies = (
    actors: GitHubActionPolicyActorState[],
    groups: GitHubActionPolicyGroup[],
    value: string,
    busyKey: string,
  ) => {
    if (value !== "allow" && value !== "ask" && value !== "block") return;
    void updateActionPolicies(
      actors.flatMap((actor) =>
        groups
          .filter((group) => actor.groups[group] !== value)
          .map((group) => ({ actor, group, decision: value })),
      ),
      busyKey,
    );
  };
  const policyGroupIds = GITHUB_ACTION_POLICY_GROUPS.map((group) => group.id);
  const isPolicyGroup = (id: string): id is GitHubActionPolicyGroup =>
    policyGroupIds.includes(id as GitHubActionPolicyGroup);
  const columnFor = (columnId: string) => policyColumns.find((column) => column.id === columnId);
  const installationName = (actor: GitHubActionPolicyActorState) =>
    actor.kind === "workspace_app"
      ? (installations.find((installation) => installation.installationId === actor.installationId)
          ?.accountLogin ?? actor.label)
      : actor.label;
  const appPoliciesDiffer = policyGroupIds.some(
    (group) => commonGitHubActionPolicyDecision(appPolicyActors, [group]) === "mixed",
  );
  const policyRows = GITHUB_ACTION_POLICY_GROUPS.map(({ id, label }) => ({ id, label }));
  const policies: IntegrationPolicyTable | undefined = actionPolicyFailed
    ? {
        title: "Approvals",
        columns: [],
        rows: [],
        choices: [],
        cell: () => undefined,
        onChange: () => {},
        failure: {
          message: "Approval settings could not be loaded.",
          onRetry: () => void refreshActionPolicies(),
        },
      }
    : policyColumns.length > 0
      ? {
          title: "Approvals",
          columns: policyColumns.map(({ id, label }) => ({ id, label })),
          rows: policyRows,
          choices: GITHUB_ACTION_POLICY_CHOICES,
          otherValueLabels: { mixed: "Mixed" },
          cell: (rowId, columnId) => {
            const column = columnFor(columnId);
            return column && isPolicyGroup(rowId)
              ? policyCell(column.actors, [rowId], column.editable, `${columnId}:${rowId}`)
              : undefined;
          },
          onChange: (rowId, columnId, value) => {
            const column = columnFor(columnId);
            if (column && isPolicyGroup(rowId))
              setPolicies(column.actors, [rowId], value, `${columnId}:${rowId}`);
          },
          all: {
            label: "All actions",
            cell: (columnId) => {
              const column = columnFor(columnId);
              return column
                ? policyCell(column.actors, policyGroupIds, column.editable, `${columnId}:all`)
                : undefined;
            },
            onChange: (columnId, value) => {
              const column = columnFor(columnId);
              if (column) setPolicies(column.actors, policyGroupIds, value, `${columnId}:all`);
            },
          },
          footnote: "Changes apply to new actions.",
          ...(policyColumns.some((column) => column.id === "app" && !column.editable)
            ? { note: "A workspace admin sets the Opengeni app's approvals." }
            : {}),
          ...(appPolicyActors.length > 1
            ? {
                advanced: {
                  title: "Advanced",
                  summary: appPoliciesDiffer
                    ? "Installations are set differently"
                    : "Set each installation separately",
                  columns: appPolicyActors.map((actor) => ({
                    id: githubActionPolicyActorId(actor),
                    label: installationName(actor),
                  })),
                  rows: policyRows,
                  choices: GITHUB_ACTION_POLICY_CHOICES,
                  otherValueLabels: { mixed: "Mixed" },
                  cell: (rowId, columnId) => {
                    const actor = appPolicyActors.find(
                      (candidate) => githubActionPolicyActorId(candidate) === columnId,
                    );
                    return actor && isPolicyGroup(rowId)
                      ? policyCell([actor], [rowId], canManage, `${columnId}:${rowId}`)
                      : undefined;
                  },
                  onChange: (rowId, columnId, value) => {
                    const actor = appPolicyActors.find(
                      (candidate) => githubActionPolicyActorId(candidate) === columnId,
                    );
                    if (actor && isPolicyGroup(rowId))
                      setPolicies([actor], [rowId], value, `${columnId}:${rowId}`);
                  },
                },
              }
            : {}),
        }
      : undefined;

  const model: IntegrationViewModel = {
    id: "github",
    name: "GitHub",
    description: sectioned ? GITHUB_DESCRIPTION : GITHUB_APP_DESCRIPTION,
    mark: { logoSrc: GITHUB_LOGO_URL, monogram: "G" },
    chip,
    connection: sectioned ? [] : facts,
    // Without personal sign-in the header owns connecting; the installation
    // rows still need a home, so the app section keeps only them.
    sections: sectioned
      ? [personalSection, appSection]
      : linked
        ? [{ id: "github-app", ...GITHUB_APP_SECTION, rows: installationRows }]
        : [],
    ...(policies ? { policies } : {}),
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
            // Each installation row changes its own repositories. A long list
            // folds behind its count so Approvals stay above the fold.
            ...(repositories.length > GITHUB_REPOSITORY_LIST_FOLD_AT
              ? {
                  collapsed: {
                    summary: `${repositories.length} repositories`,
                    searchLabel: "Search repositories",
                    noMatchesMessage: "No repositories match.",
                  },
                }
              : {}),
          },
        }
      : {}),
    options: [],
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
      : attentionNotice
        ? { notice: attentionNotice }
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
      <ConfirmDialog
        open={unlinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
        title={`Remove ${unlinkTarget?.account ?? "this installation"} from this workspace?`}
        description="Sessions lose access to its repositories. The app stays installed on GitHub until you remove it there."
        confirmLabel="Remove"
        cancelAutoFocus
        onConfirm={async () => {
          if (unlinkTarget === null) return true;
          setDisconnecting(true);
          try {
            return await context.disconnectGitHubInstallation(
              workspaceId,
              unlinkTarget.installationId,
            );
          } finally {
            setDisconnecting(false);
          }
        }}
      />
      {personalConnection ? (
        <PersonalGitHubDialog
          open={personalOpen}
          onOpenChange={setPersonalOpen}
          login={String(personalConnection.metadata.githubLogin ?? "connected")}
          repositories={context.personalGitHubRepositories}
          savedRepositories={context.personalGitHubSelection?.repositories}
          allRepositoriesAccess={context.personalGitHubSelection?.allRepositoriesAccess ?? null}
          allRepositoriesAvailable={context.personalGitHubStatus?.allRepositoriesAvailable === true}
          loading={!personalCatalogReady}
          busy={context.personalGitHubBusy}
          onSave={(selections, allRepositoriesAccess) =>
            context.savePersonalGitHubRepositories(workspaceId, selections, allRepositoriesAccess)
          }
          onSearch={(query) => context.searchPersonalGitHubRepositories(workspaceId, query)}
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
  // A linked installation that is not active needs attention even when none
  // is active (the workspace then reads as unbound).
  if (status.installations.some((installation) => installation.lifecycle !== "active")) {
    return { label: "Needs attention", tone: "warn" };
  }
  const bound = status.status === "bound" && status.installations.length > 0;
  if (bound) {
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

/** Above this many repositories the list folds behind its count. */
const GITHUB_REPOSITORY_LIST_FOLD_AT = 8;

/** "a", "a and b", "a, b and c". */
function githubListText(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The repair of one installation: which installation, what is wrong and what
 * to do. It names the installation, so Connect skips the account chooser.
 */
function githubRepairDialog(
  installation: GitHubInstallationBinding,
  fix: "reinstall" | "authorize",
): Pick<NativeConnectRequest, "title" | "description" | "authorizeLabel" | "reconnectAccountId"> {
  const account = installation.accountLogin ?? "this account";
  const reconnectAccountId = `github-installation:${installation.installationId}`;
  if (fix === "reinstall") {
    return {
      title: `Reinstall on ${account}`,
      description: "The Opengeni app was removed on GitHub. Install it again.",
      authorizeLabel: "Reinstall on GitHub",
      reconnectAccountId,
    };
  }
  return {
    title: `Authorize ${account}`,
    description:
      installation.accountType === "Organization"
        ? `Sign in to GitHub as an owner of ${account} to confirm this link.`
        : `Sign in to GitHub as ${account} to confirm this link.`,
    authorizeLabel: "Sign in to GitHub",
    reconnectAccountId,
  };
}

function githubActionPolicyActorId(actor: GitHubActionPolicyActorState): string {
  return actor.kind === "workspace_app"
    ? `app-${actor.installationId}`
    : `personal-${actor.connectionId}`;
}

/** The one decision every actor has for every group, or "mixed". */
function commonGitHubActionPolicyDecision(
  actors: GitHubActionPolicyActorState[],
  groups: GitHubActionPolicyGroup[],
): string {
  const values = new Set(actors.flatMap((actor) => groups.map((group) => actor.groups[group])));
  return values.size === 1 ? [...values][0]! : "mixed";
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
