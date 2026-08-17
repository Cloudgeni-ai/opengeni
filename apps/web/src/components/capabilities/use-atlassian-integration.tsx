import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { request as apiRequest } from "@/api";
import { AtlassianSourceDialog } from "@/components/capabilities/atlassian-source-dialog";
import { saveAtlassianSources } from "@/components/capabilities/atlassian-sources";
import type {
  IntegrationChip,
  IntegrationFooter,
  IntegrationOption,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import type { IntegrationAdapter } from "@/components/capabilities/use-google-drive-integration";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import {
  ATLASSIAN_APP_DESCRIPTION,
  atlassianConnectionMetadata,
  atlassianStatus,
  localConnectedAtlassianPreview,
  preferredAtlassianConnection,
} from "@/lib/atlassian-connection";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import type { ConnectionMetadata } from "@/types";

export const ATLASSIAN_LOGO_URL =
  "https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png";

/** Maps the Atlassian (Jira and Confluence) connection onto the shared integration view-model. */
export function useAtlassianIntegration({
  workspaceId,
  connections,
  connectionsLoaded,
  connectionsLoadFailed = false,
  refresh,
  replaceConnection,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  connectionsLoaded: boolean;
  /** True when the connection list failed to load (so the state is unknown, not empty). */
  connectionsLoadFailed?: boolean;
  refresh: () => Promise<void>;
  replaceConnection: (connection: ConnectionMetadata) => void;
}): IntegrationAdapter {
  const context = useAppContext();
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const canWrite = hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  const canManageWorkspace = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const workspaceGrant = context.accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManageOrganization = Boolean(
    workspaceGrant &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const [busy, setBusy] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const preview = useMemo(
    () => localConnectedAtlassianPreview(window.location.search, workspaceId),
    [workspaceId],
  );
  const connection = preview ?? preferredAtlassianConnection(connections ?? []);
  const metadata = connection ? atlassianConnectionMetadata(connection.metadata) : null;
  const status = atlassianStatus(connection, connectionsLoaded || preview !== null);
  const readOnly = preview !== null;
  const selectedSources = metadata?.selectedSources ?? [];
  const canChange = canWrite && !readOnly && !busy;

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("atlassian");
    if (!result) return;
    if (result === "connected") {
      toast.success("Atlassian connected", {
        description: "Choose the Jira projects and Confluence spaces agents may use.",
      });
      void refresh();
    } else {
      toast.error("Atlassian connection failed", {
        description: atlassianFailureMessage(url.searchParams.get("reason")),
      });
    }
    url.searchParams.delete("atlassian");
    url.searchParams.delete("connectionId");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function connect(reconnect = false) {
    if (!canWrite || readOnly) return;
    setBusy(true);
    try {
      const start = await apiRequest<{ authorizationUrl: string }>(
        `/v1/workspaces/${workspaceId}/connections/atlassian/install`,
        {
          method: "POST",
          body: JSON.stringify(reconnect && connection ? { connectionId: connection.id } : {}),
        },
      );
      window.location.assign(start.authorizationUrl);
    } catch (error) {
      toast.error("Atlassian connection could not start", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    if (!connection || !canWrite || readOnly) return true;
    setBusy(true);
    try {
      const { connection: updated } = await apiRequest<{ connection: ConnectionMetadata }>(
        `/v1/workspaces/${workspaceId}/connections/${connection.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            expectedVersion: connection.version,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      replaceConnection(updated);
      toast.success("Atlassian disconnected");
      return true;
    } catch (error) {
      toast.error("Atlassian could not be disconnected", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setSyncEnabled(enabled: boolean) {
    if (!connection || !metadata || selectedSources.length === 0 || !canWrite || readOnly) return;
    setBusy(true);
    try {
      const updated = await saveAtlassianSources(workspaceId, connection.id, {
        sources: selectedSources,
        authorityKind:
          metadata.documentDestination?.authorityKind ??
          selectedSources[0]?.destination?.authorityKind ??
          "workspace",
        syncCadence: selectedSources[0]?.syncCadence ?? "hourly",
        syncEnabled: enabled,
      });
      replaceConnection(updated);
      toast.success(enabled ? "Knowledge sync turned on" : "Knowledge sync turned off");
    } catch (error) {
      toast.error("Atlassian sources could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const connected = status === "connected" || status === "paused" || status === "needs_attention";
  // A failed connection-list load means the state is unknown, not "still
  // loading": say so, offer a retry, and keep the Connect affordance usable.
  const loadFailed = status === "loading" && connectionsLoadFailed;
  const chip: IntegrationChip =
    canRead && loadFailed
      ? { label: "Needs attention", tone: "warn" }
      : atlassianChip(status, canRead, canWrite);

  const facts: IntegrationViewModel["connection"] = [];
  if (canRead && metadata && connected) {
    facts.push({ label: "Atlassian account", value: metadata.email ?? metadata.displayName });
    if (metadata.sites.length > 0) {
      facts.push({
        label: metadata.sites.length === 1 ? "Site" : "Sites",
        value: metadata.sites.map((site) => site.name).join(", "),
      });
    }
  }

  const options: IntegrationOption[] = [];
  if (canRead && metadata && connected && selectedSources.length > 0) {
    options.push({
      kind: "toggle",
      id: "atlassian-sync",
      label: "Add to the knowledge base",
      description:
        "Keeps selected issues and pages indexed for fast retrieval. Live reading works either way.",
      checked: selectedSources.some((source) => source.syncEnabled),
      disabled: !canChange,
      busy,
      onChange: (checked) => void setSyncEnabled(checked),
    });
  }

  const footer: IntegrationFooter = !canRead
    ? { kind: "locked" }
    : status === "loading"
      ? loadFailed && canWrite
        ? { kind: "setup", onSetup: () => void connect(), busy }
        : { kind: "setup", onSetup: () => {}, disabled: true }
      : !connected
        ? canWrite
          ? { kind: "setup", onSetup: () => void connect(), busy }
          : { kind: "locked" }
        : canWrite
          ? {
              kind: status === "needs_attention" ? "repair" : "connected",
              onReconnect: () => void connect(true),
              onDisconnect: () => setDisconnectOpen(true),
              reconnectDisabled: readOnly,
              disconnectDisabled: readOnly,
              busy,
            }
          : { kind: "locked" };

  const model: IntegrationViewModel = {
    id: "atlassian",
    name: "Jira & Confluence",
    description: ATLASSIAN_APP_DESCRIPTION,
    mark: { logoSrc: ATLASSIAN_LOGO_URL, monogram: "A" },
    chip,
    connection: facts,
    ...(canRead && metadata && connected
      ? {
          access: {
            title: "Projects and spaces",
            items: selectedSources.map((source) => ({
              name: source.name,
              meta: `${source.kind === "jira_project" ? "Jira project" : "Confluence space"} · ${source.key}`,
            })),
            emptyMessage:
              "No projects or spaces selected yet. Agents cannot read Jira or Confluence until you choose some.",
            // In needs_attention there is no source browsing: the repair footer
            // routes to reconnect instead. While busy the affordance stays
            // mounted but disabled so it does not jump in and out.
            ...(canWrite && status !== "needs_attention"
              ? {
                  editLabel: "Change sources",
                  onEdit: () => setSourceDialogOpen(true),
                  editDisabled: busy,
                }
              : {}),
          },
        }
      : {}),
    options,
    footer,
    ...(loadFailed && canRead
      ? {
          notice: {
            tone: "failed" as const,
            title: "Connections could not be loaded",
            description: "The Atlassian status is unknown until the connection list loads.",
            action: { label: "Retry", onClick: () => void refresh() },
          },
        }
      : status === "paused"
        ? {
            notice: {
              tone: "waiting" as const,
              title: "Knowledge sync is paused",
              description: "Agents can still read the selected sources live.",
            },
          }
        : {}),
  };

  const dialogs = canRead ? (
    <>
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Atlassian?"
        description="Agents will lose live Jira and Confluence access, and synchronization will stop. Already imported knowledge remains available."
        confirmLabel="Disconnect Atlassian"
        cancelAutoFocus
        onConfirm={disconnect}
      />
      <AtlassianSourceDialog
        workspaceId={workspaceId}
        connection={connection}
        metadata={metadata}
        open={sourceDialogOpen}
        readOnly={readOnly}
        canWrite={canWrite}
        canManageWorkspace={canManageWorkspace}
        canManageOrganization={canManageOrganization}
        onOpenChange={setSourceDialogOpen}
        onConnectionUpdated={replaceConnection}
        onSaveFailed={refresh}
      />
    </>
  ) : null;

  return { model, dialogs };
}

export function atlassianChip(
  status: ReturnType<typeof atlassianStatus>,
  canRead: boolean,
  canWrite: boolean,
): IntegrationChip {
  if (!canRead) return { label: "Set up by an admin", tone: "plain" };
  switch (status) {
    case "loading":
      return { label: "Loading", tone: "plain" };
    case "connected":
    case "paused":
      return canWrite
        ? { label: "Connected", tone: "ok" }
        : { label: "Set up by an admin", tone: "plain" };
    case "needs_attention":
      return { label: "Needs attention", tone: "warn" };
    case "not_connected":
      return { label: "Not connected", tone: "idle" };
  }
}

function atlassianFailureMessage(reason: string | null): string {
  if (reason === "provider_denied") return "Atlassian access was not approved.";
  if (reason === "scope_not_granted") return "The required read permissions were not approved.";
  if (reason === "no_accessible_sites")
    return "This account has no accessible Jira or Confluence sites.";
  if (reason === "account_mismatch") return "Reconnect with the same Atlassian account.";
  if (reason === "refresh_token_missing")
    return "Offline access was not granted. Try connecting again.";
  return "Check the Atlassian OAuth configuration and try again.";
}
