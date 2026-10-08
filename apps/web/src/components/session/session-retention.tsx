/**
 * Idle-session archive in the session view. A deployment may move chats that
 * have had no activity for a while into long-term storage: the conversation
 * stays readable, but the chat can no longer continue. This is separate from
 * the personal "Archive" action, which only hides a chat from your own list.
 *
 * - ReadOnlySessionNotice: the calm notice above a read-only chat's timeline.
 * - KeepActiveSetting: the per-chat exemption, a switch in the Agent tab.
 */
import { ArchiveIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";
import { apiErrorFacts } from "@/lib/api-error";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { Session } from "@/types";

/** The chat's long-term storage state, or null while it is live. */
export function sessionReadOnlyArchive(
  session: Pick<Session, "retention">,
): NonNullable<NonNullable<Session["retention"]>["archive"]> | null {
  return session.retention?.archive ?? null;
}

function idlePeriod(idleDays: number | undefined): string {
  if (!idleDays) return "a long time";
  return `${idleDays} ${idleDays === 1 ? "day" : "days"}`;
}

export function ReadOnlySessionNotice(props: {
  session: Session;
  /** The deployment's idle period, when it still archives chats. */
  idleDays?: number | undefined;
  onNewSession: () => void;
}) {
  const archive = sessionReadOnlyArchive(props.session);
  if (!archive) return null;
  const moving = archive.state === "archiving";
  return (
    <Notice
      tone="muted"
      icon={<ArchiveIcon className="size-4" aria-hidden="true" />}
      title="This chat is read-only"
      actionLayout="responsive"
      action={
        <Button
          type="button"
          size="sm"
          onClick={props.onNewSession}
          className="shrink-0 pointer-coarse:h-11"
        >
          <PlusIcon aria-hidden="true" />
          New chat
        </Button>
      }
    >
      <p data-read-only-session={archive.state} className="mt-0.5 text-fg-muted">
        {moving ? (
          <>
            It had no activity for {idlePeriod(props.idleDays)} and is moving to long-term storage.
          </>
        ) : archive.archivedAt ? (
          <>
            It moved to long-term storage <RelativeTime date={archive.archivedAt} inSentence />{" "}
            after {idlePeriod(props.idleDays)} without activity.
          </>
        ) : (
          <>It moved to long-term storage after {idlePeriod(props.idleDays)} without activity.</>
        )}{" "}
        You can read the whole conversation, but not continue it.
      </p>
    </Notice>
  );
}

/**
 * "Keep this chat active": exempts one chat from the idle-session archive, for
 * example a long-running agent that is only woken by schedules or messages.
 * Saves at once. Shown only on deployments that archive idle chats.
 */
export function KeepActiveSetting(props: { session: Session; idleDays: number }) {
  const context = useAppContext();
  const { session } = props;
  const canEdit = hasWorkspacePermission(
    context.accessContext,
    session.workspaceId,
    "sessions:control",
  );
  const keepLive = session.retention?.keepLive === true;
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checked = pending ?? keepLive;

  const save = async (next: boolean) => {
    setPending(next);
    setError(null);
    try {
      const updated = await context.client.updateSessionRetention(session.workspaceId, session.id, {
        keepLive: next,
      });
      context.setSession((current) =>
        current?.id === updated.id && current.workspaceId === updated.workspaceId
          ? { ...current, retention: updated.retention }
          : current,
      );
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
      label="Keep this chat active"
      description={`Chats with no activity for ${idlePeriod(props.idleDays)} become read-only and move to long-term storage. Turn this on for a long-running agent you come back to.`}
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
