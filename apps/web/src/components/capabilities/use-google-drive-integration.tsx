import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
  IntegrationAccessItem,
  IntegrationChip,
  IntegrationFooter,
  IntegrationOption,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import {
  useApiIntegrationAccounts,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import {
  GOOGLE_DRIVE_ACCESS_DISCLOSURE,
  GOOGLE_DRIVE_APP_DESCRIPTION,
  GOOGLE_DRIVE_PUBLISHING_DISCLOSURE,
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
  ApiIntegrationInstallationSummary,
  ConnectionMetadata,
  GoogleDriveLifecycleActionRequest,
  GoogleDriveOAuthStartResponse,
  IntegrationDefinitionSummary,
} from "@/types";

// The folder picker (Drive browsing, paging, and the save form) is only needed
// once an admin edits folders; keep it behind its own lazy boundary.
const GoogleDriveFolderDialog = lazy(async () => {
  const module = await import("@/components/capabilities/google-drive-folder-dialog");
  return { default: module.GoogleDriveFolderDialog };
});

export const GOOGLE_DRIVE_LOGO_URL =
  "https://www.gstatic.com/images/branding/productlogos/drive_2026/v2/web-64dp/logo_drive_2026_color_2x_web_64dp.png";

/**
 * The curated `google-drive` ApiIntegration definition id: extra Drive
 * accounts beyond the primary knowledge connection use this same multi-account
 * mechanism as Outlook/OneDrive, folded into this one row instead of a
 * separate row per account.
 */
export const GOOGLE_DRIVE_DEFINITION_ID = "google-drive";

/** Maps the Google Drive knowledge connection onto the shared integration view-model. */
export function useGoogleDriveIntegration({
  workspaceId,
  connections,
  connectionsLoaded,
  connectionsLoadFailed = false,
  refresh,
  replaceConnection,
  definitions = [],
  instances = [],
  onRuntimeChanged,
  refreshRevision,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  connectionsLoaded: boolean;
  /** True when the connection list failed to load (so the state is unknown, not empty). */
  connectionsLoadFailed?: boolean;
  refresh: () => Promise<void>;
  replaceConnection: (connection: ConnectionMetadata) => void;
  /** The curated ApiIntegration catalog, for extra (non-primary) Drive accounts. */
  definitions?: IntegrationDefinitionSummary[];
  instances?: ApiIntegrationInstallationSummary[];
  onRuntimeChanged?: () => void;
  refreshRevision?: number;
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
    "capabilities:manage",
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

  // Extra Drive accounts beyond the primary knowledge connection, folded into
  // this one row instead of a separate row per account.
  const extraAccounts = useApiIntegrationAccounts({
    workspaceId,
    definitionId: GOOGLE_DRIVE_DEFINITION_ID,
    definitions,
    instances,
    canManage: canWrite,
    refresh,
    ...(onRuntimeChanged ? { onRuntimeChanged } : {}),
    ...(refreshRevision !== undefined ? { refreshRevision } : {}),
  });

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
      setFolderDialogOpen(false);
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
      setFolderDialogOpen(false);
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

  // The source-save API applies one cadence/destination/read-policy set to every
  // source in the request, so a blanket toggle can only be written losslessly
  // when the saved sources already agree on those settings.
  const savedSettingsUniform = savedSources.every(
    (source) =>
      source.syncCadence === savedDefaults?.syncCadence &&
      source.readPolicy === savedDefaults?.readPolicy &&
      source.authorityKind === savedDefaults?.authorityKind,
  );

  async function setSyncEnabled(enabled: boolean) {
    if (!connection || !savedDefaults || !canWrite) return;
    if (!savedSettingsUniform) {
      // Never silently flatten per-source settings; route through the folder
      // dialog where the settings being written are visible and confirmed.
      toast.error("These folders have different sync settings", {
        description: "Use Change folders to review them before turning sync on or off.",
      });
      if (canReadSources) setFolderDialogOpen(true);
      return;
    }
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

  // A failed connection-list load means the state is unknown, not "still
  // loading": say so, offer a retry, and keep the Connect affordance usable.
  const loadFailed = accountState.state === "unverified" && connectionsLoadFailed;
  const primaryChip: IntegrationChip =
    canRead && loadFailed
      ? { label: "Needs attention", tone: "warn" }
      : googleDriveChip(accountState.state, canRead, canWrite);
  // One row, every Drive account. A healthy primary connection must never roll
  // an extra account that needs reauth up into a green "Connected".
  const chip: IntegrationChip =
    canRead && extraAccounts.needsAttention
      ? { label: "Needs attention", tone: "warn" }
      : primaryChip;
  const stateNotice: IntegrationViewModel["notice"] = loadFailed
    ? {
        tone: "failed",
        title: "Connections could not be loaded",
        description: "The Google Drive status is unknown until the connection list loads.",
        action: { label: "Retry", onClick: () => void refresh() },
      }
    : googleDriveStateNotice(accountState.state);
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
      disclosureId: "google-drive-publishing",
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
      ? loadFailed && canWrite
        ? {
            kind: "setup",
            onSetup: () => void connect(),
            busy,
            disclosureId: "google-drive-access",
          }
        : { kind: "setup", onSetup: () => {}, disabled: true }
      : !connected
        ? canWrite
          ? {
              kind: "setup",
              onSetup: () => void connect(),
              disabled: readOnly,
              busy,
              disclosureId: "google-drive-access",
            }
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
              disclosureId: "google-drive-access",
            }
          : { kind: "locked" };

  // The primary knowledge connection as one account entry, used only when extra
  // accounts turn the Access block account-scoped. Its folders remain visible as
  // sub-entries so the folder list never vanishes just because a second Drive
  // account exists.
  const folderAction = canReadSources
    ? { label: "Change folders", onClick: () => setFolderDialogOpen(true) }
    : {
        label: "Allow folder access",
        onClick: () => void connect(true, "source_read"),
        // Google limited-use disclosure: this action asks Google for more access.
        disclosureId: "google-drive-access",
      };
  const primaryAccessItems: IntegrationAccessItem[] =
    connected && metadata
      ? [
          {
            id: connection?.id ?? "google-drive-primary",
            name: metadata.googleDisplayName
              ? `${metadata.googleDisplayName} (${metadata.googleEmail})`
              : metadata.googleEmail,
            meta: "Primary",
            status:
              accountState.state === "connected" || accountState.state === "paused"
                ? ("ok" as const)
                : ("warn" as const),
            subItems: savedSources.map((source) => ({
              name: googleDriveBoundaryLabel(source),
              meta: source.syncEnabled ? "syncing" : "on request",
            })),
            subItemsEmptyMessage:
              "No folders selected yet. Agents cannot read Drive until you choose some.",
            ...(canChange ? { actions: [{ ...folderAction, disabled: busy }] } : {}),
          },
        ]
      : [];

  const model: IntegrationViewModel = {
    id: "google-drive",
    name: "Google Drive",
    description: GOOGLE_DRIVE_APP_DESCRIPTION,
    mark: { logoSrc: GOOGLE_DRIVE_LOGO_URL, monogram: "D" },
    chip,
    connection: facts,
    ...(canRead && (connected || extraAccounts.accounts.length > 0)
      ? {
          access:
            extraAccounts.accounts.length > 0
              ? {
                  // At least one extra account: the block becomes account-scoped.
                  // The primary account keeps its "Change folders" action inline
                  // on its own row, and the folders it contributes stay visible
                  // as its sub-entries instead of disappearing with the block.
                  title: "Connected accounts",
                  items: [...primaryAccessItems, ...extraAccounts.accessItems],
                  ...(canChange
                    ? {
                        editLabel: "+ Add account",
                        onEdit: extraAccounts.addAccount,
                        editDisabled: extraAccounts.busy,
                        editDisclosureId: "google-drive-access",
                      }
                    : {}),
                }
              : {
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
                        ...(canReadSources ? {} : { editDisclosureId: "google-drive-access" }),
                      }
                    : {}),
                },
        }
      : {}),
    options,
    footer,
    ...(stateNotice ? { notice: stateNotice } : {}),
    ...(extraAccounts.tools.length > 0 ? { tools: { tools: extraAccounts.tools } } : {}),
    // Google OAuth limited-use disclosures: rendered with every state so the
    // connect and publish affordances can point at them via aria-describedby.
    disclosures: [
      { id: "google-drive-access", text: GOOGLE_DRIVE_ACCESS_DISCLOSURE },
      { id: "google-drive-publishing", text: GOOGLE_DRIVE_PUBLISHING_DISCLOSURE },
    ],
  };

  const dialogs = canRead ? (
    <>
      {extraAccounts.dialogs}
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
        <Suspense
          fallback={
            <Skeleton className="fixed left-1/2 top-1/2 z-50 h-72 w-[min(90vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl" />
          }
        >
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
