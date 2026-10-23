import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { OpenGeniApiError } from "@opengeni/sdk";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import type { AppContextValue } from "../app-context";
import type { SessionListRow } from "../../session-list-model";

type Confirmation = { title: string; description: string; confirmLabel: string };
type Confirm = (input: Confirmation) => Promise<boolean>;
const ArchiveConfirmationContext = createContext<Confirm>(async () => false);

/** One dialog for mouse, keyboard, header and command-menu archive actions. */
export function ArchiveConfirmationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const resolve = useRef<((confirmed: boolean) => void) | null>(null);
  const finish = useCallback((confirmed: boolean) => {
    resolve.current?.(confirmed);
    resolve.current = null;
    setPending(null);
  }, []);
  useEffect(
    () => () => {
      resolve.current?.(false);
    },
    [],
  );
  const confirm = useCallback<Confirm>((input) => {
    resolve.current?.(false);
    setPending(input);
    return new Promise((done) => {
      resolve.current = done;
    });
  }, []);
  return (
    <ArchiveConfirmationContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        title={pending?.title}
        description={pending?.description}
        confirmLabel={pending?.confirmLabel ?? "Pause and archive"}
        destructive={false}
        cancelAutoFocus
        onConfirm={() => finish(true)}
      />
    </ArchiveConfirmationContext.Provider>
  );
}

export const useArchiveConfirmation = () => useContext(ArchiveConfirmationContext);

export function canPauseArchivedChat(
  context: Pick<AppContextValue, "accessContext">,
  workspaceId: string,
): boolean {
  const grant = context.accessContext.workspaceGrants.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  return (
    !!grant &&
    (grant.permissions.includes("sessions:control") ||
      (grant.permissionMode !== "explicit" && grant.permissions.includes("workspace:admin")))
  );
}

export function archiveActionLabel(
  context: Pick<AppContextValue, "accessContext">,
  chat: Pick<SessionListRow, "archived" | "workspaceId">,
): string {
  return chat.archived
    ? "Restore"
    : canPauseArchivedChat(context, chat.workspaceId)
      ? "Archive"
      : "Hide for me";
}

export async function requestSessionArchive(
  context: AppContextValue,
  chat: Pick<SessionListRow, "id" | "workspaceId" | "archiveVersion">,
  archived: boolean,
  confirm: Confirm,
) {
  const accepted = context.captureWorkspaceInvocation(chat.workspaceId);
  if (!accepted) return null;
  const pause = canPauseArchivedChat(context, chat.workspaceId);
  if (
    archived &&
    !pause &&
    !(await confirm({
      title: "Hide this chat for you?",
      description:
        "You cannot pause this chat. Hiding it only removes it from your sidebar; its work and schedules can keep running.",
      confirmLabel: "Hide for me",
    }))
  )
    return null;
  const clientEventId = crypto.randomUUID();
  const request = (confirmPause = false) => {
    if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return Promise.resolve(null);
    return context.client.updateSessionArchive(chat.workspaceId, chat.id, {
      archived,
      clientEventId,
      expectedVersion: chat.archiveVersion ?? 0,
      // Restore never pauses or resumes, so it names no archive mode.
      ...(archived ? { mode: pause ? "pause_and_archive" : "hide_for_me", confirmPause } : {}),
    });
  };
  try {
    return await request();
  } catch (error) {
    if (
      !(error instanceof OpenGeniApiError) ||
      (error.details?.code ?? error.code) !== "session_archive_confirmation_required"
    )
      throw error;
    if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
    if (
      !(await confirm({
        title: "Pause and archive this chat?",
        description:
          "This chat has active work. Pause stops it and its sub-chats for everyone with access, and blocks schedules from starting work in them. Only your sidebar hides the chat. Restoring it will not resume it.",
        confirmLabel: "Pause and archive",
      }))
    )
      return null;
    return await request(true);
  }
}
