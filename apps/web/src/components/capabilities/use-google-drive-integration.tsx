import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { request as apiRequest } from "@/api";
import {
  configuredGoogleDriveSources,
  googleDriveBoundaryLabel,
  googleDriveCadenceLabel,
  googleDriveReadPolicyLabel,
  googleDriveScopeLabel,
  saveGoogleDriveSources,
} from "@/components/capabilities/google-drive-sources";
import type {
  IntegrationChip,
  IntegrationFooter,
  IntegrationOption,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import {
  GOOGLE_DRIVE_APP_DESCRIPTION,
  googleDriveAccountState,
  googleDriveCanPublish,
  googleDriveCanReadSources,
  googleDriveConnectionMetadata,
  googleDriveDisconnectAttempt,
  localConnectedGoogleDrivePreview,
  preferredGoogleDriveConnection,
  type GoogleDriveAccountState,
  type GoogleDriveDisconnectAttempt,
} from "@/lib/google-drive-connection";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import type {
  ConnectionMetadata,
  GoogleDriveLifecycleActionRequest,
  GoogleDriveOAuthStartResponse,
} from "@/types";

// The folder picker (Drive browsing, paging, and the save form) is only needed
// once an admin edits folders; keep it behind its own lazy boundary.
const GoogleDriveFolderDialog = lazy(async () => {
  const module = await import("@/components/capabilities/google-drive-folder-dialog");
  return { default: module.GoogleDriveFolderDialog };
});

export const GOOGLE_DRIVE_LOGO_URL =
  "https://www.gstatic.com/images/branding/productlogos/drive_2026/v2/web-64dp/logo_drive_2026_color_2x_web_64dp.png";

export type IntegrationAdapter = {
  model: IntegrationViewModel;
  dialogs: ReactNode;
};

/** Maps the Google Drive knowledge connection onto the shared integration view-model. */
export function useGoogleDriveIntegration({
  workspaceId,
  connections,
  connectionsLoaded,
  refresh,
  replaceConnection,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  connectionsLoaded: boolean;
  refresh: () => Promise<void>;
  replaceConnection: (connection: ConnectionMetadata) => void;
}): IntegrationAdapter {
  const context = useAppContext();
  const client = context.client;
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const canWrite = hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  const workspaceGrant = context.accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManageWorkspaceDestination = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const canManageOrganizationDestination = Boolean(
    workspaceGrant &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const [busy, setBusy] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<GoogleDriveDisconnectAttempt | null>(
    null,
  );

  const previewConnection = useMemo(
    () => localConnectedGoogleDrivePreview(window.location.search, workspaceId),
    [workspaceId],
  );
  const connection = previewConnection ?? preferredGoogleDriveConnection(connections ?? []);
  const readOnly = previewConnection !== null;
  const accountState = googleDriveAccountState(
    connection,
    previewConnection !== null || connectionsLoaded,
  );
  const metadata = connection
    ? (googleDriveConnectionMetadata(connection.metadata) ?? undefined)
    : undefined;
  const savedSources = configuredGoogleDriveSources(metadata);
  const savedDefaults = savedSources[0];
  const canReadSources = googleDriveCanReadSources(metadata);
  const canPublish = googleDriveCanPublish(connection);
  const outputDestination = metadata?.outputDestination;
  const canChange = canWrite && !readOnly && !busy;

  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("google_drive");
    if (!status) return;
    const completedCapability = window.sessionStorage.getItem(
      `opengeni:google-drive-oauth-capability:${workspaceId}`,
    );
    window.sessionStorage.removeItem(`opengeni:google-drive-oauth-capability:${workspaceId}`);
    if (status === "connected") {
      if (completedCapability === "publish") {
        toast.success("Google Drive publishing configured", {
          description: "The selected output folder is active. Connector writes ask by default.",
        });
      } else {
        toast.success("Google Drive connected", {
          description: "Choose the folders OpenGeni may read and turn on sync when ready.",
        });
      }
      void refresh();
    } else {
      toast.error("Google Drive connection failed", {
        description: googleDriveFailureMessage(url.searchParams.get("reason")),
      });
    }
    url.searchParams.delete("google_drive");
    url.searchParams.delete("connectionId");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function connect(reconnect = false, capability: "source_read" | "publish" = "source_read") {
    if (!canWrite) return;
    setBusy(true);
    try {
      const start = await apiRequest<GoogleDriveOAuthStartResponse>(
        `/v1/workspaces/${workspaceId}/connections/google-drive/install`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(reconnect && connection ? { connectionId: connection.id } : {}),
            capability,
          }),
        },
      );
      window.sessionStorage.setItem(
        `opengeni:google-drive-oauth-capability:${workspaceId}`,
        capability,
      );
      window.location.assign(start.authorizationUrl);
    } catch (error) {
      toast.error("Google Drive connection could not start", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
    }
  }

  async function transitionLifecycle(action: GoogleDriveLifecycleActionRequest["action"]) {
    if (!connection || !canWrite) return;
    setBusy(true);
    try {
      const updated = await client.transitionGoogleDriveLifecycle(workspaceId, connection.id, {
        action,
        expectedVersion: connection.version,
      });
      replaceConnection(updated);
      toast.success(action === "pause" ? "Google Drive paused" : "Google Drive resumed");
    } catch (error) {
      toast.error(
        action === "pause" ? "Google Drive could not be paused" : "Google Drive could not resume",
        { description: error instanceof Error ? error.message : String(error) },
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    if (!connection || !canWrite) return true;
    setBusy(true);
    try {
      const attempt = googleDriveDisconnectAttempt(connection, pendingDisconnect);
      setPendingDisconnect(attempt);
      const revoked = await client.disconnectGoogleDriveConnection(workspaceId, connection.id, {
        expectedVersion: attempt.expectedVersion,
        idempotencyKey: attempt.idempotencyKey,
      });
      replaceConnection(revoked);
      setPendingDisconnect(null);
      toast.success("Google Drive disconnected");
      return true;
    } catch (error) {
      toast.error("Google Drive could not be disconnected", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setSyncEnabled(enabled: boolean) {
    if (!connection || !savedDefaults || !canWrite) return;
    setBusy(true);
    try {
      const updated = await saveGoogleDriveSources(workspaceId, connection.id, {
        sources: savedSources,
        authorityKind: savedDefaults.authorityKind,
        syncCadence: savedDefaults.syncCadence,
        syncEnabled: enabled,
        readPolicy: savedDefaults.readPolicy,
      });
      replaceConnection(updated);
      toast.success(enabled ? "Google Drive sync turned on" : "Google Drive sync turned off");
    } catch (error) {
      toast.error("Google Drive sync could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const chip = googleDriveChip(accountState.state, canRead, canWrite);
  const stateNotice = googleDriveStateNotice(accountState.state);
  const connected = accountState.state !== "not_connected" && accountState.state !== "disconnected";

  const facts: IntegrationViewModel["connection"] = [];
  if (connection && metadata && canRead) {
    facts.push({
      label: "Google account",
      value: metadata.googleDisplayName
        ? `${metadata.googleDisplayName} (${metadata.googleEmail})`
        : metadata.googleEmail,
    });
    if (savedDefaults) {
      facts.push({ label: "Saves to", value: googleDriveScopeLabel(savedDefaults.authorityKind) });
      facts.push({
        label: "Checks for changes",
        value: `${googleDriveCadenceLabel(savedDefaults.syncCadence)} · ${googleDriveReadPolicyLabel(savedDefaults.readPolicy)}`,
      });
    }
    facts.push({
      label: "Publishing",
      value: outputDestination
        ? `${outputDestination.location === "shared_drive" ? "Shared Drive" : "My Drive"} · ${outputDestination.folderName}`
        : canPublish
          ? "Allowed · no output folder yet"
          : "Not enabled",
    });
  }

  const options: IntegrationOption[] = [];
  if (canRead && connected && accountState.state === "paused") {
    options.push({
      kind: "toggle",
      id: "google-drive-paused",
      label: "Paused",
      description: "Turn off to resume browsing and sync for the selected folders.",
      checked: true,
      disabled: !canChange,
      busy,
      onChange: () => void transitionLifecycle("resume"),
    });
  }
  if (canRead && accountState.state === "connected" && savedSources.length > 0) {
    options.push({
      kind: "toggle",
      id: "google-drive-sync",
      label: "Keep folders in sync",
      description: savedDefaults
        ? `Checks ${googleDriveCadenceLabel(savedDefaults.syncCadence).toLowerCase()}. Off means files are read only when an agent asks for them.`
        : undefined,
      checked: savedDefaults?.syncEnabled ?? false,
      disabled: !canChange,
      busy,
      onChange: (checked) => void setSyncEnabled(checked),
    });
  }
  if (canRead && accountState.state === "connected") {
    options.push({
      kind: "toggle",
      id: "google-drive-publish",
      label: "Publish finished documents to Drive",
      description: canPublish
        ? "Completed documents are written to the output folder you chose. Turn off by disconnecting."
        : "Asks Google for separate write access to one output folder you choose.",
      checked: canPublish,
      disabled: !canChange || canPublish,
      busy,
      onChange: (checked) => {
        if (checked) void connect(true, "publish");
      },
      ...(canPublish && canReadSources && canChange
        ? {
            action: {
              label: outputDestination ? "Change output folder" : "Choose output folder",
              onClick: () => void connect(true, "publish"),
            },
          }
        : {}),
    });
  }

  const footer: IntegrationFooter = !canRead
    ? { kind: "locked" }
    : accountState.state === "unverified"
      ? { kind: "setup", onSetup: () => {}, disabled: true }
      : !connected
        ? canWrite
          ? { kind: "setup", onSetup: () => void connect(), disabled: readOnly, busy }
          : { kind: "locked" }
        : canWrite
          ? {
              kind:
                accountState.state === "connected" || accountState.state === "paused"
                  ? "connected"
                  : "repair",
              onReconnect: () => void connect(true),
              onDisconnect: () => setDisconnectOpen(true),
              reconnectDisabled: readOnly,
              disconnectDisabled: readOnly,
              busy,
            }
          : { kind: "locked" };

  const model: IntegrationViewModel = {
    id: "google-drive",
    name: "Google Drive",
    description: GOOGLE_DRIVE_APP_DESCRIPTION,
    mark: { logoSrc: GOOGLE_DRIVE_LOGO_URL, monogram: "D" },
    chip,
    connection: facts,
    ...(canRead && connected
      ? {
          access: {
            title: "Folders",
            items: savedSources.map((source) => ({
              name: googleDriveBoundaryLabel(source),
              meta: source.syncEnabled ? "syncing" : "on request",
            })),
            emptyMessage:
              "No folders selected yet. Agents cannot read Drive until you choose some.",
            ...(accountState.state === "connected" && canChange
              ? {
                  editLabel: canReadSources ? "Change folders" : "Allow folder access",
                  onEdit: canReadSources
                    ? () => setFolderDialogOpen(true)
                    : () => void connect(true, "source_read"),
                }
              : {}),
          },
        }
      : {}),
    options,
    footer,
    ...(stateNotice ? { notice: stateNotice } : {}),
  };

  const dialogs = canRead ? (
    <>
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Google Drive?"
        description="OpenGeni will stop using this connection. Google may still list the grant because disconnecting here does not revoke every grant for the Google OAuth project."
        confirmLabel="Disconnect Google Drive"
        cancelAutoFocus
        onConfirm={disconnect}
      />
      {folderDialogOpen ? (
        <Suspense fallback={null}>
          <GoogleDriveFolderDialog
            workspaceId={workspaceId}
            connection={connection}
            metadata={metadata}
            open={folderDialogOpen}
            canWrite={canWrite && !readOnly}
            canManageWorkspaceDestination={canManageWorkspaceDestination}
            canManageOrganizationDestination={canManageOrganizationDestination}
            onOpenChange={setFolderDialogOpen}
            onConnectionUpdated={replaceConnection}
            onLoadFailed={refresh}
          />
        </Suspense>
      ) : null}
    </>
  ) : null;

  return { model, dialogs };
}

export function googleDriveChip(
  state: GoogleDriveAccountState["state"],
  canRead: boolean,
  canWrite: boolean,
): IntegrationChip {
  if (!canRead) return { label: "Set up by an admin", tone: "plain" };
  switch (state) {
    case "unverified":
      return { label: "Loading", tone: "plain" };
    case "connected":
      return canWrite
        ? { label: "Connected", tone: "ok" }
        : { label: "Set up by an admin", tone: "plain" };
    case "not_connected":
    case "disconnected":
      return { label: "Not connected", tone: "idle" };
    default:
      return { label: "Needs attention", tone: "warn" };
  }
}

function googleDriveFailureMessage(reason: string | null): string {
  if (reason === "provider_denied") return "Google access was not approved.";
  if (reason === "scope_not_granted") return "Google Drive read access was not approved.";
  if (reason === "refresh_token_missing")
    return "Google did not return offline access. Reconnect and approve the consent prompt.";
  if (reason === "account_mismatch")
    return "Reconnect must use the same Google account. Disconnect first to switch accounts.";
  if (reason === "connection_conflict") return "The connection changed. Start again.";
  return "Check the local OAuth configuration and try again.";
}

function googleDriveStateNotice(
  state: GoogleDriveAccountState["state"],
): IntegrationViewModel["notice"] {
  if (state === "paused") {
    return {
      tone: "waiting",
      title: "Google Drive is paused",
      description:
        "OpenGeni will not browse or use the selected folders until you resume this connection.",
    };
  }
  if (state === "token_revoked") {
    return {
      tone: "failed",
      title: "Google no longer accepts this connection",
      description: "Reconnect with the same Google account to keep using the selected folders.",
    };
  }
  if (state === "app_removed") {
    return {
      tone: "failed",
      title: "The Google app is unavailable",
      description: "Ask an administrator to restore the app, then reconnect.",
    };
  }
  if (state === "reconnect_required") {
    return {
      tone: "failed",
      title: "Google Drive must be reconnected",
      description: "Reconnect with the same Google account to restore access to the folders.",
    };
  }
  if (state === "reconsent_required") {
    return {
      tone: "waiting",
      title: "Google Drive needs your approval again",
      description:
        "Reconnect with the same Google account and approve read access for the selected folders.",
    };
  }
  return undefined;
}
