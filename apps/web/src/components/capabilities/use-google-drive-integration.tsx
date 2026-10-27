import googleDriveLogo from "@/assets/integration-logos/google-drive.png";
import { oauthCallbackReasonMessage } from "@opengeni/react/app/lib/oauth-callback-messages";
import { useState } from "react";
import { toast } from "sonner";
import { GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE } from "@opengeni/contracts/google-drive-native-retirement";
import { useAppContext } from "@opengeni/react/app/app-context";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import type { ConnectionMetadata } from "@opengeni/react/app/types";
import type { IntegrationAdapter } from "./use-api-integration-accounts";
import { request as apiRequest } from "@/api";

export const GOOGLE_DRIVE_LOGO_URL = googleDriveLogo;

/** Historical account removal only. Google Drive MCP uses ordinary connector setup. */
export function useGoogleDriveIntegration({
  workspaceId,
  connections,
  refresh,
  replaceConnection,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[] | null;
  refresh: () => Promise<void>;
  replaceConnection: (connection: ConnectionMetadata) => void;
}): IntegrationAdapter & { hasHistoricalConnection: boolean } {
  const context = useAppContext();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const connection = connections?.find(
    (item) =>
      item.workspaceId === workspaceId &&
      item.subjectId === context.accessContext.subjectId &&
      item.providerDomain === "googleapis.com" &&
      item.status !== "revoked",
  );
  const canWrite = hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  async function disconnect() {
    if (!connection || !canWrite) return false;
    setBusy(true);
    try {
      const result = await apiRequest<{ connection: ConnectionMetadata }>(
        `/v1/workspaces/${workspaceId}/connections/${connection.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            expectedVersion: connection.version,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      replaceConnection(result.connection);
      await refresh();
      return true;
    } catch (error) {
      toast.error("Could not disconnect previous Drive sync", {
        description: userErrorText(error),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    hasHistoricalConnection: Boolean(connection),
    model: {
      id: "google-drive",
      name: "Previous Google Drive connection",
      description: "Previous source sync and publishing setup.",
      mark: { logoSrc: GOOGLE_DRIVE_LOGO_URL, monogram: "D" },
      chip: { label: "Retired", tone: "plain" },
      connection: [],
      options: [],
      notice: {
        tone: "muted",
        title: "Connect Google Drive MCP to continue",
        description: GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE,
      },
      footer:
        canWrite && connection
          ? {
              kind: "actions",
              secondary: {
                label: "Disconnect previous connection",
                onClick: () => setOpen(true),
                destructive: true,
                disabled: busy,
              },
              busy,
            }
          : { kind: "locked", message: GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE },
    },
    dialogs: (
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Disconnect previous Drive connection?"
        description="Imported documents and run history remain. Your new Google Drive MCP connection is separate."
        confirmLabel="Disconnect"
        cancelAutoFocus
        onConfirm={disconnect}
      />
    ),
  };
}

export function googleDriveFailureMessage(reason: string | null): string {
  return oauthCallbackReasonMessage(reason) ?? GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE;
}
