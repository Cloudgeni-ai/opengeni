import { useEffect, useState } from "react";
import { toast } from "sonner";

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
   "Available in" for something the organization owns: every shared workspace
   of the organization or the ones picked, and members' Personal workspaces
   when switched on. A thing that lives in one workspace (a machine, say)
   always works there, which `home` names with its reason. Agents in a
   workspace taken off the list stop using it from their next turn, so the
   dialog says so before saving.
   -------------------------------------------------------------------------- */

/** Where an organization thing works, in the API's words. */
export type OrganizationReach = {
  allowedWorkspaceIds: string[] | null;
  allowPersonalWorkspaces: boolean;
};

function reachDraft(reach: OrganizationReach): WorkspaceReach {
  return {
    workspaceIds: reach.allowedWorkspaceIds,
    personalWorkspaces: reach.allowPersonalWorkspaces,
  };
}

/** "All workspaces + Personal", "2 workspaces": the value of an Available in row. */
export function organizationReachSummary(reach: OrganizationReach, homeWorkspaceId?: string) {
  return workspaceReachSummary(reachDraft(reach), {
    owner: "organization",
    personalWorkspaces: "choice",
    alwaysIncluded: homeWorkspaceId ? [homeWorkspaceId] : [],
  });
}

/** Whether saving `next` takes it away from somewhere it works now. */
export function organizationReachNarrows(
  current: OrganizationReach,
  next: WorkspaceReach,
  homeWorkspaceId?: string,
): boolean {
  if (current.allowPersonalWorkspaces && !next.personalWorkspaces) return true;
  if (next.workspaceIds === null) return false;
  if (current.allowedWorkspaceIds === null) return true;
  const kept = new Set([...next.workspaceIds, ...(homeWorkspaceId ? [homeWorkspaceId] : [])]);
  return current.allowedWorkspaceIds.some((workspaceId) => !kept.has(workspaceId));
}

export function OrganizationReachDialog({
  open,
  onOpenChange,
  client,
  noun,
  name,
  reach,
  home,
  organizationId,
  organizationName,
  managedBy,
  hereId,
  save,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: OpenGeniBrowserClient;
  /** "Skill", "machine": what it is, for the dialog's description. */
  noun: string;
  name: string;
  reach: OrganizationReach;
  /** The workspace it lives in, which always has it, and why. */
  home?: { workspaceId: string; reason: string } | undefined;
  organizationId: string;
  organizationName: string;
  /** Who manages it, as a sentence: "Organization owners manage it." */
  managedBy: string;
  /** The workspace the page is open in. */
  hereId: string;
  save: (next: OrganizationReach) => Promise<OrganizationReach>;
  onSaved?: ((reach: OrganizationReach) => void) | undefined;
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
  const homeId = home?.workspaceId;
  const narrows = organizationReachNarrows(reach, draft, homeId);

  const submit = async () => {
    setError(null);
    try {
      const saved = await save({
        allowedWorkspaceIds:
          draft.workspaceIds === null
            ? null
            : draft.workspaceIds.filter((workspaceId) => workspaceId !== homeId),
        allowPersonalWorkspaces: draft.personalWorkspaces,
      });
      toast.success(
        `${name} is available in ${organizationReachSummary(saved, homeId).toLowerCase()}`,
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
          managedBy={managedBy}
          value={draft}
          onChange={setDraft}
          workspaces={organization.workspaces}
          workspacesError={organization.error}
          onRetryWorkspaces={organization.retry}
          hereId={hereId}
          alwaysIncluded={home ? { [home.workspaceId]: home.reason } : undefined}
          personalWorkspaces="choice"
        />
        {narrows ? (
          <Notice tone="info">
            Agents in the workspaces you take away stop using it from their next turn.
          </Notice>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}
