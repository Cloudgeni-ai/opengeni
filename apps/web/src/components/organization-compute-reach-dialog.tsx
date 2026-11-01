import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { OrganizationComputeReach } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  WorkspaceReachFields,
  workspaceReachSummary,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";
import { FieldStack } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { Notice } from "@opengeni/react/ui/notice";
import { userErrorText } from "@opengeni/react/ui/api-error";

import { useOrganizationWorkspaces } from "@/components/models/connect-audience";

/* ----------------------------------------------------------------------------
   "Available in" for an organization machine or Sandbox Environment: every
   shared workspace of the organization or the ones picked, and members'
   Personal workspaces when switched on. The workspace it was connected from
   or made in always has it, because that is where it lives. The organization
   owner or an admin decides this. Chats and schedules in a workspace taken off
   the list stop using it at their next turn, so the dialog says so before
   saving.
   -------------------------------------------------------------------------- */

export type OrganizationComputeKind = "machine" | "rig";

const HOME_REASON: Record<OrganizationComputeKind, string> = {
  machine: "It was connected from this workspace, so it always works there.",
  rig: "It was made in this workspace, so it always works there.",
};

export function reachDraft(reach: OrganizationComputeReach): WorkspaceReach {
  return {
    workspaceIds: reach.allowedWorkspaceIds,
    personalWorkspaces: reach.allowPersonalWorkspaces,
  };
}

/** "All workspaces + Personal", "2 workspaces": the row value on the detail page. */
export function organizationComputeReachSummary(reach: OrganizationComputeReach): string {
  return workspaceReachSummary(reachDraft(reach), {
    owner: "organization",
    personalWorkspaces: "choice",
    alwaysIncluded: [reach.homeWorkspaceId],
  });
}

/** Whether saving `next` takes it away from somewhere it works now. */
export function reachNarrows(current: OrganizationComputeReach, next: WorkspaceReach): boolean {
  if (current.allowPersonalWorkspaces && !next.personalWorkspaces) return true;
  if (next.workspaceIds === null) return false;
  if (current.allowedWorkspaceIds === null) return true;
  const kept = new Set([...next.workspaceIds, current.homeWorkspaceId]);
  return current.allowedWorkspaceIds.some((workspaceId) => !kept.has(workspaceId));
}

export function OrganizationComputeReachDialog({
  open,
  onOpenChange,
  client,
  kind,
  name,
  reach,
  organizationId,
  organizationName,
  hereId,
  save,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: OpenGeniBrowserClient;
  kind: OrganizationComputeKind;
  name: string;
  reach: OrganizationComputeReach;
  organizationId: string;
  organizationName: string;
  /** The workspace the page is open in. */
  hereId: string;
  save: (next: {
    allowedWorkspaceIds: string[] | null;
    allowPersonalWorkspaces: boolean;
  }) => Promise<OrganizationComputeReach>;
  onSaved?: ((reach: OrganizationComputeReach) => void) | undefined;
}) {
  const [draft, setDraft] = useState<WorkspaceReach>(() => reachDraft(reach));
  const [error, setError] = useState<unknown>(null);
  const organization = useOrganizationWorkspaces(client, organizationId, open);
  useEffect(() => {
    if (open) {
      setDraft(reachDraft(reach));
      setError(null);
    }
  }, [open, reach]);
  const narrows = reachNarrows(reach, draft);
  const noun = kind === "machine" ? "machine" : "Sandbox Environment";

  const submit = async () => {
    setError(null);
    try {
      const saved = await save({
        allowedWorkspaceIds:
          draft.workspaceIds === null
            ? null
            : draft.workspaceIds.filter((workspaceId) => workspaceId !== reach.homeWorkspaceId),
        allowPersonalWorkspaces: draft.personalWorkspaces,
      });
      toast.success(
        `${name} is available in ${organizationComputeReachSummary(saved).toLowerCase()}`,
      );
      onSaved?.(saved);
      return true;
    } catch (failure) {
      setError(failure);
      return false;
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Where can ${name} be used?`}
      description={`An organization ${noun} works in the workspaces you choose here.`}
      submitLabel="Save"
      pendingLabel="Saving…"
      onSubmit={submit}
      error={error ? userErrorText(error) : undefined}
    >
      <FieldStack>
        <WorkspaceReachFields
          owner={{ kind: "organization", name: organizationName }}
          organizationName={organizationName}
          managedBy="Organization owners and admins manage it."
          value={draft}
          onChange={setDraft}
          workspaces={organization.workspaces}
          workspacesError={organization.error}
          onRetryWorkspaces={organization.retry}
          hereId={hereId}
          alwaysIncluded={{ [reach.homeWorkspaceId]: HOME_REASON[kind] }}
          personalWorkspaces="choice"
        />
        {narrows ? (
          <Notice tone="info">
            Chats and schedules in the workspaces you take away stop using it from their next turn.
          </Notice>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}
