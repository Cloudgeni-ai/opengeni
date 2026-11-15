import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  WorkspaceReachFields,
  type ReachPersonalWorkspaces,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { administersOrganization } from "@opengeni/react/app/lib/workspaces";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { Notice } from "@opengeni/react/ui/notice";
import type { AccessContext, ClientConfig } from "@opengeni/react/app/types";
import { useOrganizationName } from "@/lib/use-organization-name";

/**
 * Who may change where a workspace's chat bot (Slack or Teams) works in the
 * organization: an organization owner or admin who also manages this
 * workspace's integrations, the same rule the server applies.
 */
export function canManageIntegrationReach(input: {
  accessContext: AccessContext;
  clientConfig: Pick<ClientConfig, "productAccessMode"> & {
    auth: Pick<ClientConfig["auth"], "mode">;
  };
  accountId: string;
  workspaceId: string;
}): boolean {
  const { accessContext, workspaceId } = input;
  return (
    administersOrganization({
      accessContext,
      clientConfig: input.clientConfig,
      accountId: input.accountId,
    }) &&
    hasWorkspacePermission(accessContext, workspaceId, "connections:write") &&
    hasWorkspacePermission(accessContext, workspaceId, "capabilities:manage")
  );
}

/**
 * Where a workspace's chat bot works in Opengeni: the workspace it was
 * connected in always, plus every workspace of the organization or selected
 * ones. `load` and `save` speak the shared reach shape; the caller adapts it
 * to its integration's storage. `workspaceIds: []` means only the owner.
 */
export function IntegrationReachSection({
  accountId,
  workspaceId,
  personalWorkspaces,
  load,
  save,
  onSaved,
  reloadKey,
}: {
  accountId: string;
  workspaceId: string;
  /** Whether members' Personal workspaces can be included ("choice") or never are ("none"). */
  personalWorkspaces: Exclude<ReachPersonalWorkspaces, "always">;
  load: () => Promise<WorkspaceReach>;
  save: (next: WorkspaceReach) => Promise<WorkspaceReach>;
  onSaved?: () => Promise<void>;
  /** Changes when the integration changes, so the saved reach is read again. */
  reloadKey: string;
}) {
  const { accessContext, clientConfig, workspaces } = useAppContext();
  const [saved, setSaved] = useState<WorkspaceReach | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<WorkspaceReach>({
    workspaceIds: [],
    personalWorkspaces: false,
  });
  const [revision, setRevision] = useState(0);
  const canManage = canManageIntegrationReach({
    accessContext,
    clientConfig,
    accountId,
    workspaceId,
  });
  const choices = workspaces.filter(
    (workspace) => workspace.accountId === accountId && workspace.kind !== "personal",
  );
  const name = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? "Another workspace";
  const organizationName = useOrganizationName(accountId, canManage) ?? "your organization";
  useEffect(() => {
    let live = true;
    setSaved(null);
    setError(null);
    void load()
      .then((result) => {
        if (live) setSaved(result);
      })
      .catch((failure) => {
        if (live) setError(userErrorText(failure));
      });
    return () => {
      live = false;
    };
    // `load` belongs to `reloadKey`; a new closure alone doesn't reload.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, revision]);
  const personal =
    personalWorkspaces === "choice" && saved?.personalWorkspaces
      ? " and members' Personal workspaces"
      : "";
  const summary = !saved
    ? "Loading access…"
    : saved.workspaceIds == null
      ? `All workspaces in this organization${personal}`
      : `${[...new Set([workspaceId, ...saved.workspaceIds])].map(name).join(", ")}${personal}`;
  async function submit() {
    setBusy(true);
    try {
      const others = draft.workspaceIds?.filter((id) => id !== workspaceId) ?? null;
      setSaved(
        await save({
          workspaceIds: others,
          personalWorkspaces: personalWorkspaces === "choice" && draft.personalWorkspaces,
        }),
      );
      setEditing(false);
      await onSaved?.();
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
              setDraft(saved);
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
            owner={{ kind: "workspace", id: workspaceId, name: name(workspaceId) }}
            organizationName={organizationName}
            managedBy="Only organization owners can change where it works."
            labelHidden
            value={draft}
            onChange={setDraft}
            workspaces={choices}
            personalWorkspaces={personalWorkspaces}
            disabled={busy}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void submit()}>
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
