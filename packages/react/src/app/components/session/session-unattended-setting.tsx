import { useEffect, useState } from "react";
import { toast } from "../../lib/toast";

import { SettingRow } from "../../../ui/setting-row";
import { Switch } from "../../../ui/switch";
import { useAppContext } from "../../app-context";
import { apiErrorFacts } from "../../../ui/api-error";
import { hasWorkspacePermission } from "../../lib/permissions";
import type { Session } from "../../types";

/**
 * "Work without me": this chat's unattended mode. On, the agent is told no one
 * will answer until the task ends, so it doesn't ask or wait for approvals.
 * Applies from the next turn; the switch is the chat's own choice.
 */
export function UnattendedSetting(props: {
  session: Session;
  /** Re-reads the session after a save so every view shows the new value. */
  onSaved?: (() => Promise<void>) | undefined;
}) {
  const context = useAppContext();
  const { session } = props;
  const canEdit = hasWorkspacePermission(
    context.accessContext,
    session.workspaceId,
    "sessions:control",
  );
  const unattended = session.unattended === true;
  const [pending, setPending] = useState<boolean | null>(null);
  // The saved value until the session the panel shows has caught up with it.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checked = pending ?? (saved !== null && saved !== unattended ? saved : unattended);
  useEffect(() => {
    if (saved !== null && saved === unattended) setSaved(null);
  }, [unattended, saved]);

  const save = async (next: boolean) => {
    setPending(next);
    setError(null);
    try {
      const updated = await context.client.updateSessionUnattended(
        session.workspaceId,
        session.id,
        { unattended: next },
      );
      setSaved(updated.unattended === true);
      context.setSession((current) =>
        current?.id === updated.id && current.workspaceId === updated.workspaceId
          ? { ...current, unattended: updated.unattended }
          : current,
      );
      void props.onSaved?.().catch(() => undefined);
      toast.success(next ? "The agent will work without you." : "The agent can ask you again.");
    } catch (caught) {
      const facts = apiErrorFacts(caught);
      setError(
        facts.code === "SESSION_ARCHIVED_READ_ONLY" || facts.status === 409
          ? "This chat is read-only, so this can't change."
          : "Couldn't save. Try again.",
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingRow
      data-unattended-setting
      // Sits directly under its section heading: drop the row's own top padding.
      className="-mt-3"
      label="Work without me"
      description="The agent won't stop to ask you or wait for approvals. It finishes what it can and lists what's left for you."
      error={error}
      control={
        <Switch
          checked={checked}
          pending={pending !== null}
          disabled={!canEdit}
          disabledReason={
            canEdit ? undefined : "Changing this needs permission to run this session."
          }
          onCheckedChange={(next) => void save(next)}
        />
      }
    />
  );
}
