import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  WorkspaceReachFields,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { administersOrganization } from "@opengeni/react/app/lib/workspaces";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { Notice } from "@opengeni/react/ui/notice";
import type { AccessContext, ClientConfig, ConnectionMetadata } from "@opengeni/react/app/types";
import { useOrganizationName } from "@/lib/use-organization-name";

/**
 * Who may share a workspace's Slack bot with other workspaces: an
 * organization owner or admin who also manages this workspace's
 * integrations, the same rule the server applies.
 */
export function canShareSlackBotWithOrganization(input: {
  accessContext: AccessContext;
  clientConfig: Pick<ClientConfig, "productAccessMode"> & {
    auth: Pick<ClientConfig["auth"], "mode">;
  };
  connection: Pick<ConnectionMetadata, "accountId" | "workspaceId">;
}): boolean {
  const { accessContext, connection } = input;
  return (
    administersOrganization({
      accessContext,
      clientConfig: input.clientConfig,
      accountId: connection.accountId,
    }) &&
    hasWorkspacePermission(accessContext, connection.workspaceId, "connections:write") &&
    hasWorkspacePermission(accessContext, connection.workspaceId, "capabilities:manage")
  );
}

/**
 * Where a workspace's Slack bot works in Opengeni. It belongs to the workspace
 * it was installed in and always works there; organization owners can let
 * other shared workspaces use it too. Never anyone's Personal workspace.
 */
export function SlackBotAccessSection({
  connection,
  onSaved,
}: {
  connection: ConnectionMetadata;
  onSaved: () => Promise<void>;
}) {
  const { client, accessContext, clientConfig, workspaces } = useAppContext();
  const [saved, setSaved] = useState<{ enabled: boolean; workspaceIds?: string[] | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<WorkspaceReach>({
    workspaceIds: [],
    personalWorkspaces: false,
  });
  const [revision, setRevision] = useState(0);
  const canManage = canShareSlackBotWithOrganization({ accessContext, clientConfig, connection });
  const choices = workspaces.filter(
    (workspace) => workspace.accountId === connection.accountId && workspace.kind !== "personal",
  );
  const name = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? "Another workspace";
  const organizationName =
    useOrganizationName(connection.accountId, canManage) ?? "your organization";
  useEffect(() => {
    let live = true;
    setSaved(null);
    setError(null);
    void client
      .getOpenGeniSlackBotOrganizationAccess(connection.workspaceId, connection.id)
      .then((result) => {
        if (live) setSaved(result);
      })
      .catch((failure) => {
        if (live) setError(userErrorText(failure));
      });
    return () => {
      live = false;
    };
  }, [client, connection.workspaceId, connection.id, revision]);
  const summary = !saved
    ? "Loading access…"
    : !saved.enabled
      ? name(connection.workspaceId)
      : saved.workspaceIds == null
        ? "All workspaces in this organization"
        : [...new Set([connection.workspaceId, ...saved.workspaceIds])].map(name).join(", ");
  async function save() {
    setBusy(true);
    try {
      const others = draft.workspaceIds?.filter((id) => id !== connection.workspaceId) ?? null;
      const result = await client.setOpenGeniSlackBotOrganizationAccess(
        connection.workspaceId,
        connection.id,
        {
          enabled: others === null || others.length > 0,
          workspaceIds: others,
        },
      );
      setSaved(result);
      setEditing(false);
      await onSaved();
    } catch (failure) {
      toast.error("Couldn't save bot access", { description: userErrorText(failure) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailSection
      title="Available in Opengeni"
      action={
        canManage && saved && !editing ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({
                workspaceIds: !saved.enabled ? [] : (saved.workspaceIds ?? null),
                personalWorkspaces: false,
              });
              setEditing(true);
            }}
          >
            Edit access
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <Notice
          tone="failed"
          action={
            <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      ) : (
        <p className="text-sm text-fg-muted">{summary}</p>
      )}
      {editing ? (
        <div className="mt-4 space-y-4">
          <WorkspaceReachFields
            owner={{
              kind: "workspace",
              id: connection.workspaceId,
              name: name(connection.workspaceId),
            }}
            organizationName={organizationName}
            managedBy="Only organization owners can change where it works."
            labelHidden
            value={draft}
            onChange={setDraft}
            workspaces={choices}
            personalWorkspaces="none"
            disabled={busy}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </DetailSection>
  );
}
