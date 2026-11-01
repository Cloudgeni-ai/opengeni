import { useEffect, useState } from "react";

import { FormDialog } from "../../../ui/form-dialog";
import { userErrorText } from "../../../ui/api-error";
import { WorkspaceReachFields, type ReachWorkspace, type WorkspaceReach } from "../workspace-reach";

/**
 * Where the owner's own Only me file works: the workspace that stores it and
 * their Personal workspace always, plus the ones they pick, or all of their
 * workspaces in the organization. It stays Only me in each: only they, and
 * agent turns they start, can use it there.
 */
export function FileReachDialog({
  open,
  onOpenChange,
  title,
  homeWorkspaceId,
  reachWorkspaceIds,
  workspaces,
  organizationName,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The file's name. */
  title: string;
  /** The workspace that stores the file, where this page is. */
  homeWorkspaceId: string;
  /** Its other workspaces now; null for all of them. */
  reachWorkspaceIds: readonly string[] | null;
  /** The owner's workspaces in this organization, their Personal workspace marked. */
  workspaces: readonly ReachWorkspace[];
  organizationName: string;
  /** Saves the other workspaces it works in, or null for all; throws when refused. */
  onSave: (reachWorkspaceIds: string[] | null) => Promise<void>;
}) {
  const savedKey = reachWorkspaceIds === null ? null : [...reachWorkspaceIds].sort().join(",");
  const [value, setValue] = useState<WorkspaceReach>({
    workspaceIds: reachWorkspaceIds,
    personalWorkspaces: true,
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue({
        workspaceIds: savedKey === null ? null : savedKey.split(",").filter(Boolean),
        personalWorkspaces: true,
      });
      setError(null);
    }
  }, [open, savedKey]);
  const chosen =
    value.workspaceIds === null
      ? null
      : value.workspaceIds.filter((id) => id !== homeWorkspaceId).sort();
  const unchanged = chosen === null ? savedKey === null : savedKey === chosen.join(",");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Available in"
      description={`“${title}” stays Only me: in each of these workspaces, only you and agent turns you start can use it.`}
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={unchanged}
      error={error}
      onSubmit={async () => {
        try {
          await onSave(chosen);
        } catch (cause) {
          setError(userErrorText(cause, "Couldn't change where this file works."));
          return false;
        }
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <WorkspaceReachFields
        owner={{ kind: "person" }}
        organizationName={organizationName}
        label="Available in"
        labelHidden
        value={value}
        onChange={setValue}
        workspaces={workspaces}
        hereId={homeWorkspaceId}
        alwaysIncluded={{ [homeWorkspaceId]: "It's stored here, so it's always included." }}
        personalWorkspaces="always"
      />
    </FormDialog>
  );
}
