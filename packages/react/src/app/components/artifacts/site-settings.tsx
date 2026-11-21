// A Site's settings: where it is published, who in the workspace can see it,
// and the rarer actions (duplicate, export, allowed actions, archive). One
// panel, shown in the Site page's Settings tab and in the session workbench,
// so a Site is managed the same way from either place.
import type { WorkspaceArtifact } from "@opengeni/sdk";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleArrowUpIcon,
  CopyIcon,
  DownloadIcon,
  LockKeyholeIcon,
  RotateCcwIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "../../lib/toast";

import { useSiteAudience } from "./site-audience";
import { sitePublishFormProps } from "./site-publish-form-props";
import { PublishMore, SitePublishPage, useSitePublication } from "./site-publishing";
import { Button } from "../../../ui/button";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { SettingRow } from "../../../ui/setting-row";
import { useAppApi } from "../../lib/app-api";
import { notifySiteToolReadinessChanged } from "../../lib/console-site";
import { useExportApp, useUpgradeApp } from "./app-package";
import { useAppContext } from "../../app-context";
import { invalidateArtifactCatalog } from "../../lib/use-artifact-catalog";
import { isPersonalWorkspace } from "../../lib/managed-self-context";
import { hasWorkspacePermission } from "../../lib/permissions";
import { sitesClientConfig } from "../../lib/site-publishing";
import { useDuplicateSite } from "../../lib/use-duplicate-site";
import { userErrorText } from "../../../ui/api-error";

// Stands in for the Site while it loads so the audience hook keeps its order.
const PLACEHOLDER_SITE: WorkspaceArtifact = {
  id: "00000000-0000-4000-8000-000000000000",
  accountId: "00000000-0000-4000-8000-000000000000",
  workspaceId: "00000000-0000-4000-8000-000000000000",
  slug: "loading",
  title: "App",
  description: null,
  status: "active",
  currentVersion: null,
  createdBySubjectId: "loading",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/**
 * What a person may do with a Site and the controls for it: its publication,
 * its audience and archiving. The Site page and the workbench share it.
 */
export function useSiteManagement({
  workspaceId,
  siteId,
  artifact,
  onArtifactChanged,
  onStatusChanged,
}: {
  workspaceId: string;
  siteId: string;
  /** null while the Site loads. */
  artifact: WorkspaceArtifact | null;
  onArtifactChanged: (artifact: WorkspaceArtifact) => void;
  /** After archiving or restoring, to read the Site again. */
  onStatusChanged: () => Promise<void> | void;
}) {
  const context = useAppContext();
  const { client, accessContext } = context;
  const canPublish = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  // Sites are shared work: anyone here who can publish artifacts manages the
  // Sites they can see (Data and publication), like the owner. The API decides.
  const manageData = Boolean(canPublish && artifact);
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  // Site administration (limits, outside-visitor agent, extra tools): a
  // workspace admin, or the owner of a Personal workspace.
  const isAdmin =
    hasWorkspacePermission(accessContext, workspaceId, "workspace:admin") ||
    isPersonalWorkspace(workspace, context.managedSelfContext);
  const workspaceName = workspace?.name ?? "this workspace";
  const publication = useSitePublication({ client, workspaceId, siteId, enabled: manageData });
  const audience = useSiteAudience({
    client,
    workspaceId,
    workspaceName,
    artifact: artifact ?? PLACEHOLDER_SITE,
    ownedByCurrentUser: Boolean(
      canPublish && artifact?.ownerSubjectId && artifact.ownerSubjectId === accessContext.subjectId,
    ),
    onChanged: (next) => {
      onArtifactChanged(next);
      invalidateArtifactCatalog(client, workspaceId);
    },
  });
  const [statusBusy, setStatusBusy] = useState(false);
  const setSiteStatus = async (status: "active" | "archived") => {
    if (!canPublish) return false;
    const currentVersion = artifact?.currentVersion;
    if (!artifact || !currentVersion || artifact.status === status) return true;
    setStatusBusy(true);
    try {
      await client.setWorkspaceArtifactStatus(workspaceId, siteId, {
        status,
        expectedCurrentVersionId: currentVersion.id,
        reason: `${status === "archived" ? "Archived" : "Restored"} from apps by ${context.authSession?.user?.name ?? "a workspace member"}`,
        idempotencyKey: crypto.randomUUID(),
      });
      invalidateArtifactCatalog(client, workspaceId);
      toast.success(status === "archived" ? "App archived" : "App restored");
      await onStatusChanged();
      return true;
    } catch (error) {
      toast.error(status === "archived" ? "Couldn't archive app" : "Couldn't restore app", {
        description: userErrorText(error),
      });
      return false;
    } finally {
      setStatusBusy(false);
    }
  };
  return {
    canPublish,
    isAdmin,
    manageData,
    workspaceName,
    publication,
    audience,
    statusBusy,
    setSiteStatus,
  };
}

export type SiteManagement = ReturnType<typeof useSiteManagement>;

/**
 * Forget this person's "Always allow" choices on this Site: its next actions
 * ask again. Open frames hear it as a readiness change.
 */
function useResetSiteToolAllowances(
  workspaceId: string,
  siteId: string,
  versionId: string | null,
): { busy: boolean; run: () => void } | null {
  const api = useAppApi();
  const [busy, setBusy] = useState(false);
  const run = useCallback(() => {
    if (!versionId) return;
    setBusy(true);
    api
      .request<{ version: 1; removed: number }>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/tools/site-allowances/reset`,
        {
          method: "POST",
          body: JSON.stringify({
            siteArtifactId: siteId,
            siteVersionId: versionId,
          }),
        },
      )
      .then(
        () => {
          notifySiteToolReadinessChanged(siteId);
          toast.success("Allowed actions reset");
        },
        (error: unknown) =>
          toast.error("Couldn't reset allowed actions", {
            description: userErrorText(error),
          }),
      )
      .finally(() => setBusy(false));
  }, [api, siteId, versionId, workspaceId]);
  return versionId ? { busy, run } : null;
}

/**
 * The Site's settings, one row style: its web address (the publish form, on
 * the page without a box of its own), who in the workspace can see it, and
 * a collapsed More with the rare and the dangerous ones (search engines,
 * reports and takedown, duplicate, export, allowed actions, archive).
 * The audience dialog is the caller's, as it is shared with the page header.
 */
export function SiteSettings({
  workspaceId,
  artifact,
  management,
  openCopy = true,
}: {
  workspaceId: string;
  artifact: WorkspaceArtifact;
  management: SiteManagement;
  /** Whether a duplicate opens on its own page; the workbench keeps the person in the session. */
  openCopy?: boolean | undefined;
}) {
  const { client, clientConfig, accessContext } = useAppContext();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const copies = useDuplicateSite(workspaceId);
  const exportApp = useExportApp(workspaceId);
  const upgradeApp = useUpgradeApp(workspaceId, artifact.id);
  const resetAllowed = useResetSiteToolAllowances(
    workspaceId,
    artifact.id,
    artifact.currentVersion?.id ?? null,
  );
  const { publication, audience } = management;
  const archived = artifact.status === "archived";
  const owner = Boolean(
    artifact.ownerSubjectId && artifact.ownerSubjectId === accessContext.subjectId,
  );
  const publishing =
    management.manageData &&
    publication.load.state !== "unavailable" &&
    publication.load.state !== "forbidden";
  const onlyMe = artifact.visibility === "private";
  const hasVersion = Boolean(artifact.currentVersion);
  const restoreButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={management.statusBusy}
      onClick={() => void management.setSiteStatus("active")}
    >
      <ArchiveRestoreIcon aria-hidden="true" />
      {management.statusBusy ? "Restoring…" : "Restore"}
    </Button>
  );
  const canDuplicate = management.canPublish && hasVersion;
  const canExport = canDuplicate && exportApp !== null;
  const canUpgrade = canDuplicate && upgradeApp !== null && !archived;
  const canReset = resetAllowed !== null && !archived;
  // Rarely used, so collapsed under More; a lone row shows as it is.
  const moreCount = [
    canDuplicate,
    canExport,
    canUpgrade,
    canReset,
    management.canPublish && !archived,
  ].filter(Boolean).length;
  const moreRows = (
    <>
      {canDuplicate ? (
        <SettingRow
          label="Duplicate"
          description="A new app from this version, owned by you. Its address, data and history aren't copied."
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={copies.busy}
              onClick={() => void copies.duplicate(artifact, { open: openCopy })}
            >
              <CopyIcon aria-hidden="true" />
              {copies.busy ? "Duplicating…" : "Duplicate"}
            </Button>
          }
        />
      ) : null}
      {canExport && exportApp ? (
        <SettingRow
          label="Export"
          description="Download the app as a package."
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={exportApp.busy}
              onClick={() => void exportApp.run(artifact.id)}
            >
              <DownloadIcon aria-hidden="true" />
              Export
            </Button>
          }
        />
      ) : null}
      {canUpgrade && upgradeApp ? (
        <SettingRow
          label="Upgrade"
          description="Update it from a newer package."
          control={
            <Button type="button" size="sm" variant="outline" onClick={upgradeApp.open}>
              <CircleArrowUpIcon aria-hidden="true" />
              Upgrade
            </Button>
          }
        />
      ) : null}
      {canReset && resetAllowed ? (
        <SettingRow
          label="Allowed actions"
          description="Actions you always allowed ask again."
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={resetAllowed.busy}
              onClick={resetAllowed.run}
            >
              <RotateCcwIcon aria-hidden="true" />
              Reset
            </Button>
          }
        />
      ) : null}
      {management.canPublish && !archived ? (
        <SettingRow
          label="Archive"
          description="Unpublishes it. You can restore it."
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={management.statusBusy || !hasVersion}
              onClick={() => setArchiveOpen(true)}
            >
              <ArchiveIcon aria-hidden="true" />
              Archive
            </Button>
          }
        />
      ) : null}
    </>
  );
  const workspaceAccess = (
    <SettingRow
      label="Workspace access"
      description={
        onlyMe ? "Only you can open it." : `Everyone in ${management.workspaceName} can open it.`
      }
      hint={owner ? undefined : "Only its owner can change this."}
      control={
        audience.share ? (
          <Button type="button" size="sm" variant="outline" onClick={audience.share}>
            <UsersIcon aria-hidden="true" />
            Share with workspace
          </Button>
        ) : audience.limit ? (
          <Button type="button" size="sm" variant="outline" onClick={audience.limit}>
            <LockKeyholeIcon aria-hidden="true" />
            Limit to me
          </Button>
        ) : undefined
      }
    />
  );
  // The publish form (with its own Save), then the app's rows, which act at
  // once.
  const formShown = publishing && !archived;
  return (
    <div className="flex min-w-0 max-w-[560px] flex-col gap-6" data-site-settings="">
      {management.canPublish && archived ? (
        <SettingRow
          label="Restore"
          description="Bring it back to edit or publish it."
          control={restoreButton}
        />
      ) : null}
      {formShown ? (
        <SitePublishPage
          {...sitePublishFormProps(management, {
            client,
            workspaceId,
            site: artifact,
            sites: sitesClientConfig(clientConfig),
          })}
          layout="panel"
          onPublication={publication.setPublication}
          onBack={() => undefined}
          canManage
        />
      ) : null}
      {workspaceAccess}
      {moreCount > 1 ? <PublishMore>{moreRows}</PublishMore> : moreRows}
      {upgradeApp?.element}
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive “${artifact.title}”?`}
        description="The app will be unpublished, but its source and complete version history will remain recoverable."
        confirmLabel="Archive app"
        cancelAutoFocus
        onConfirm={() => management.setSiteStatus("archived")}
      />
    </div>
  );
}
