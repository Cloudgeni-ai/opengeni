import { useState } from "react";

import type {
  IntegrationChip,
  IntegrationFooter,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import type { IntegrationAdapter } from "@/components/capabilities/use-google-drive-integration";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { GitHubAppInfo } from "@/types";

export const GITHUB_APP_DESCRIPTION =
  "Read code and open pull requests in the repositories you allow.";
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
  const installations = status?.installations ?? [];
  const busy = context.githubAppBusy || disconnecting;

  const chip = githubChip(status, canManage);
  const bound = status?.status === "bound" && installations.length > 0;
  const broken = bound && installations.some((installation) => installation.lifecycle !== "active");
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
      for (const installation of installations) {
        await context.disconnectGitHubInstallation(workspaceId, installation.installationId);
      }
      return true;
    } finally {
      setDisconnecting(false);
    }
  }

  const footer: IntegrationFooter = !canManage
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

  const configureUrl =
    installations.find((installation) => installation.configureUrl)?.configureUrl ?? null;

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
            emptyMessage: githubEmptyRepositoriesMessage(installations),
            ...(canManage && configureUrl
              ? {
                  editLabel: "Change repositories",
                  onEdit: () => window.location.assign(configureUrl),
                }
              : {}),
          },
        }
      : {}),
    options: [],
    footer,
    ...(status && !status.configured && status.setupMode === "platform"
      ? {
          notice: {
            tone: "muted" as const,
            title: "GitHub is temporarily unavailable for this OpenGeni deployment.",
          },
        }
      : {}),
  };

  const dialogs = (
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
  );

  return { model, dialogs };
}

export function githubChip(status: GitHubAppInfo | null, canManage: boolean): IntegrationChip {
  if (status === null) return { label: "Loading", tone: "plain" };
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
