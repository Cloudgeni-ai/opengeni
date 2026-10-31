import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@opengeni/react/app/app-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { administersOrganization } from "@opengeni/react/app/lib/workspaces";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { CheckboxField } from "@opengeni/react/ui/field";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { Notice } from "@opengeni/react/ui/notice";
import type { AccessContext, ClientConfig, ConnectionMetadata } from "@opengeni/react/app/types";

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
  const [mode, setMode] = useState("home");
  const [ids, setIds] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const canManage = canShareSlackBotWithOrganization({ accessContext, clientConfig, connection });
  const choices = workspaces.filter((workspace) => workspace.accountId === connection.accountId);
  const name = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? "Another workspace";
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
      const result = await client.setOpenGeniSlackBotOrganizationAccess(
        connection.workspaceId,
        connection.id,
        {
          enabled: mode !== "home",
          workspaceIds: mode === "selected" ? ids : null,
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
              setMode(!saved.enabled ? "home" : saved.workspaceIds == null ? "all" : "selected");
              setIds(saved.workspaceIds ?? []);
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
          <SelectMenu
            aria-label="Bot workspace access"
            value={mode}
            onValueChange={setMode}
            disabled={busy}
            options={[
              { value: "home", label: name(connection.workspaceId) },
              { value: "all", label: "All workspaces" },
              { value: "selected", label: "Selected workspaces" },
            ]}
          />
          {mode === "selected" ? (
            <div className="space-y-2">
              {choices.map((workspace) => (
                <CheckboxField
                  key={workspace.id}
                  label={workspace.name}
                  checked={workspace.id === connection.workspaceId || ids.includes(workspace.id)}
                  disabled={busy || workspace.id === connection.workspaceId}
                  onCheckedChange={(checked) =>
                    setIds(
                      checked ? [...ids, workspace.id] : ids.filter((id) => id !== workspace.id),
                    )
                  }
                />
              ))}
            </div>
          ) : null}
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
