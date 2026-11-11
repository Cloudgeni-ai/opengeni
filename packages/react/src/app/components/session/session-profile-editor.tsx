import { useOptionalAppContext, type AppContextValue } from "../../app-context";
import { sessionDisplayTitle } from "../../lib/session-rename";
import type { SessionListRow } from "../../../session-list-model";
import type { UpdateSessionRequest } from "@opengeni/sdk";
import { SessionProfileDialog } from "./session-profile-dialog";

/** A full chat (header) or a sidebar row: both carry the profile fields. */
type ProfileSession = SessionListRow;

/** Saves a chat's profile change (the app's `updateSessionProfile`). */
export type UpdateSessionProfileFn = NonNullable<AppContextValue["updateSessionProfile"]>;

/** Whether this host can save a chat's profile (it predates bots otherwise). */
export function useCanEditSessionProfile(): boolean {
  return Boolean(useOptionalAppContext()?.updateSessionProfile);
}

/** The profile dialog for one chat, saving only what changed. */
export function SessionProfileEditorDialog({
  session,
  update,
  open,
  onOpenChange,
}: {
  session: ProfileSession;
  update: UpdateSessionProfileFn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const display = sessionDisplayTitle(session);
  const description = session.description ?? "";
  const avatar = session.avatar ?? null;
  return (
    <SessionProfileDialog
      open={open}
      onOpenChange={onOpenChange}
      workspaceId={session.workspaceId}
      seed={session.id}
      initial={{ title: display, description, avatar }}
      onSubmit={async (values) => {
        const change: UpdateSessionRequest = {};
        if (values.title !== display) change.title = values.title;
        if (values.description !== description) change.description = values.description || null;
        if (JSON.stringify(values.avatar) !== JSON.stringify(avatar)) change.avatar = values.avatar;
        if (Object.keys(change).length === 0) return;
        await update(session.workspaceId, session.id, change);
      }}
    />
  );
}
