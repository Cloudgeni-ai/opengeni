import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ATLASSIAN_NATIVE_RETIRED_MESSAGE,
  ATLASSIAN_NATIVE_RETIRED_REASON,
} from "@opengeni/contracts/atlassian-native-retirement";
import { request as apiRequest } from "@/api";
import { userErrorText } from "@/lib/api-error";
import type { IntegrationChip, IntegrationViewModel } from "./integration-view-model";
import type { IntegrationAdapter } from "./use-api-integration-accounts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import {
  ATLASSIAN_APP_DESCRIPTION,
  atlassianConnectionMetadata,
  atlassianStatus,
  localConnectedAtlassianPreview,
  preferredAtlassianConnection,
} from "@/lib/atlassian-connection";
import { oauthCallbackReasonMessage } from "@/lib/oauth-callback-messages";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { ConnectionMetadata } from "@/types";

export const ATLASSIAN_LOGO_URL =
  "https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png";

/** Historical native sync accounts retain a removal surface; new connections use hosted MCP. */
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
  connectionsLoadFailed?: boolean;
  refresh: () => Promise<void>;
  replaceConnection: (connection: ConnectionMetadata) => void;
}): IntegrationAdapter & { hasHistoricalConnection: boolean } {
  const context = useAppContext();
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const canWrite = hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  const [busy, setBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const preview = useMemo(
    () => localConnectedAtlassianPreview(window.location.search, workspaceId),
    [workspaceId],
  );
  const connection =
    preview ??
    preferredAtlassianConnection(
      (connections ?? []).filter(
        (item) =>
          item.workspaceId === workspaceId && item.subjectId === context.accessContext.subjectId,
      ),
    );
  const metadata = connection ? atlassianConnectionMetadata(connection.metadata) : null;
  const status = atlassianStatus(connection, connectionsLoaded || preview !== null);
  const readOnly = preview !== null;
  const hasHistoricalConnection = Boolean(connection && connection.status !== "revoked");

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("atlassian");
    if (!result) return;
    toast.error("Previous Atlassian sync is retired", {
      description:
        result === "connected"
          ? ATLASSIAN_NATIVE_RETIRED_MESSAGE
          : atlassianFailureMessage(url.searchParams.get("reason")),
    });
    void refresh();
    url.searchParams.delete("atlassian");
    url.searchParams.delete("connectionId");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

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
      toast.success("Previous Atlassian sync disconnected");
      return true;
    } catch (error) {
      toast.error("Atlassian could not be disconnected", { description: userErrorText(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const model: IntegrationViewModel = {
    id: "atlassian",
    name: "Jira & Confluence",
    description: ATLASSIAN_APP_DESCRIPTION,
    mark: { logoSrc: ATLASSIAN_LOGO_URL, monogram: "A" },
    chip: atlassianChip(status, canRead, canWrite),
    connection:
      canRead && metadata
        ? [{ label: "Previous account", value: metadata.email ?? metadata.displayName }]
        : [],
    ...(canRead && metadata
      ? {
          access: {
            title: "Previous projects and spaces",
            items: metadata.selectedSources.map((source) => ({
              name: source.name,
              meta: source.key,
            })),
            emptyMessage: "No sources were selected.",
          },
        }
      : {}),
    options: [],
    footer:
      canRead && canWrite && hasHistoricalConnection
        ? {
            kind: "actions",
            secondary: {
              label: "Disconnect previous sync",
              onClick: () => setDisconnectOpen(true),
              disabled: readOnly || busy,
              destructive: true,
            },
            busy,
          }
        : { kind: "locked", message: ATLASSIAN_NATIVE_RETIRED_MESSAGE },
    notice:
      status === "loading" && connectionsLoadFailed
        ? {
            tone: "failed",
            title: "Previous connections could not be loaded",
            action: { label: "Retry", onClick: () => void refresh() },
          }
        : {
            tone: "muted",
            title: "Knowledge sync retired",
            description:
              "Native reading and scheduled sync have stopped. Imported documents and history remain. Connect Atlassian agent tools for live Jira and Confluence access.",
          },
  };
  return {
    model,
    hasHistoricalConnection,
    dialogs: canRead ? (
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect previous Atlassian sync?"
        description="Remove the previous connection's access. Its imported documents and history remain. Hosted Atlassian agent tools use a separate connection."
        confirmLabel="Disconnect previous sync"
        cancelAutoFocus
        onConfirm={disconnect}
      />
    ) : null,
  };
}

export function atlassianChip(
  status: ReturnType<typeof atlassianStatus>,
  canRead: boolean,
  _canWrite: boolean,
): IntegrationChip {
  if (!canRead) return { label: "Access restricted", tone: "plain" };
  if (status === "loading") return { label: "Loading", tone: "plain" };
  return { label: "Retired", tone: "plain" };
}

export function atlassianFailureMessage(reason: string | null): string {
  if (reason === ATLASSIAN_NATIVE_RETIRED_REASON) return ATLASSIAN_NATIVE_RETIRED_MESSAGE;
  if (reason === "provider_denied") return "Atlassian access was not approved.";
  if (reason === "scope_not_granted") return "The required read permissions were not approved.";
  if (reason === "no_accessible_sites")
    return "This account has no accessible Jira or Confluence sites.";
  if (reason === "account_mismatch") return "Reconnect with the same Atlassian account.";
  if (reason === "refresh_token_missing") return "Offline access was not granted.";
  return oauthCallbackReasonMessage(reason) ?? ATLASSIAN_NATIVE_RETIRED_MESSAGE;
}
