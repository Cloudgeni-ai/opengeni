/**
 * Archived chats in the session view. A chat is archived when someone with
 * control archives it, or when the deployment archives it after a long idle
 * period. Its content then moves to long-term storage: the conversation stays
 * readable, but the chat can no longer continue. Its work continues in a new
 * chat that links to it.
 *
 * - ReadOnlySessionNotice: the calm notice above an archived chat's timeline.
 * - KeepActiveSetting: the per-chat exemption, a switch in the Agent tab.
 */
import { ArchiveIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "../../lib/toast";

import { Button } from "../../../ui/button";
import { Notice } from "../../../ui/notice";
import { RelativeTime } from "../../../ui/relative-time";
import { SettingRow } from "../../../ui/setting-row";
import { Switch } from "../../../ui/switch";
import { useAppContext } from "../../app-context";
import { apiErrorFacts } from "../../../ui/api-error";
import { hasWorkspacePermission } from "../../lib/permissions";
import type { Session } from "../../types";

/**
 * The chat's archive state, or null while it is live. An archived chat whose
 * content is not stored yet is "archiving": it is already read-only.
 */
export function sessionReadOnlyArchive(
  session: Pick<Session, "retention" | "archived" | "archivedAt">,
): NonNullable<NonNullable<Session["retention"]>["archive"]> | null {
  if (session.retention?.archive) return session.retention.archive;
  return session.archived ? { state: "archiving", archivedAt: null } : null;
}

function idlePeriod(idleDays: number | undefined): string {
  if (!idleDays) return "a long time";
  return `${idleDays} ${idleDays === 1 ? "day" : "days"}`;
}

export function ReadOnlySessionNotice(props: {
  session: Session;
  /** Starts a new chat that continues this one's work. */
  onContinue: () => void;
}) {
  const archive = sessionReadOnlyArchive(props.session);
  if (!archive) return null;
  const moving = archive.state === "archiving";
  return (
    <Notice
      tone="muted"
      icon={<ArchiveIcon className="size-4" aria-hidden="true" />}
      title="This chat is archived"
      actionLayout="responsive"
      action={
        <Button
          type="button"
          size="sm"
          onClick={props.onContinue}
          className="shrink-0 pointer-coarse:h-11"
        >
          <SquarePenIcon aria-hidden="true" />
          Continue in a new chat
        </Button>
      }
    >
      <p data-read-only-session={archive.state} className="mt-0.5 text-fg-muted">
        {moving ? (
          <>It is moving to long-term storage.</>
        ) : archive.archivedAt ? (
          <>
            It moved to long-term storage <RelativeTime date={archive.archivedAt} inSentence />.
          </>
        ) : (
          <>It is in long-term storage.</>
        )}{" "}
        You can read the whole conversation, but not continue it here.
      </p>
    </Notice>
  );
}

/**
 * "Keep this chat active": exempts one chat from the idle-session archive, for
 * example a long-running agent that is only woken by schedules or messages.
 * Saves at once. Shown only on deployments that archive idle chats.
 */
export function KeepActiveSetting(props: {
  session: Session;
  idleDays: number;
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
  const keepLive = session.retention?.keepLive === true;
  const [pending, setPending] = useState<boolean | null>(null);
  // The saved value until the session the panel shows has caught up with it.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checked = pending ?? (saved !== null && saved !== keepLive ? saved : keepLive);
  useEffect(() => {
    if (saved !== null && saved === keepLive) setSaved(null);
  }, [keepLive, saved]);

  const save = async (next: boolean) => {
    setPending(next);
    setError(null);
    try {
      const updated = await context.client.updateSessionRetention(session.workspaceId, session.id, {
        keepLive: next,
      });
      setSaved(updated.retention?.keepLive === true);
      context.setSession((current) =>
        current?.id === updated.id && current.workspaceId === updated.workspaceId
          ? { ...current, retention: updated.retention }
          : current,
      );
      void props.onSaved?.().catch(() => undefined);
      toast.success(next ? "This chat will stay active." : "This chat can become read-only.");
    } catch (caught) {
      const facts = apiErrorFacts(caught);
      setError(
        facts.code === "SESSION_ARCHIVED_READ_ONLY" || facts.status === 409
          ? "This chat is already read-only, so it can't be kept active."
          : "Couldn't save. Try again.",
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingRow
      data-keep-active-setting
      // Sits directly under its section heading: drop the row's own top padding.
      className="-mt-3"
      label="Keep this chat active"
      description={`Chats with no activity for ${idlePeriod(props.idleDays)} are archived to long-term storage. Turn this on for a long-running agent you come back to.`}
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
