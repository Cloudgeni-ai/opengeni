import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@/context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { userErrorText } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { CheckboxField } from "@/components/ui/field";
import { SelectMenu } from "@/components/ui/select-menu";
import { Notice } from "@/components/ui/notice";
import type { ConnectionMetadata } from "@/types";

export function SlackBotAccessSection({
  connection,
  onSaved,
}: {
  connection: ConnectionMetadata;
  onSaved: () => Promise<void>;
}) {
  const { client, accessContext, workspaces } = useAppContext();
  const [saved, setSaved] = useState<{ enabled: boolean; workspaceIds?: string[] | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("home");
  const [ids, setIds] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const canManage =
    hasAccountPermission(accessContext, connection.accountId, "account:admin") &&
    hasWorkspacePermission(accessContext, connection.workspaceId, "connections:write");
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
