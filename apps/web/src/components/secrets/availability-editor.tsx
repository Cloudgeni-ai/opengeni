import type { VaultAvailability } from "@opengeni/react";

import { WorkspaceReachFields } from "@opengeni/react/app/components/workspace-reach";

/* ----------------------------------------------------------------------------
   "Available in" (S6): which workspaces can use a vault, with the shared
   control. An organization vault: all of the organization's workspaces (new
   ones too) or a selection, plus whether members' Personal workspaces may use
   it; organization owners and admins manage it. An Only-me vault: every
   workspace its owner uses or a selection; their Personal workspace always
   has it.
   -------------------------------------------------------------------------- */

export type AvailabilityWorkspace = { id: string; name: string };

export const DEFAULT_AVAILABILITY: VaultAvailability = {
  allowedWorkspaceIds: null,
  allowPersonalWorkspaces: true,
};

/** The Only-me default: the workspace it is added from, or only Personal from there. */
export function personalAvailabilityFrom(currentWorkspaceId: string | null): VaultAvailability {
  return {
    allowedWorkspaceIds: currentWorkspaceId ? [currentWorkspaceId] : [],
    allowPersonalWorkspaces: true,
  };
}

export function AvailabilityEditor({
  value,
  onChange,
  workspaces,
  organizationName,
  error,
  labelHidden = false,
  showOwner = true,
  personal = false,
}: {
  value: VaultAvailability;
  onChange: (value: VaultAvailability) => void;
  /** The organization's shared workspaces (for an Only-me vault, the owner's). */
  workspaces: AvailabilityWorkspace[];
  organizationName: string;
  error?: string | undefined;
  /** On the Available in page the title already says it; name the group for screen readers only. */
  labelHidden?: boolean;
  /** Off on New vault, where the owner is chosen right above. */
  showOwner?: boolean;
  /** An Only-me vault: always in its owner's Personal workspace, never in anyone else's. */
  personal?: boolean;
}) {
  return (
    <WorkspaceReachFields
      owner={personal ? { kind: "person" } : { kind: "organization", name: organizationName }}
      organizationName={organizationName}
      // Organization vaults need organization administration: the owner or an admin.
      {...(personal ? {} : { managedBy: "Organization owners and admins manage it." })}
      showOwner={showOwner}
      labelHidden={labelHidden}
      value={{
        workspaceIds: value.allowedWorkspaceIds,
        personalWorkspaces: value.allowPersonalWorkspaces,
      }}
      onChange={(next) =>
        onChange({
          allowedWorkspaceIds: next.workspaceIds === null ? null : [...next.workspaceIds],
          allowPersonalWorkspaces: personal ? true : next.personalWorkspaces,
        })
      }
      workspaces={[...workspaces].sort((a, b) => a.name.localeCompare(b.name))}
      personalWorkspaces={personal ? "always" : "choice"}
      error={error}
    />
  );
}
