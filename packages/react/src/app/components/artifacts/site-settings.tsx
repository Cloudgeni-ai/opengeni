// A Site's settings: where it is published, who in the workspace can see it,
// and archiving. One panel, shown in the Site page's Settings tab and in the
// session workbench, so a Site is managed the same way from either place.
import type { WorkspaceArtifact } from "@opengeni/sdk";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CopyIcon,
  LockKeyholeIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "../../lib/toast";

import { useSiteAudience } from "./site-audience";
import { SitePublishPage, useSitePublication } from "./site-publishing";
import { Button } from "../../../ui/button";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Notice } from "../../../ui/notice";
import { Section, SectionStack } from "../../../ui/section";
import { SettingRow, SettingRowGroup } from "../../../ui/setting-row";
import { useAppContext } from "../../app-context";
import { invalidateArtifactCatalog } from "../../lib/use-artifact-catalog";
import { isPersonalWorkspace } from "../../lib/managed-self-context";
import { hasWorkspacePermission } from "../../lib/permissions";
import { sitesClientConfig } from "../../lib/site-publishing";
import { useDuplicateSite } from "../../lib/use-duplicate-site";

// Stands in for the Site while it loads so the audience hook keeps its order.
const PLACEHOLDER_SITE: WorkspaceArtifact = {
  id: "00000000-0000-4000-8000-000000000000",
  accountId: "00000000-0000-4000-8000-000000000000",
  workspaceId: "00000000-0000-4000-8000-000000000000",
  slug: "loading",
  title: "Site",
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
  // A Personal workspace has nobody to share with, so there is no audience.
  const showAudience = !isPersonalWorkspace(workspace, context.managedSelfContext);
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
        reason: `${status === "archived" ? "Archived" : "Restored"} from Sites by ${context.authSession?.user?.name ?? "a workspace member"}`,
        idempotencyKey: crypto.randomUUID(),
      });
      invalidateArtifactCatalog(client, workspaceId);
      toast.success(status === "archived" ? "Site archived" : "Site restored");
      await onStatusChanged();
      return true;
    } catch (error) {
      toast.error(status === "archived" ? "Couldn't archive Site" : "Couldn't restore Site", {
        description: error instanceof Error ? error.message : String(error),
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
    showAudience,
    publication,
    audience,
    statusBusy,
    setSiteStatus,
  };
}

export type SiteManagement = ReturnType<typeof useSiteManagement>;

/** Whether a Site has anything in Settings for this person. */
export function hasSiteSettings(management: SiteManagement): boolean {
  return management.canPublish;
}

/**
 * The Site's settings: Publish to web (its address, who can open it, its
 * agent and limits), who in the workspace can see it, and archiving.
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
  return (
    <SectionStack divided={false}>
      {publishing ? (
        archived ? (
          <Section title="Publish to web">
            <Notice
              icon={<ArchiveIcon className="size-4" />}
              title="Archived Sites aren't on the web"
            >
              Restore the Site to publish it again.
            </Notice>
          </Section>
        ) : (
          <SitePublishPage
            layout="panel"
            client={client}
            workspaceId={workspaceId}
            workspaceName={management.workspaceName}
            site={artifact}
            load={publication.load}
            onPublication={publication.setPublication}
            onReload={() => void publication.reload()}
            onBack={() => undefined}
            canManage
            isAdmin={management.isAdmin}
            onShareWithWorkspace={management.showAudience ? audience.share : undefined}
            personalWorkspace={!management.showAudience}
            sites={sitesClientConfig(clientConfig)}
          />
        )
      ) : null}
      {management.showAudience ? (
        <Section title="Workspace access" variant="group">
          <SettingRowGroup>
            <SettingRow
              label={onlyMe ? "Only me" : "Workspace"}
              description={
                onlyMe
                  ? "Only you can see and open this Site."
                  : `Everyone in ${management.workspaceName} can see and open this Site.`
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
          </SettingRowGroup>
        </Section>
      ) : null}
      {management.canPublish && artifact.currentVersion ? (
        <Section title="Duplicate" variant="group">
          <SettingRowGroup>
            <SettingRow
              label="Duplicate Site"
              description="Makes a new Site from this version, owned by you. Its web address, data and history aren't copied."
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
          </SettingRowGroup>
        </Section>
      ) : null}
      {management.canPublish ? (
        <Section title="Archive" variant="group">
          <SettingRowGroup>
            <SettingRow
              label={archived ? "Restore Site" : "Archive Site"}
              description={
                archived
                  ? "Bring the Site back to edit it or restore an earlier version."
                  : "Unpublishes the Site. Its source and versions are kept, and you can restore it."
              }
              control={
                archived ? (
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
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={management.statusBusy || !artifact.currentVersion}
                    onClick={() => setArchiveOpen(true)}
                  >
                    <ArchiveIcon aria-hidden="true" />
                    Archive
                  </Button>
                )
              }
            />
          </SettingRowGroup>
        </Section>
      ) : null}
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive “${artifact.title}”?`}
        description="The Site will be unpublished, but its source and complete version history will remain recoverable."
        confirmLabel="Archive Site"
        cancelAutoFocus
        onConfirm={() => management.setSiteStatus("archived")}
      />
    </SectionStack>
  );
}
