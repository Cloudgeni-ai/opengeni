import { useEffect, useState } from "react";
import type { ChatClient } from "@opengeni/sdk";
import { toast } from "sonner";

import type { OrganizationComputeReach } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  WorkspaceReachFields,
  workspaceReachSummary,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";
import { CheckboxField, FieldStack } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { Notice } from "@opengeni/react/ui/notice";
import { userErrorText } from "@opengeni/react/ui/api-error";

import { useOrganizationWorkspaces } from "@/components/models/connect-audience";

/* ----------------------------------------------------------------------------
   "Available in" for an organization machine or Sandbox Environment: every
   shared workspace of the organization or the ones picked, and members'
   Personal workspaces when switched on. The workspace it was connected from
   or made in always has it, because that is where it lives. "All
   product-managed workspaces" adds every workspace the organization's product
   manages, including ones it creates later (shown when the server reports the
   setting). The organization owner or an admin decides this. Chats and schedules in a workspace taken off
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

/**
 * "All workspaces + Personal", "2 workspaces + Product-managed": the row value
 * on the detail page.
 */
export function organizationComputeReachSummary(reach: OrganizationComputeReach): string {
  const summary = workspaceReachSummary(reachDraft(reach), {
    owner: "organization",
    personalWorkspaces: "choice",
    alwaysIncluded: [reach.homeWorkspaceId],
  });
  return reach.allowManagedWorkspaces ? `${summary} + Product-managed` : summary;
}

/** Whether saving `next` takes it away from somewhere it works now. */
export function reachNarrows(
  current: OrganizationComputeReach,
  next: WorkspaceReach,
  nextManaged: boolean = current.allowManagedWorkspaces ?? false,
): boolean {
  if (current.allowPersonalWorkspaces && !next.personalWorkspaces) return true;
  if (current.allowManagedWorkspaces && !nextManaged) return true;
  if (next.workspaceIds === null) return false;
  if (current.allowedWorkspaceIds === null) return true;
  const kept = new Set([...next.workspaceIds, current.homeWorkspaceId]);
  return current.allowedWorkspaceIds.some((workspaceId) => !kept.has(workspaceId));
}

/**
 * The managed-workspaces switch: a machine is one computer every end
 * customer's chats share, and the Console test workspace is a managed one.
 */
export const MANAGED_DESCRIPTION = {
  machine:
    "Every workspace your product manages, including new ones and the Console test workspace, where Editors run test chats. All end customers' chats there share this machine.",
  rig: "Every workspace your product manages, including new ones.",
} as const;

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
  client: ChatClient<OpenGeniBrowserClient>;
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
    allowManagedWorkspaces?: boolean;
  }) => Promise<OrganizationComputeReach>;
  onSaved?: ((reach: OrganizationComputeReach) => void) | undefined;
}) {
  const [draft, setDraft] = useState<WorkspaceReach>(() => reachDraft(reach));
  // A current server always reports the setting. Only a server before
  // migration 1512 omits it (this response isn't parsed against the contract),
  // and then the switch stays hidden so a save never sends a field it refuses.
  const managedSupported = reach.allowManagedWorkspaces !== undefined;
  const [managed, setManaged] = useState(reach.allowManagedWorkspaces ?? false);
  const [error, setError] = useState<unknown>(null);
  const organization = useOrganizationWorkspaces(client, organizationId, open);
  useEffect(() => {
    if (open) {
      setDraft(reachDraft(reach));
      setManaged(reach.allowManagedWorkspaces ?? false);
      setError(null);
    }
  }, [open, reach]);
  const narrows = reachNarrows(reach, draft, managed);
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
        ...(managedSupported ? { allowManagedWorkspaces: managed } : {}),
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
        {managedSupported ? (
          <CheckboxField
            label="All product-managed workspaces"
            description={MANAGED_DESCRIPTION[kind]}
            checked={managed}
            onCheckedChange={setManaged}
          />
        ) : null}
        {narrows ? (
          <Notice tone="info">
            Chats and schedules in the workspaces you take away stop using it from their next turn.
          </Notice>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}
