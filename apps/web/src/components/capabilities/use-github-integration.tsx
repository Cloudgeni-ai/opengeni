import { useState } from "react";

import type {
  IntegrationChip,
  IntegrationFooter,
  IntegrationOption,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import type { IntegrationAdapter } from "@/components/capabilities/use-api-integration-accounts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PersonalGitHubDialog } from "@/components/capabilities/personal-github-dialog";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { GitHubAppInfo } from "@/types";

export const GITHUB_APP_DESCRIPTION =
  "Use the workspace App for automation, or your identity for reviews and merges.";
// GitHub is the workspace App binding, not a catalog item, so there is no
// catalogAssetUrl logo path for it; like the other integration marks this is a
// provider-hosted logo with the monogram as the offline fallback.
export const GITHUB_LOGO_URL = "https://github.githubassets.com/favicons/favicon.svg";

/**
 * Maps the workspace GitHub App binding onto the shared integration view-model.
 * The GitHub status, repositories, and mutations already live in the app
 * context (the repository picker uses the same data), so this adapter reads
 * from there instead of fetching again.
 */
export function useGitHubIntegration({ workspaceId }: { workspaceId: string }): IntegrationAdapter {
  const context = useAppContext();
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "github:manage");
  const status = context.githubStatus;
  const repositories = context.githubRepos;
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [personalDisconnectOpen, setPersonalDisconnectOpen] = useState(false);
  const installations = status?.installations ?? [];
  const busy = context.githubAppBusy || disconnecting;

  // A failed status fetch with no prior snapshot is unknown, not unbound: show a
  // visible failure with a retry instead of pinning the tile at Loading.
  const statusFailed = status === null && !context.repoBusy && context.githubStatusFailed;
  const catalogLoading = context.repoBusy || !context.githubCatalogReady;
  const personalConnection = context.personalGitHubStatus?.connection ?? null;
  const personalConnected = personalConnection?.status === "active";
  const personalNeedsAttention = Boolean(
    personalConnection && personalConnection.status !== "active",
  );
  const bound = status?.status === "bound" && installations.length > 0;
  const broken = bound && installations.some((installation) => installation.lifecycle !== "active");
  const chip =
    personalNeedsAttention || broken || statusFailed
      ? ({ label: "Needs attention", tone: "warn" } as const)
      : personalConnected
        ? ({ label: "Connected", tone: "ok" } as const)
        : githubChip(status, canManage, statusFailed);
  const connectUrl = status?.installUrl ?? status?.linkUrl ?? null;

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
    facts.push({ label: "GitHub App", value: "Not registered for this deployment" });
  }
  if (personalConnection) {
    facts.push({
      label: "Your GitHub identity",
      value: `@${String(personalConnection.metadata.githubLogin ?? "connected")}`,
    });
  }

  function reconnect() {
    if (connectUrl) {
      window.location.assign(connectUrl);
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
  const footer: IntegrationFooter =
    context.personalGitHubStatus?.enabled && canManage
      ? status === null
        ? {
            kind: "actions",
            primary: {
              label: "Loading workspace App…",
              onClick: () => {},
              disabled: true,
            },
          }
        : bound
          ? {
              kind: "actions",
              primary: {
                label: broken ? "Repair workspace App" : "Connect another account",
                onClick: reconnect,
                disabled: connectUrl === null,
              },
              secondary: {
                label: "Disconnect workspace App",
                onClick: () => setDisconnectOpen(true),
                destructive: true,
              },
              busy,
            }
          : {
              kind: "actions",
              primary: {
                label: "Set up workspace App",
                onClick: reconnect,
                disabled:
                  connectUrl === null && !(status.setupMode === "operator" && !status.configured),
              },
              busy,
            }
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
            onClick: () => window.location.assign(installation.configureUrl!),
          },
        }))
      : [];
  const personalOption: IntegrationOption[] = context.personalGitHubStatus?.enabled
    ? [
        {
          kind: "link" as const,
          id: "github-personal-identity",
          label: "Your GitHub identity",
          description: personalConnected
            ? `${context.personalGitHubSelection?.repositories.length ?? 0} allowed repositories. Reviews and merges appear as you.`
            : personalNeedsAttention
              ? "Reconnect to keep reviewing and merging as yourself."
              : "Approve, review, and merge as yourself.",
          action: {
            label: personalConnected ? "Manage" : personalNeedsAttention ? "Reconnect" : "Connect",
            onClick: () => {
              if (personalConnected) setPersonalOpen(true);
              else if (personalNeedsAttention) void context.reconnectPersonalGitHub(workspaceId);
              else void context.connectPersonalGitHub(workspaceId);
            },
          },
          disabled: context.personalGitHubBusy,
        },
      ]
    : [];
  const options = [...personalOption, ...installationOptions];

  const model: IntegrationViewModel = {
    id: "github",
    name: "GitHub",
    description: GITHUB_APP_DESCRIPTION,
    mark: { logoSrc: GITHUB_LOGO_URL, monogram: "G" },
    chip,
    connection: facts,
    ...(bound
      ? {
          access: {
            title: "Repositories",
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
                  onEdit: () => window.location.assign(configureUrl),
                }
              : {}),
          },
        }
      : {}),
    options,
    footer,
    ...(statusFailed
      ? {
          notice: {
            tone: "failed" as const,
            title: "GitHub status could not be loaded.",
            description: "The GitHub App binding is unknown until the status loads.",
            action: {
              label: "Retry",
              onClick: () => void context.refreshGitHub(workspaceId),
            },
          },
        }
      : status && !status.configured && status.setupMode === "platform"
        ? {
            notice: {
              tone: "muted" as const,
              title: "GitHub is temporarily unavailable for this OpenGeni deployment.",
            },
          }
        : {}),
  };

  const dialogs = (
    <>
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect GitHub?"
        description={
          installations.length > 1
            ? `This unlinks all ${installations.length} GitHub installations from this workspace. Sessions lose access to their repositories, and the app stays installed on GitHub until you remove it there.`
            : "This unlinks the GitHub installation from this workspace. Sessions lose access to its repositories, and the app stays installed on GitHub until you remove it there."
        }
        confirmLabel="Disconnect GitHub"
        cancelAutoFocus
        onConfirm={disconnectAll}
      />
      {personalConnection ? (
        <PersonalGitHubDialog
          open={personalOpen}
          onOpenChange={setPersonalOpen}
          login={String(personalConnection.metadata.githubLogin ?? "connected")}
          repositories={context.personalGitHubRepositories}
          busy={context.personalGitHubBusy}
          onSave={(selections) => context.savePersonalGitHubRepositories(workspaceId, selections)}
          onReconnect={() => void context.reconnectPersonalGitHub(workspaceId)}
          onDisconnect={() => setPersonalDisconnectOpen(true)}
        />
      ) : null}
      <ConfirmDialog
        open={personalDisconnectOpen}
        onOpenChange={setPersonalDisconnectOpen}
        title="Disconnect your GitHub identity?"
        description="OpenGeni will stop acting as you. The workspace GitHub App is unaffected."
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
    : "No repositories are shared with OpenGeni yet. Change repositories on GitHub to allow some.";
}
